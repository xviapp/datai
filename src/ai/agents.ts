import { z } from 'zod';
import type { OmniRepository } from '@/db/repository';
import { formatLocalDate } from '@/engine/date';
import {
  AnalystAnswerSchema,
  ArchitectPlanSchema,
  getAnalystJsonSchema,
  getArchitectJsonSchema,
  getOmniCaptureJsonSchema,
  OmniCaptureResultSchema,
  type AnalystAnswer,
  type ArchitectPlan,
  type OmniCaptureResult,
} from '@/schema/view-dsl';
import {
  callDeepSeekChat,
  enrichTextWithDeepSeekWeb,
  parseAndValidateAiJson,
  runDeepSeekToolLoop,
  type ChatContentBlock,
} from './deepseek-client';
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

const IntentRouterSchema = z.object({
  intent: z.enum(['architect', 'analyst', 'capture']),
});

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
    messages: [
      {
        role: 'system',
        content: `你是个人记录 App 的意图路由器。根据用户输入与当前所在页面，输出单个 JSON：{"intent":"architect"|"analyst"|"capture"}。
判定规则：
- "architect"：用户想新建记录本/数据表，或给当前/已有记录本新增、修改字段、公式、提醒高亮规则、附属子表、卡片样式，或**开启/关闭/重命名/调整排序画廊、日历、统计等视图表现**（哪怕同时顺带要一张图表）。
- "analyst"：用户想查询、统计、汇总、排名、对比、排查已有记录的数据，或基于已有记录画统计图表。
- "capture"：用户想录入一条具体的日常记录、进度打卡、书摘随感或跨表关联流水（例如刚买了某物花了多少钱、某本书读到多少页、刚吃了某种药）。`,
      },
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
 * 统一智能助手入口：支持文字 / 语音转写 / 图片 / 联网，结合当前页面场景自动识别意图并注入全链路上下文（也支持 forceIntent 直达）
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
      });
    }
  }

  if (intent === 'architect') {
    onProgress?.('正在构思记录本结构与样式...');
    const plan = await runArchitectAgent(repo, cleanText, onProgress, {
      targetLibrarySlug: params.targetLibrarySlug,
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
  });
  return { intent: 'analyst', answer };
}

/**
 * 1. AI 建筑师（Architect Agent）
 * 根据自然语言一次性设计/增量演进多表数据模型、双向引用、Rollup/Formula、卡片高亮规则与统计看板组件
 */
export async function runArchitectAgent(
  repo: OmniRepository,
  userPrompt: string,
  onProgress?: (msg: string) => void,
  context?: { targetLibrarySlug?: string }
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

  // 固定前缀置顶，最大化命中 DeepSeek 硬盘缓存（0.02元/百万Tokens）
  const systemPrompt = `你是「个人全能记录 App」的首席数据库与界面架构师。
底层采用「数据表（libraries/entries）」「视图表现表（library_views）」「表间关系表（library_relations）」三层解耦架构。
你的任务是根据用户描述，输出新建或增量修改的数据表（libraries）以及跨库统计看板（dashboardWidgets），严格输出符合以下 JSON Schema 的单个 JSON 对象：
${schemaSpec}

核心设计准则：
1. 【数据结构】slug 与所有 field.key 必须使用英文小写蛇形命名（如 workout_logs, duration_min），系统会自动创建逻辑视图 v_<slug>。
2. 【表间关系与计算】跨表关联使用 type="relation" 并设置 relationConfig.targetLibrarySlug（系统自动同步至独立 library_relations 表）；在被关联表上可善用 type="rollup"（聚合正向字段或 "reverse:<源库slug>.<关联字段key>"）以及 type="formula"（支持 + - * /、DAYS_SINCE(date)、DAYS_UNTIL(date)、MAX、MIN、ROUND、IF）。
3. 【按需设计视图（非常重要）】每个库都必须由你主动决定最贴合场景的有序 viewList（落盘到独立 library_views 表），绝不要无脑塞满全部视图：
   - 必须始终配置实用美观的 views.card（titleFieldKey、subtitleFieldKey、rightBadgeFieldKey、最多3~4个 footerMetricKeys 与合理 highlightRules）。
   - 极简清单、静态资料、纯文本备忘录：viewList 只放 1 项 [{"name":"列表","viewType":"card"}]（单视图时界面自动隐藏切换栏，极度清爽）。
   - 强视觉/封面/收藏类（如书单、影视、咖啡豆、穿搭、美食，且含 image 字段）：按需在 viewList 加入 gallery（可起贴切名称如「封面墙」「相册」）并配好 views.gallery；无图片字段的账单/纯清单不要硬塞画廊！
   - 强时间线/打卡/消费/临期提醒类（如账单、运动、用药、阅读流水，且含 date 字段）：按需在 viewList 加入 calendar（如「日历」「打卡日历」）并配好 views.calendar；无日期意义的资料库不要硬塞日历！
   - 当本方案为该库设计了 dashboardWidgets，或用户明确需要本库数据分析时，在 viewList 加入 stats（如「统计」）；否则不加空统计视图。
   - 若用户明确要求“开启/关闭/重命名/调整顺序”某个视图，请在 viewList 中精准体现调整后的最终有序列表（不包含被关闭的视图），同时保留其他未要求改动的视图。
4. 【安全演进】修改已有库（slug 相同）时，必须完整保留原有存量字段 key（除非用户明确要求删除），严禁随意改名已有字段导致用户历史数据丢失。
5. 【只读统计】dashboardWidgets 的 readonlySql 只能查询逻辑视图 v_<slug>（注意 rollup 和 formula 字段不在物理 SQL 视图列中，请在 SQL 内直接用基础列与 entry_relations 做聚合计算）。
6. 【主从附属】当需求包含「主体 + 附属流水/打卡/阅读记录/跟进日志」的 1:N 主从关系（如 书籍+阅读记录、项目+跟进记录、宠物+医疗记录）时：
   - 将附属子表设置 parentLibrarySlug 指向主表 slug（系统会在 library_relations 标记为 parent_child），默认设 showOnHome: false（收纳进主表内部，保持首页清爽），并在附属子表中定义指向主表的 type="relation" 字段（allowMultiple: false）。
   - 对于书摘、随感、复盘、长备注等段落文本字段，设置 type="text" 且 multiline: true。`;

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
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
  });

  return parseAndValidateAiJson(message.content ?? '{}', ArchitectPlanSchema);
}

/**
 * 2. AI 全局万能快记（Omni-Capture Agent）
 * 支持一句话、拍照小票/封面（deepseek-flash 原生视觉）、粘贴链接联网补全，一键生成单库或跨库关联草稿
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
    const enriched = await enrichTextWithDeepSeekWeb(params.text, Boolean(params.useWebSearch));
    if (enriched) {
      webContext = `\n\n[联网/网页链接补充事实]：\n${enriched}`;
    }
  }

  onProgress?.('正在整理内容并归类...');

  const catalog = repo.getAiCatalogPrompt(true);
  const schemaSpec = JSON.stringify(getOmniCaptureJsonSchema());

  // 固定前缀置顶（不放动态日期），最大化命中 DeepSeek 硬盘前缀缓存
  const systemPrompt = `你是「个人全能记录 App」的极速智能录入引擎。
请将用户的输入（文字、小票/书页照片或网页补充信息）精准拆解为一条或多条待入库草稿，严格输出符合以下 JSON Schema 的 JSON 对象：
${schemaSpec}

录入规则：
1. 只能写入用户消息所给目录中存在的 librarySlug，且 data 的键必须严格对应各库的物理字段 key（不要填写 rollup 或 formula 字段）。
2. 日期字段统一输出 "YYYY-MM-DD" 格式（以用户消息提供的「今天日期」为准；说“今天/刚才”填今天日期，“昨天”自动减 1 天）。
3. 对于 relation 关联字段与附属子库：
   - 若匹配到目录「已有记录候选」中的某条记录，请直接填入该记录的真实 ID 数组（如 ["ent_xxx"]）；
   - 若一句话同时触发新建两条有关联的记录，或记录某附属子库流水但主库尚无该主体（例如“开始读《长安的荔枝》，今天读了30分钟到第50页”且书架尚无此书），请先生成草稿0在主库新建该主体，再生成草稿1在附属子库记录本次流水并在关联字段填入 ["@prev:0"] 引用草稿0！
4. select / multi_select 字段优先匹配该字段已定义的 options 可选值。`;

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

  // 快记采用非思考模式，1~2 秒极速响应
  const { message } = await callDeepSeekChat({
    thinking: false,
    jsonMode: true,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });

  return parseAndValidateAiJson(message.content ?? '{}', OmniCaptureResultSchema);
}

/**
 * 3. AI 数据分析师（Analyst Agent）
 * 挂载本地 query_only 只读 SQLite 工具，多轮实测验证 SQL 结果零幻觉后输出分析结论与可固定看板图表
 */
export async function runAnalystAgent(
  repo: OmniRepository,
  question: string,
  onProgress?: (msg: string) => void,
  context?: {
    targetLibrarySlug?: string;
    entryContext?: CaptureEntryContext;
  }
): Promise<AnalystAnswer> {
  const todayStr = formatLocalDate();
  const catalog = repo.getAiCatalogPrompt(false);
  const answerSchemaSpec = JSON.stringify(getAnalystJsonSchema());

  onProgress?.('正在核对你的本地记录...');

  // 固定前缀置顶（不放动态日期），最大化命中 DeepSeek 硬盘前缀缓存
  const systemPrompt = `你是「个人全能记录 App」的首席数据分析师。
你拥有工具 \`execute_readonly_sql\`，可在手机本地 SQLite 只读沙盒上运行 SELECT 查询。

工作铁律：
1. **绝不凭空心算或编造数字**！回答任何统计、排名、趋势、对比问题前，必须先调用 \`execute_readonly_sql\` 查询真实数据。
2. 如果第一次 SQL 报错或列名写错，请根据错误信息修正 SQL 重新调用工具。注意：rollup、formula 和 image 字段不在 v_<slug> 视图中，跨表关联请 JOIN \`entry_relations(source_entry_id, target_entry_id, field_key)\`。
3. 拿到真实查询结果后，最终回复必须直接输出严格符合以下 JSON Schema 的纯 JSON 字符串（不要包裹额外散文）：
${answerSchemaSpec}
4. 如果该问题适合用数字卡（kpi_number）、柱状图（bar）、折线图（line）或饼图（pie）展示，请一并填写 \`suggestedWidget\`，其 \`readonlySql\` 必须是你刚刚通过工具验证成功的 SQL，且 \`xKey\`/\`yKey\` 与 SQL 返回别名完全一致！`;

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
