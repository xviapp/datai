import type { LibraryCatalogItem } from '@/db/models';

export const INTENT_ROUTER_SYSTEM_PROMPT = `你是个人记录 App 的意图路由器。根据用户输入与当前所在页面，输出单个 JSON：{"intent":"architect"|"analyst"|"capture"}。
判定规则：
- "architect"：用户想新建记录本/数据表，或给当前/已有记录本新增、修改字段、公式、提醒高亮规则、附属子表、卡片样式，或**开启/关闭/重命名/调整排序画廊、日历、统计等视图表现**（哪怕同时顺带要一张图表）。
- "analyst"：用户想查询、统计、汇总、排名、对比、排查已有记录的数据，或基于已有记录画统计图表。
- "capture"：用户想录入一条具体的日常记录、进度打卡、书摘随感或跨表关联流水（例如刚买了某物花了多少钱、某本书读到多少页、刚吃了某种药）。`;

/**
 * 为 deepseek-flash 生成极简、高信息密度的数据库视图与关联字典（利于命中前缀缓存）
 */
export function buildDatabaseCatalogPrompt(libraries: LibraryCatalogItem[]): string {
  if (libraries.length === 0) {
    return '当前本地数据库尚无自定义库。';
  }

  const lines: string[] = [
    '## 本地 SQLite 逻辑视图与表结构目录',
    '跨表引用关系存放在边表 `entry_relations(source_entry_id, target_entry_id, field_key)`，可与各视图的 `_id` 做 JOIN。',
    '',
  ];

  for (const lib of libraries) {
    const parentNote = lib.parentLibrarySlug
      ? `, 附属子库 -> 归属主库 \`${lib.parentLibrarySlug}\``
      : '';
    lines.push(
      `### 库: ${lib.icon} ${lib.name} (slug: \`${lib.slug}\`, SQL视图: \`v_${lib.slug}\`${parentNote})`
    );
    if (lib.description) {
      lines.push(`说明: ${lib.description}`);
    }
    lines.push('- 内置列: `_id` (TEXT 主键), `_title` (TEXT 主标题), `_created_at` (DATETIME)');
    for (const f of lib.fields) {
      let extra = '';
      if (f.multiline) extra += ' [多行长文本/书摘笔记]';
      if (f.unit) extra += ` [单位:${f.unit}]`;
      if (f.options?.length) extra += ` [可选值:${f.options.map((o) => o.value).join('/')}]`;
      if (f.relationConfig) {
        extra += ` [关联目标库:${f.relationConfig.targetLibrarySlug}, 通过 entry_relations.field_key='${f.key}' 连接]`;
      }
      if (f.rollupConfig) {
        extra += ` [Rollup:${f.rollupConfig.fn}(${f.rollupConfig.relationFieldKey}->${f.rollupConfig.targetFieldKey}), 不在SQL视图列中]`;
      }
      if (f.formulaExpr) {
        extra += ` [行内公式:${f.formulaExpr}, 不在SQL视图列中]`;
      }
      if (f.type === 'image') {
        extra += ' [图片字段, 不在SQL视图列中]';
      }
      lines.push(`- \`${f.key}\` (${f.type}, "${f.label}")${extra}`);
    }
    if (lib.recentEntries && lib.recentEntries.length > 0) {
      lines.push(
        `- 已有记录候选(供关联引用匹配 ID): ${lib.recentEntries
          .map((e) => `${e.title}=>${e.id}`)
          .join(' | ')}`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function buildArchitectSystemPrompt(schemaSpec: string): string {
  // 固定前缀置顶，最大化命中 DeepSeek 硬盘缓存
  return `你是「个人全能记录 App」的首席数据库与界面架构师。
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
}

export function buildOmniCaptureSystemPrompt(schemaSpec: string): string {
  // 固定前缀置顶（不放动态日期），最大化命中 DeepSeek 硬盘前缀缓存
  return `你是「个人全能记录 App」的极速智能录入引擎。
请将用户的输入（文字、小票/书页照片或网页补充信息）精准拆解为一条或多条待入库草稿，严格输出符合以下 JSON Schema 的 JSON 对象：
${schemaSpec}

录入规则：
1. 只能写入用户消息所给目录中存在的 librarySlug，且 data 的键必须严格对应各库的物理字段 key（不要填写 rollup 或 formula 字段）。
2. 日期字段统一输出 "YYYY-MM-DD" 格式（以用户消息提供的「今天日期」为准；说“今天/刚才”填今天日期，“昨天”自动减 1 天）。
3. 对于 relation 关联字段与附属子库：
   - 若匹配到目录「已有记录候选」中的某条记录，请直接填入该记录的真实 ID 数组（如 ["ent_xxx"]）；
   - 若一句话同时触发新建两条有关联的记录，或记录某附属子库流水但主库尚无该主体（例如“开始读《长安的荔枝》，今天读了30分钟到第50页”且书架尚无此书），请先生成草稿0在主库新建该主体，再生成草稿1在附属子库记录本次流水并在关联字段填入 ["@prev:0"] 引用草稿0！
4. select / multi_select 字段优先匹配该字段已定义的 options 可选值。`;
}

export function buildAnalystSystemPrompt(answerSchemaSpec: string): string {
  // 固定前缀置顶（不放动态日期），最大化命中 DeepSeek 硬盘前缀缓存
  return `你是「个人全能记录 App」的首席数据分析师。
你拥有工具 \`execute_readonly_sql\`，可在手机本地 SQLite 只读沙盒上运行 SELECT 查询。

工作铁律：
1. **绝不凭空心算或编造数字**！回答任何统计、排名、趋势、对比问题前，必须先调用 \`execute_readonly_sql\` 查询真实数据。
2. 如果第一次 SQL 报错或列名写错，请根据错误信息修正 SQL 重新调用工具。注意：rollup、formula 和 image 字段不在 v_<slug> 视图中，跨表关联请 JOIN \`entry_relations(source_entry_id, target_entry_id, field_key)\`。
3. 拿到真实查询结果后，最终回复必须直接输出严格符合以下 JSON Schema 的纯 JSON 字符串（不要包裹额外散文）：
${answerSchemaSpec}
4. 如果该问题适合用数字卡（kpi_number）、柱状图（bar）、折线图（line）或饼图（pie）展示，请一并填写 \`suggestedWidget\`，其 \`readonlySql\` 必须是你刚刚通过工具验证成功的 SQL，且 \`xKey\`/\`yKey\` 与 SQL 返回别名完全一致！`;
}
