import { z } from 'zod';
import { DashboardWidgetSchema, LibraryBlueprintSchema } from '@/schema/view-dsl';

/**
 * 意图路由输出协议
 */
export const IntentRouterSchema = z.object({
  intent: z.enum(['architect', 'analyst', 'capture']),
});

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
  data: z
    .record(z.string(), z.unknown())
    .describe(
      '按该库 field.key 填充的键值对象；relation 字段填匹配到的已有记录 ID 数组或 "@prev:0" 引用同批次第一条草稿'
    ),
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
  suggestedWidget: DashboardWidgetSchema.optional().describe(
    '如果问题适合可视化，附带一个可直接钉到看板的图表组件配置'
  ),
});

export type AnalystAnswer = z.infer<typeof AnalystAnswerSchema>;

/**
 * 使用 Zod v4 原生 z.toJSONSchema 导出供 DeepSeek 使用的 JSON Schema
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

/**
 * 提取 JSON（兼容 Markdown 代码块或外层散文包裹）并使用 Zod v4 校验返回强类型结果
 */
export function parseAndValidateAiJson<T>(rawText: string, schema: z.ZodType<T>): T {
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      obj = JSON.parse(cleaned.slice(start, end + 1));
    } else {
      throw new Error(`AI 未返回合法 JSON: ${cleaned.slice(0, 120)}`);
    }
  }

  const result = schema.safeParse(obj);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new Error(
      `AI 输出结构未通过 Zod 校验 (${firstIssue?.path.join('.') || 'root'}): ${firstIssue?.message}`
    );
  }
  return result.data;
}
