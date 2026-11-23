import { z } from 'zod';
import { FieldDefSchema } from './field-defs';

export const HighlightToneEnum = z.enum(['danger', 'warning', 'success', 'info']);
export type HighlightTone = z.infer<typeof HighlightToneEnum>;

export const HighlightOperatorEnum = z.enum([
  'lt',
  'gt',
  'lte',
  'gte',
  'eq',
  'contains',
  'days_until_lt',
  'is_true',
]);

export const HighlightRuleSchema = z.object({
  fieldKey: z.string(),
  operator: HighlightOperatorEnum,
  value: z.union([z.string(), z.number()]).optional(),
  tone: HighlightToneEnum,
  badgeText: z.string().optional().describe('命中规则时显示的提醒胶囊文案，如 临期预警 / 库存不足'),
});

export type HighlightRule = z.infer<typeof HighlightRuleSchema>;

export const CardViewConfigSchema = z.object({
  titleFieldKey: z.string(),
  subtitleFieldKey: z.string().optional(),
  coverImageFieldKey: z.string().optional(),
  rightBadgeFieldKey: z.string().optional(),
  footerMetricKeys: z.array(z.string()).max(4).default([]),
  groupByFieldKey: z.string().optional(),
  sortFieldKey: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  highlightRules: z.array(HighlightRuleSchema).default([]),
});

export type CardViewConfig = z.infer<typeof CardViewConfigSchema>;

export const GalleryViewConfigSchema = z.object({
  titleFieldKey: z.string(),
  subtitleFieldKey: z.string().optional(),
  coverImageFieldKey: z.string().optional(),
  badgeFieldKey: z.string().optional(),
  ratingFieldKey: z.string().optional(),
});

export type GalleryViewConfig = z.infer<typeof GalleryViewConfigSchema>;

export const CalendarViewConfigSchema = z.object({
  dateFieldKey: z.string(),
  titleFieldKey: z.string(),
  metricFieldKey: z.string().optional(),
  tagFieldKey: z.string().optional(),
});

export type CalendarViewConfig = z.infer<typeof CalendarViewConfigSchema>;

export const ChartTypeEnum = z.enum(['kpi_number', 'bar', 'line', 'pie']);
export type ChartType = z.infer<typeof ChartTypeEnum>;

export const AccentToneEnum = z.enum(['teal', 'amber', 'rose', 'blue', 'emerald', 'slate']);
export type AccentTone = z.infer<typeof AccentToneEnum>;

export const DashboardWidgetSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  chartType: ChartTypeEnum,
  readonlySql: z
    .string()
    .describe('仅针对逻辑视图 v_<slug> 和 entry_relations 的只读 SELECT SQL 语句'),
  xKey: z.string().optional().describe('分类轴/时间轴对应的 SQL 返回列名'),
  yKey: z.string().describe('数值轴/KPI 主指标对应的 SQL 返回列名'),
  unitPrefix: z.string().optional(),
  unitSuffix: z.string().optional(),
  accentTone: AccentToneEnum.default('teal'),
});

export type DashboardWidget = z.infer<typeof DashboardWidgetSchema>;

export const LibraryViewTypeEnum = z.enum(['card', 'gallery', 'calendar', 'stats']);
export type LibraryViewType = z.infer<typeof LibraryViewTypeEnum>;

export const LibraryViewBlueprintSchema = z.object({
  name: z.string().min(1).describe('视图显示名称，如 列表 / 封面墙 / 消费日历 / 数据统计'),
  viewType: LibraryViewTypeEnum.describe(
    '视图表现类型：card(列表) | gallery(画廊) | calendar(日历) | stats(统计)'
  ),
});
export type LibraryViewBlueprint = z.infer<typeof LibraryViewBlueprintSchema>;

export const LibraryLayoutBundleSchema = z.object({
  card: CardViewConfigSchema,
  gallery: GalleryViewConfigSchema.optional(),
  calendar: CalendarViewConfigSchema.optional(),
});

export type LibraryLayoutBundle = z.infer<typeof LibraryLayoutBundleSchema>;

export const LibraryBlueprintSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .describe('英文蛇形唯一标识，如 daily_bills，系统将自动创建视图 v_daily_bills'),
  name: z.string().min(1).describe('数据表中文名称，如 日常账单'),
  description: z.string().default(''),
  icon: z.string().default('📦').describe('单个代表性 Emoji 图标'),
  color: AccentToneEnum.default('teal'),
  parentLibrarySlug: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .optional()
    .describe('可选：若为附属子记录本（如阅读记录归属书籍），填主记录本的英文 slug；独立主记录本省略此字段'),
  showOnHome: z
    .boolean()
    .optional()
    .describe('是否在首页网格独立展示卡片；独立主表默认 true，附属子表建议填 false 收纳进主表内部'),
  fields: z.array(FieldDefSchema).min(1),
  viewList: z
    .array(LibraryViewBlueprintSchema)
    .min(1)
    .optional()
    .describe(
      '按需决定的有序视图表现列表（落盘到独立 library_views 表）。只放该记录本真正需要的视图、自定义名称与先后顺序，不要硬塞无用画廊/日历/统计；纯清单类只放 1 项 card 即可'
    ),
  views: LibraryLayoutBundleSchema,
});

export type LibraryBlueprint = z.infer<typeof LibraryBlueprintSchema>;

/**
 * AI 建筑师（Architect Agent）一次性创建或增量演进多表 + 看板的结构化协议
 */
export const ArchitectPlanSchema = z.object({
  summary: z.string().describe('向用户简要说明本次新建或修改了哪些表、字段、关联与视图'),
  libraries: z.array(LibraryBlueprintSchema),
  dashboardWidgets: z.array(DashboardWidgetSchema).default([]),
});

export type ArchitectPlan = z.infer<typeof ArchitectPlanSchema>;

/**
 * AI 全局万能快记（Omni-Capture Agent）跨库草稿输出协议
 */
export const DraftEntryItemSchema = z.object({
  librarySlug: z.string(),
  reason: z.string().describe('为什么归入该库或关联该记录的简短说明'),
  data: z.record(z.string(), z.unknown()).describe('按该库 field.key 填充的键值对象；relation 字段填匹配到的已有记录 ID 数组或 "@prev:0" 引用同批次第一条草稿'),
});

export const OmniCaptureResultSchema = z.object({
  assistantNote: z.string().describe('给用户的友好解析反馈'),
  drafts: z.array(DraftEntryItemSchema).min(1),
});

export type DraftEntryItem = z.infer<typeof DraftEntryItemSchema>;
export type OmniCaptureResult = z.infer<typeof OmniCaptureResultSchema>;

/**
 * AI 数据分析师（Analyst Agent）输出协议
 */
export const AnalystAnswerSchema = z.object({
  markdownInsight: z.string().describe('基于真实 SQL 执行结果的精炼分析结论（支持简洁文字与重点数字）'),
  suggestedWidget: DashboardWidgetSchema.optional().describe('如果问题适合可视化，附带一个可直接钉到看板的图表组件配置'),
});

export type AnalystAnswer = z.infer<typeof AnalystAnswerSchema>;

/**
 * 使用 Zod v4 原生 z.toJSONSchema 导出供 DeepSeek V4.1 使用的 JSON Schema
 */
export function getArchitectJsonSchema() {
  return z.toJSONSchema(ArchitectPlanSchema);
}

export function getOmniCaptureJsonSchema() {
  return z.toJSONSchema(OmniCaptureResultSchema);
}

export function getAnalystJsonSchema() {
  return z.toJSONSchema(AnalystAnswerSchema);
}
