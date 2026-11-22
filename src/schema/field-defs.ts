import { z } from 'zod';

export const FieldTypeEnum = z.enum([
  'text',
  'number',
  'currency',
  'date',
  'select',
  'multi_select',
  'rating',
  'checkbox',
  'image',
  'relation',
  'rollup',
  'formula',
]);

export type FieldType = z.infer<typeof FieldTypeEnum>;

export const FieldOptionSchema = z.object({
  value: z.string().min(1),
  color: z.string().optional(),
});

export type FieldOption = z.infer<typeof FieldOptionSchema>;

export const RelationConfigSchema = z.object({
  targetLibrarySlug: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .describe('目标关联库的英文 slug 标识'),
  allowMultiple: z.boolean().default(true),
});

export type RelationConfig = z.infer<typeof RelationConfigSchema>;

export const RollupFnEnum = z.enum(['SUM', 'AVG', 'COUNT', 'MIN', 'MAX']);
export type RollupFn = z.infer<typeof RollupFnEnum>;

export const RollupConfigSchema = z.object({
  relationFieldKey: z.string().describe('当前库中关联字段的 key（也可填 reverse:<sourceSlug>.<fieldKey> 聚合反向关联）'),
  targetFieldKey: z.string().describe('关联目标库中被聚合字段的 key'),
  fn: RollupFnEnum,
});

export type RollupConfig = z.infer<typeof RollupConfigSchema>;

export const FieldDefSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/)
    .describe('英文蛇形字段名，直接映射为逻辑 SQL 视图列名，如 buy_price'),
  label: z.string().min(1).describe('用户界面显示的中文名，如 购买价格'),
  type: FieldTypeEnum,
  required: z.boolean().default(false),
  placeholder: z.string().optional(),
  unit: z.string().optional().describe('展示单位，如 元、天、片、次'),
  options: z.array(FieldOptionSchema).optional(),
  relationConfig: RelationConfigSchema.optional(),
  rollupConfig: RollupConfigSchema.optional(),
  formulaExpr: z
    .string()
    .optional()
    .describe(
      '安全算术与日期表达式，支持字段名引用、+ - * /、DAYS_SINCE(dateField)、DAYS_UNTIL(dateField)、IF(cond, a, b)、ROUND(val, 2)'
    ),
});

export type FieldDef = z.infer<typeof FieldDefSchema>;

/**
 * 根据库的动态字段定义生成运行时 Zod 校验器，用于表单提交与 AI 快记数据清洗
 */
export function buildEntryPayloadValidator(fields: FieldDef[]) {
  const shape: Record<string, z.ZodType> = {};

  for (const field of fields) {
    // 计算类字段不在物理 data_json 中强制要求输入
    if (field.type === 'rollup' || field.type === 'formula') {
      continue;
    }

    let validator: z.ZodType;
    switch (field.type) {
      case 'number':
      case 'currency':
      case 'rating':
        validator = z.preprocess((val) => {
          if (val === '' || val === null || val === undefined) return undefined;
          const num = Number(val);
          return Number.isNaN(num) ? val : num;
        }, z.number());
        break;
      case 'checkbox':
        validator = z.preprocess((val) => {
          if (val === 'true' || val === 1) return true;
          if (val === 'false' || val === 0) return false;
          return Boolean(val);
        }, z.boolean());
        break;
      case 'multi_select':
      case 'relation':
        validator = z.preprocess((val) => {
          if (Array.isArray(val)) return val.map(String);
          if (typeof val === 'string' && val.trim()) {
            return val
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
          }
          return [];
        }, z.array(z.string()));
        break;
      case 'date':
      case 'text':
      case 'select':
      case 'image':
      default:
        validator = z.preprocess((val) => {
          if (val === null || val === undefined) return '';
          return String(val);
        }, z.string());
        break;
    }

    if (!field.required && field.type !== 'checkbox' && field.type !== 'multi_select' && field.type !== 'relation') {
      validator = validator.optional();
    } else if (field.required && (field.type === 'text' || field.type === 'date' || field.type === 'select')) {
      validator = z.string().min(1, `${field.label}不能为空`);
    }

    shape[field.key] = validator;
  }

  return z.object(shape).passthrough();
}
