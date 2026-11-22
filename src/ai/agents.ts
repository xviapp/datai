import type { OmniRepository } from '@/db/repository';
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

/**
 * 1. AI 建筑师（Architect Agent）
 * 根据自然语言一次性设计/增量演进多表数据模型、双向引用、Rollup/Formula、卡片高亮规则与统计看板组件
 */
export async function runArchitectAgent(
  repo: OmniRepository,
  userPrompt: string,
  onProgress?: (msg: string) => void
): Promise<ArchitectPlan> {
  const prefs = await getAiPreferences();
  onProgress?.('正在启用 deepseek-flash 思考模式推演表结构与关联关系...');

  const existingLibs = repo.listLibraries().map((l) => ({
    slug: l.slug,
    name: l.name,
    description: l.description,
    icon: l.icon,
    color: l.color,
    fields: l.fields,
    views: l.views,
  }));

  const schemaSpec = JSON.stringify(getArchitectJsonSchema());

  // 固定前缀置顶，最大化命中 DeepSeek 硬盘缓存（0.02元/百万Tokens）
  const systemPrompt = `你是「个人全能记录 App」的首席数据库与界面架构师。
你的任务是根据用户描述，输出新建或增量修改的数据表（libraries）以及跨库统计看板（dashboardWidgets），严格输出符合以下 JSON Schema 的单个 JSON 对象：
${schemaSpec}

核心设计准则：
1. slug 与所有 field.key 必须使用英文小写蛇形命名（如 workout_logs, duration_min），系统会自动创建逻辑视图 v_<slug>。
2. 若跨表存在关联，使用 type="relation" 并设置 relationConfig.targetLibrarySlug；在被关联表上可善用 type="rollup"（聚合正向字段或 "reverse:<源库slug>.<关联字段key>"）以及 type="formula"（支持 + - * /、DAYS_SINCE(date)、DAYS_UNTIL(date)、MAX、MIN、ROUND、IF）。
3. 为每个库配置美观实用的 views.card（指定 titleFieldKey、subtitleFieldKey、rightBadgeFieldKey、最多3~4个 footerMetricKeys，以及合理的 highlightRules 预警规则；若有日期字段顺手配置 views.calendar；若有图片/评分顺手配置 views.gallery）。
4. 若修改已有库（slug 相同），必须完整保留该库原有的存量字段 key，在此基础上追加或调整样式，严禁随意改名已有字段导致用户历史数据丢失。
5. dashboardWidgets 的 readonlySql 只能查询逻辑视图 v_<slug>（注意 rollup 和 formula 字段不在物理 SQL 视图列中，请在 SQL 内直接用基础列与 entry_relations 做聚合计算）。`;

  const userMessage = `当前已有库结构 JSON：\n${JSON.stringify(existingLibs)}\n\n用户的建模/修改需求：\n${userPrompt}`;

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
    targetLibrarySlug?: string;
  },
  onProgress?: (msg: string) => void
): Promise<OmniCaptureResult> {
  const prefs = await getAiPreferences();
  const todayStr = new Date().toISOString().slice(0, 10);

  let webContext = '';
  const shouldEnrich =
    Boolean(params.useWebSearch && prefs.enableWebEnrich) || /https?:\/\/[^\s]+/i.test(params.text);

  if (shouldEnrich && params.text.trim()) {
    onProgress?.('正在通过 DeepSeek 联网/链接工具补全背景信息...');
    const enriched = await enrichTextWithDeepSeekWeb(params.text, Boolean(params.useWebSearch));
    if (enriched) {
      webContext = `\n\n[联网/网页链接补充事实]：\n${enriched}`;
    }
  }

  onProgress?.('正在使用 deepseek-flash 解析结构化字段与跨库关联...');

  const catalog = repo.getAiCatalogPrompt(true);
  const schemaSpec = JSON.stringify(getOmniCaptureJsonSchema());

  const systemPrompt = `你是「个人全能记录 App」的极速智能录入引擎。今天日期是 ${todayStr}。
请将用户的输入（文字、小票/物品照片或网页补充信息）精准拆解为一条或多条待入库草稿，严格输出符合以下 JSON Schema 的 JSON 对象：
${schemaSpec}

录入规则：
1. 只能写入下方目录中存在的 librarySlug，且 data 的键必须严格对应各库的物理字段 key（不要填写 rollup 或 formula 字段）。
2. 日期字段统一输出 "YYYY-MM-DD" 格式（如用户说“今天/刚才”填 "${todayStr}"，“昨天”自动减1天）。
3. 对于 relation 关联字段：
   - 若匹配到下方目录「已有记录候选」中的某条记录，请直接填入该记录的真实 ID 数组（如 ["ent_xxx"]）；
   - 若一句话同时触发新建两条有关联的记录（例如“花1899买了台Switch” -> 先在 my_assets 新建草稿0，再在 daily_bills 新建草稿1关联它），可在草稿1的关联字段填入 ["@prev:0"] 引用同批次下标为 0 的草稿！
4. select / multi_select 字段优先匹配该字段已定义的 options 可选值。`;

  const promptBody = `${catalog}\n\n${
    params.targetLibrarySlug ? `用户指定优先归入库: ${params.targetLibrarySlug}\n` : ''
  }用户输入: ${params.text || '（请识别图片内容并提取入库记录）'}${webContext}`;

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
  onProgress?: (msg: string) => void
): Promise<AnalystAnswer> {
  const todayStr = new Date().toISOString().slice(0, 10);
  const catalog = repo.getAiCatalogPrompt(false);
  const answerSchemaSpec = JSON.stringify(getAnalystJsonSchema());

  onProgress?.('正在思考查询路径并生成只读验证 SQL...');

  const systemPrompt = `你是「个人全能记录 App」的首席数据分析师。今天日期是 ${todayStr}。
你拥有工具 \`execute_readonly_sql\`，可在手机本地 SQLite 只读沙盒上运行 SELECT 查询。

工作铁律：
1. **绝不凭空心算或编造数字**！回答任何统计、排名、趋势、对比问题前，必须先调用 \`execute_readonly_sql\` 查询真实数据。
2. 如果第一次 SQL 报错或列名写错，请根据错误信息修正 SQL 重新调用工具。注意：rollup 和 formula 字段不在 v_<slug> 视图中，跨表关联请 JOIN \`entry_relations(source_entry_id, target_entry_id, field_key)\`。
3. 拿到真实查询结果后，最终回复必须直接输出严格符合以下 JSON Schema 的纯 JSON 字符串（不要包裹额外散文）：
${answerSchemaSpec}
4. 如果该问题适合用数字卡（kpi_number）、柱状图（bar）、折线图（line）或饼图（pie）展示，请一并填写 \`suggestedWidget\`，其 \`readonlySql\` 必须是你刚刚通过工具验证成功的 SQL，且 \`xKey\`/\`yKey\` 与 SQL 返回别名完全一致！`;

  const { finalContent } = await runDeepSeekToolLoop({
    reasoningEffort: 'high',
    onProgress,
    initialMessages: [
      { role: 'system', content: `${systemPrompt}\n\n${catalog}` },
      { role: 'user', content: question },
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
