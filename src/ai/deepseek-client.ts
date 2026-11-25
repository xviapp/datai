import { getAiPreferences, getDeepSeekApiKey, type ReasoningEffort } from './settings-store';

export { parseAndValidateAiJson } from './schemas';

export type ChatContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' };
    };

export interface ToolCallItem {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentBlock[] | null;
  reasoning_content?: string;
  tool_calls?: ToolCallItem[];
  tool_call_id?: string;
}

export interface FunctionToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type ServerToolDef =
  | { type: 'deepseek_web_search' }
  | { type: 'deepseek_read_url' };

export interface ChatRequestOptions {
  messages: DeepSeekChatMessage[];
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  jsonMode?: boolean;
  tools?: Array<FunctionToolDef | ServerToolDef>;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ChatCompletionChoiceMessage {
  role: 'assistant';
  content: string | null;
  reasoning_content?: string;
  tool_calls?: ToolCallItem[];
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string };
  return e.name === 'AbortError';
}

function createRequestAbortHandle(externalSignal?: AbortSignal, timeoutMs = 60_000) {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort(externalSignal?.reason);
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (externalSignal) {
        externalSignal.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

async function resolveAuthAndEndpoint() {
  const apiKey = await getDeepSeekApiKey();
  if (!apiKey) {
    throw new Error('请先在「设置」页面填入你的 DeepSeek API Key');
  }
  const prefs = await getAiPreferences();
  const baseUrl = prefs.baseUrl.replace(/\/+$/, '');
  return { apiKey, baseUrl, model: prefs.model || 'deepseek-flash', prefs };
}

/**
 * 调用 DeepSeek V4.1 (deepseek-flash) Chat Completions 接口，支持外部 AbortSignal 与超时保护
 */
export async function callDeepSeekChat(options: ChatRequestOptions): Promise<{
  message: ChatCompletionChoiceMessage;
  usage?: DeepSeekUsage;
}> {
  const { apiKey, baseUrl, model } = await resolveAuthAndEndpoint();

  const body: Record<string, unknown> = {
    model,
    messages: options.messages,
    thinking: {
      type: options.thinking ? 'enabled' : 'disabled',
    },
  };

  if (options.thinking && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
  }

  if (options.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools;
  }

  if (options.maxTokens) {
    body.max_tokens = options.maxTokens;
  }

  const timeoutMs = options.timeoutMs ?? (options.thinking ? 90_000 : 45_000);
  const abortHandle = createRequestAbortHandle(options.signal, timeoutMs);

  let res: Response;
  let text: string;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: abortHandle.signal,
    });
    text = await res.text();
  } catch (err) {
    if (abortHandle.didTimeout()) {
      throw new Error('请求超时，请检查网络或稍后重试');
    }
    throw err;
  } finally {
    abortHandle.cleanup();
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`DeepSeek 响应解析失败 (HTTP ${res.status}): ${text.slice(0, 180)}`);
  }

  if (!res.ok || json.error) {
    const errObj = json.error as { message?: string } | undefined;
    throw new Error(errObj?.message || `DeepSeek 请求失败 (HTTP ${res.status})`);
  }

  const choices = json.choices as Array<{ message: ChatCompletionChoiceMessage }> | undefined;
  const msg = choices?.[0]?.message;
  if (!msg) {
    throw new Error('DeepSeek 未返回有效消息内容');
  }

  return {
    message: msg,
    usage: json.usage as DeepSeekUsage | undefined,
  };
}

/**
 * 严格遵循 DeepSeek V4.1 思考模式规范的多轮工具调用循环：
 * 每一子轮都完整保留并回传 assistant.reasoning_content，避免 HTTP 400 错误
 */
export async function runDeepSeekToolLoop(params: {
  initialMessages: DeepSeekChatMessage[];
  tools: FunctionToolDef[];
  reasoningEffort?: ReasoningEffort;
  maxIterations?: number;
  signal?: AbortSignal;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string> | string;
  onProgress?: (statusText: string) => void;
}): Promise<{ finalContent: string; lastReasoning: string }> {
  const messages: DeepSeekChatMessage[] = [...params.initialMessages];
  const maxIter = params.maxIterations ?? 5;
  let lastReasoning = '';

  for (let step = 0; step < maxIter; step++) {
    const { message } = await callDeepSeekChat({
      messages,
      thinking: true,
      reasoningEffort: params.reasoningEffort ?? 'high',
      tools: params.tools,
      signal: params.signal,
    });

    if (message.reasoning_content) {
      lastReasoning = message.reasoning_content;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? '',
      reasoning_content: message.reasoning_content ?? '',
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    });

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return {
        finalContent: message.content ?? '',
        lastReasoning,
      };
    }

    for (const tc of message.tool_calls) {
      if (params.signal?.aborted) {
        const abortErr = new Error('已取消请求');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      params.onProgress?.('正在统计本地数据...');
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(tc.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }
      const toolOutput = await params.executeTool(tc.function.name, parsedArgs);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: toolOutput,
      });
    }
  }

  throw new Error('AI 工具推理轮次超出上限，请简化问题后重试');
}

/**
 * 利用 DeepSeek 服务端联网/读链接工具预提取网页或实体背景资料
 * 注意：deepseek_web_search / deepseek_read_url 不可与自定义 function tools 或 json_object 同请求混用
 */
export async function enrichTextWithDeepSeekWeb(
  userText: string,
  allowSearch: boolean,
  signal?: AbortSignal
): Promise<string | null> {
  const hasUrl = /https?:\/\/[^\s]+/i.test(userText);
  if (!hasUrl && !allowSearch) return null;

  const tools: ServerToolDef[] = [{ type: 'deepseek_read_url' }];
  if (allowSearch) {
    tools.push({ type: 'deepseek_web_search' });
  }

  try {
    const { message } = await callDeepSeekChat({
      thinking: false,
      tools,
      signal,
      timeoutMs: 35_000,
      messages: [
        {
          role: 'system',
          content:
            '你是信息提取助手。请读取用户提供的链接或联网检索相关图书/影视/商品/药品的关键客观属性（名称、作者/品牌、价格、规格、年份、简介），用紧凑要点列出事实。',
        },
        { role: 'user', content: userText },
      ],
    });
    return message.content?.trim() || null;
  } catch (err) {
    if (isAbortError(err) && signal?.aborted) {
      throw err;
    }
    // 联网补充失败时优雅降级，不阻塞本地录入
    return null;
  }
}

function inferAudioMeta(uri: string, fallbackName: string): { name: string; mime: string } {
  const clean = uri.split('?')[0].toLowerCase();
  if (clean.endsWith('.wav')) return { name: 'speech.wav', mime: 'audio/wav' };
  if (clean.endsWith('.ogg') || clean.endsWith('.opus')) {
    return { name: 'speech.ogg', mime: 'audio/ogg' };
  }
  if (clean.endsWith('.m4a') || clean.endsWith('.mp4')) {
    return { name: 'speech.m4a', mime: 'audio/mp4' };
  }
  if (clean.endsWith('.webm')) return { name: 'speech.webm', mime: 'audio/webm' };
  if (clean.endsWith('.mp3')) return { name: 'speech.mp3', mime: 'audio/mpeg' };
  return { name: fallbackName, mime: 'audio/wav' };
}

/**
 * 调用 DeepSeek 官方语音识别接口 POST /v1/tools/asr
 */
export async function transcribeAudioWithDeepSeek(
  audioUriOrBlob: string | Blob,
  filename = 'speech.wav',
  signal?: AbortSignal
): Promise<string> {
  const { apiKey, baseUrl } = await resolveAuthAndEndpoint();
  const formData = new FormData();

  if (typeof audioUriOrBlob === 'string') {
    const { name, mime } = inferAudioMeta(audioUriOrBlob, filename);
    const { File } = await import('expo-file-system');
    const localFile = new File(audioUriOrBlob);
    const audioBytes = await localFile.bytes();
    formData.append('file', {
      name,
      type: mime,
      bytes: async () => audioBytes,
    } as unknown as Blob);
  } else {
    formData.append('file', audioUriOrBlob, filename);
  }

  const abortHandle = createRequestAbortHandle(signal, 45_000);
  let res: Response;
  let rawText: string;
  try {
    res = await fetch(`${baseUrl}/v1/tools/asr`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: abortHandle.signal,
    });
    rawText = await res.text();
  } catch (err) {
    if (abortHandle.didTimeout()) {
      throw new Error('语音转写超时，请稍后重试');
    }
    throw err;
  } finally {
    abortHandle.cleanup();
  }

  let json: { text?: string; error?: { message?: string } } = {};
  try {
    json = JSON.parse(rawText) as { text?: string; error?: { message?: string } };
  } catch {
    throw new Error(`语音识别响应异常 (HTTP ${res.status}): ${rawText.slice(0, 140)}`);
  }

  if (!res.ok || !json.text) {
    throw new Error(json.error?.message || `语音转写失败 (HTTP ${res.status})`);
  }
  return json.text.trim();
}
