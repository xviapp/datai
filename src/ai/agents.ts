import type { OmniRepository } from '@/db/repository';
import { formatLocalDate } from '@/engine/date';
import {
  callDeepSeekChat,
  enrichTextWithDeepSeekWeb,
  parseAndValidateAiJson,
  runDeepSeekToolLoop,
  type ChatContentBlock,
} from './deepseek-client';
import {
  buildAnalystSystemPrompt,
  buildArchitectSystemPrompt,
  buildDatabaseCatalogPrompt,
  buildOmniCaptureSystemPrompt,
  INTENT_ROUTER_SYSTEM_PROMPT,
} from './prompts';
import {
  AnalystAnswerSchema,
  ArchitectPlanSchema,
  getAnalystJsonSchema,
  getArchitectJsonSchema,
  getOmniCaptureJsonSchema,
  IntentRouterSchema,
  OmniCaptureResultSchema,
  type AnalystAnswer,
  type ArchitectPlan,
  type OmniCaptureResult,
} from './schemas';
import { getAiPreferences } from './settings-store';

export type AssistantIntent = 'architect' | 'analyst' | 'capture';
export type AssistantScene = 'home' | 'stats' | 'library' | 'entry';
export type AssistantMode = 'auto' | AssistantIntent;

export interface CaptureEntryContext {
  entryId: string;
  title: string;
  librarySlug: string;
  libraryName: string;
  libraryIcon: string;
  activeTab?: string;
  activeChildSlug?: string;
  activeChildName?: string;
}

export type UnifiedAssistantResult =
  | { intent: 'architect'; plan: ArchitectPlan }
  | { intent: 'analyst'; answer: AnalystAnswer }
  | { intent: 'capture'; capture: OmniCaptureResult };

const SCENE_LABELS: Record<AssistantScene, string> = {
  home: '首页全局总入口',
  stats: '统计分析看板',
  library: '记录本列表工作台',
  entry: '单条记录详情页',
};

/**
 * 自动识别用户输入意图：定制/修改记录本（architect）、统计/查数据/画图（analyst）、还是记录一条具体事件（capture）
 */
export async function detectAssistantIntent(
  repo: OmniRepository,
  userPrompt: string,
  context?: {
    scene?: AssistantScene;
    targetLibrarySlug?: string;
    entryContext?: CaptureEntryContext;
    signal?: AbortSignal;
  }
): Promise<AssistantIntent> {
  const allLibs = repo.listLibraries();
  const libNames = allLibs.map((l) => `${l.name}(${l.slug})`).join('、');

  const contextLines: string[] = [];
  if (context?.scene) {
    contextLines.push(`当前所在页面：${SCENE_LABELS[context.scene]}`);
  }
  if (context?.entryContext) {
    const tabHint = context.entryContext.activeChildName
      ? `（正在看附属「${context.entryContext.activeChildName}」标签页）`
      : context.entryContext.activeTab === 'backlinks'
        ? '（正在看「关联记录」标签页）'
        : '';
    contextLines.push(
      `当前所在详情页：${context.entryContext.libraryName}「${context.entryContext.title}」${tabHint}`
    );
  } else if (context?.targetLibrarySlug) {
    const targetLib = allLibs.find((l) => l.slug === context.targetLibrarySlug);
    if (targetLib) {
      contextLines.push(`当前所在记录本：${targetLib.name}(${targetLib.slug})`);
    }
  }

  const ctxBlock = contextLines.length > 0 ? `\n${contextLines.join('\n')}` : '';

  const { message } = await callDeepSeekChat({
    thinking: false,
    jsonMode: true,
    maxTokens: 64,
    signal: context?.signal,
    messages: [
      { role: 'system', content: INTENT_ROUTER_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `当前已有记录本：${libNames || '无'}${ctxBlock}\n用户输入：${userPrompt}`,
      },
    ],
  });

  const parsed = parseAndValidateAiJson(message.content ?? '{}', IntentRouterSchema);
  return parsed.intent;
}

/**
 * 统一智能助手入口：支持文字 / 语音转写 / 图片 / 联网 / AbortSignal，结合当前页面场景自动识别意图
 */
export async function runUnifiedAssistant(
  repo: OmniRepository,
  params: {
    text: string;
    imageBase64DataUrl?: string;
    useWebSearch?: boolean;
    scene?: AssistantScene;
    targetLibrarySlug?: string;
    entryContext?: CaptureEntryContext;
    signal?: AbortSignal;
  },
  onProgress?: (msg: string) => void,
  forceIntent?: AssistantIntent
): Promise<UnifiedAssistantResult> {
  const cleanText = params.text.trim();
  let intent = forceIntent;

  if (!intent) {
    if (params.imageBase64DataUrl && !cleanText) {
      intent = 'capture';
    } else if (params.scene === 'stats') {
      intent = 'analyst';
    } else {
      onProgress?.('正在理解你的想法...');
      intent = await detectAssistantIntent(repo, cleanText, {
        scene: params.scene,
        targetLibrarySlug: params.targetLibrarySlug,
        entryContext: params.entryContext,
        signal: params.signal,
      });
    }
  }

  if (intent === 'architect') {
    onProgress?.('正在构思记录本结构与样式...');
    const plan = await runArchitectAgent(repo, cleanText, onProgress, {
      targetLibrarySlug: params.targetLibrarySlug,
      signal: params.signal,
    });
    return { intent: 'architect', plan };
  }

  if (intent === 'capture') {
    onProgress?.('正在整理记录草稿...');
    const capture = await runOmniCaptureAgent(repo, params, onProgress);
    return { intent: 'capture', capture };
  }

  onProgress?.('正在核对你的本地记录...');
  const answer = await runAnalystAgent(repo, cleanText, onProgress, {
    targetLibrarySlug: params.targetLibrarySlug,
    entryContext: params.entryContext,
    signal: params.signal,
  });
  return { intent: 'analyst', answer };
}

/**
 * 1. AI 建筑师（Architect Agent）
 */
export async function runArchitectAgent(
  repo: OmniRepository,
  userPrompt: string,
  onProgress?: (msg: string) => void,
  context?: { targetLibrarySlug?: string; signal?: AbortSignal }
): Promise<ArchitectPlan> {
  const prefs = await getAiPreferences();
  onProgress?.('正在构思记录本结构与样式...');

  const allLibs = repo.listLibraries();
  const existingLibs = allLibs.map((l) => ({
    slug: l.slug,
    name: l.name,
    description: l.description,
    icon: l.icon,
    color: l.color,
    parentLibrarySlug: l.parentLibrarySlug ?? undefined,
    showOnHome: l.showOnHome,
    fields: l.fields,
    viewList: l.viewList.map((v) => ({ name: v.name, viewType: v.viewType })),
    views: l.views,
  }));
  const existingRelations = repo.listLibraryRelations().map((r) => ({
    sourceLibrarySlug: r.sourceLibrarySlug,
    targetLibrarySlug: r.targetLibrarySlug,
    fieldKey: r.fieldKey,
    relationKind: r.relationKind,
    allowMultiple: r.allowMultiple,
  }));

  const schemaSpec = JSON.stringify(getArchitectJsonSchema());
  const systemPrompt = buildArchitectSystemPrompt(schemaSpec);

  const focusLib = context?.targetLibrarySlug
    ? allLibs.find((l) => l.slug === context.targetLibrarySlug)
    : undefined;
  const focusBlock = focusLib
    ? `\n\n[当前所在记录本]：用户正停留在「${focusLib.icon} ${focusLib.name}」(slug: "${focusLib.slug}")，当前启用视图：${focusLib.viewList.map((v) => `${v.name}(${v.viewType})`).join(' / ')}。若用户未明确指定其他记录本（例如说“新增字段/加公式/改视图/关掉日历/加画廊/建附属表”），请默认围绕 "${focusLib.slug}" 进行增量演进并完整保留其原有字段。`
    : '';

  const relBlock =
    existingRelations.length > 0
      ? `\n\n当前表间关系（library_relations）：\n${JSON.stringify(existingRelations)}`
      : '';

  const userMessage = `当前已有库结构与视图 JSON：\n${JSON.stringify(existingLibs)}${relBlock}${focusBlock}\n\n用户的建模/视图修改需求：\n${userPrompt}`;

  const { message } = await callDeepSeekChat({
    thinking: true,
    reasoningEffort: prefs.architectEffort,
    jsonMode: true,
    signal: context?.signal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return parseAndValidateAiJson(message.content ?? '{}', ArchitectPlanSchema);
}

/**
 * 2. AI 全局万能快记（Omni-Capture Agent）
 */
export async function runOmniCaptureAgent(
  repo: OmniRepository,
  params: {
    text: string;
    imageBase64DataUrl?: string;
    useWebSearch?: boolean;
    scene?: AssistantScene;
    targetLibrarySlug?: string;
    entryContext?: CaptureEntryContext;
    signal?: AbortSignal;
  },
  onProgress?: (msg: string) => void
): Promise<OmniCaptureResult> {
  const prefs = await getAiPreferences();
  const todayStr = formatLocalDate();

  let webContext = '';
  const shouldEnrich =
    Boolean(params.useWebSearch && prefs.enableWebEnrich) || /https?:\/\/[^\s]+/i.test(params.text);

  if (shouldEnrich && params.text.trim()) {
    onProgress?.('正在联网补充相关信息...');
    const enriched = await enrichTextWithDeepSeekWeb(
      params.text,
      Boolean(params.useWebSearch),
      params.signal
    );
    if (enriched) {
      webContext = `\n\n[联网/网页链接补充事实]：\n${enriched}`;
    }
  }

  onProgress?.('正在整理内容并归类...');

  const catalog = buildDatabaseCatalogPrompt(repo.getLibraryCatalogItems(true));
  const schemaSpec = JSON.stringify(getOmniCaptureJsonSchema());
  const systemPrompt = buildOmniCaptureSystemPrompt(schemaSpec);

  let contextBlock = '';
  if (params.entryContext) {
    const allLibs = repo.listLibraries();
    const childLibs = repo.listChildLibraries(params.entryContext.librarySlug);
    const childSlugs = new Set(childLibs.map((c) => c.slug));
    const reverseRelLibs = allLibs.filter(
      (l) =>
        !childSlugs.has(l.slug) &&
        l.fields.some(
          (f) =>
            f.type === 'relation' &&
            f.relationConfig?.targetLibrarySlug === params.entryContext!.librarySlug
        )
    );

    const activeChildHint = params.entryContext.activeChildSlug
      ? `用户当前正停留在附属子库「${params.entryContext.activeChildName ?? params.entryContext.activeChildSlug}」(slug: "${params.entryContext.activeChildSlug}") 标签页，请优先归入 "${params.entryContext.activeChildSlug}" 并在对应关联字段自动填入 ["${params.entryContext.entryId}"]！\n`
      : '';
    const childHint =
      childLibs.length > 0
        ? `该记录所属主库的附属子库有：${childLibs
            .map((c) => `${c.icon} ${c.name}(slug: "${c.slug}")`)
            .join('、')}。若用户输入是在记录该主体的进度打卡、书摘笔记或附属流水，请优先归入对应附属子库，并在关联字段自动填入 ["${params.entryContext.entryId}"]！\n`
        : '';
    const reverseHint =
      reverseRelLibs.length > 0
        ? `以下记录本可通过关联字段指向当前主库：${reverseRelLibs
            .map((r) => {
              const rf = r.fields.find(
                (f) =>
                  f.type === 'relation' &&
                  f.relationConfig?.targetLibrarySlug === params.entryContext!.librarySlug
              );
              return `${r.icon} ${r.name}(slug: "${r.slug}", 关联字段: "${rf?.key ?? ''}")`;
            })
            .join('、')}。若用户输入属于这些关联流水（如配件账单、服药打卡等），请自动在对应关联字段填入 ["${params.entryContext.entryId}"]！\n`
        : '';
    contextBlock = `[当前详情页绑定记录]：用户正停留在「${params.entryContext.libraryIcon} ${params.entryContext.libraryName}」(slug: ${params.entryContext.librarySlug}) 的记录「${params.entryContext.title}」(ID: "${params.entryContext.entryId}")。\n${activeChildHint}${childHint}${reverseHint}`;
  } else if (params.targetLibrarySlug) {
    const targetLib = repo.getLibraryBySlug(params.targetLibrarySlug);
    const childLibs = repo.listChildLibraries(params.targetLibrarySlug);
    const childSuffix =
      childLibs.length > 0
        ? `（或其附属子库：${childLibs.map((c) => `${c.name}[${c.slug}]`).join('、')}）`
        : '';
    contextBlock = `[当前所在记录本]：用户正停留在「${targetLib?.name ?? params.targetLibrarySlug}」(slug: "${params.targetLibrarySlug}")${childSuffix}，若语义匹配请优先归入该库。\n`;
  }

  const promptBody = `今天日期（本地时区）: ${todayStr}\n\n${catalog}\n\n${contextBlock}用户输入: ${params.text || '（请识别图片内容并提取入库记录）'}${webContext}`;

  const userContent: string | ChatContentBlock[] = params.imageBase64DataUrl
    ? [
        { type: 'text', text: promptBody },
        {
          type: 'image_url',
          image_url: { url: params.imageBase64DataUrl, detail: 'auto' },
        },
      ]
    : promptBody;

  const { message } = await callDeepSeekChat({
    thinking: false,
    jsonMode: true,
    signal: params.signal,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return parseAndValidateAiJson(message.content ?? '{}', OmniCaptureResultSchema);
}

/**
 * 3. AI 数据分析师（Analyst Agent）
 */
export async function runAnalystAgent(
  repo: OmniRepository,
  question: string,
  onProgress?: (msg: string) => void,
  context?: {
    targetLibrarySlug?: string;
    entryContext?: CaptureEntryContext;
    signal?: AbortSignal;
  }
): Promise<AnalystAnswer> {
  const todayStr = formatLocalDate();
  const catalog = buildDatabaseCatalogPrompt(repo.getLibraryCatalogItems(false));
  const answerSchemaSpec = JSON.stringify(getAnalystJsonSchema());

  onProgress?.('正在核对你的本地记录...');

  const systemPrompt = buildAnalystSystemPrompt(answerSchemaSpec);

  let focusContext = '';
  if (context?.entryContext) {
    focusContext = `\n\n[当前详情页聚焦记录]：用户正查看「${context.entryContext.libraryIcon} ${context.entryContext.libraryName}」(逻辑视图 \`v_${context.entryContext.librarySlug}\`) 中的单条记录「${context.entryContext.title}」(entry_id = '${context.entryContext.entryId}')。若用户提问未指明范围，请优先围绕该 entry_id 及其在 \`entry_relations\` 中关联的记录进行分析。`;
  } else if (context?.targetLibrarySlug) {
    const lib = repo.getLibraryBySlug(context.targetLibrarySlug);
    const childLibs = repo.listChildLibraries(context.targetLibrarySlug);
    const childDesc =
      childLibs.length > 0
        ? `（关联附属子表视图：${childLibs.map((c) => `\`v_${c.slug}\``).join('、')}）`
        : '';
    focusContext = `\n\n[当前聚焦记录本]：用户正停留在「${lib ? `${lib.icon} ${lib.name}` : context.targetLibrarySlug}」(逻辑视图 \`v_${context.targetLibrarySlug}\`)${childDesc}。若用户未指定其他数据表，请默认分析该记录本及其关联数据，并优先产出适合固定到该记录本统计页的图表。`;
  }

  const { finalContent } = await runDeepSeekToolLoop({
    reasoningEffort: 'high',
    signal: context?.signal,
    onProgress,
    initialMessages: [
      { role: 'system', content: `${systemPrompt}\n\n${catalog}` },
      { role: 'user', content: `今天日期（本地时区）：${todayStr}${focusContext}\n\n${question}` },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'execute_readonly_sql',
          description: '在本地 SQLite 只读连接上执行单条 SELECT / WITH 查询并返回 JSON 行数组',
          parameters: {
            type: 'object',
            properties: {
              sql: {
                type: 'string',
                description: '只读 SQLite SELECT 语句，查询 v_<slug> 与 entry_relations',
              },
            },
            required: ['sql'],
          },
        },
      },
    ],
    executeTool: (name, args) => {
      if (name !== 'execute_readonly_sql') {
        return JSON.stringify({ error: `未知工具: ${name}` });
      }
      try {
        const rows = repo.executeReadOnlyQuery(String(args.sql ?? ''));
        return JSON.stringify({ rowCount: rows.length, rows: rows.slice(0, 50) });
      } catch (err) {
        return JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });

  return parseAndValidateAiJson(finalContent, AnalystAnswerSchema);
}
