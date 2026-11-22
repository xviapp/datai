/**
 * 返回本地时区的 YYYY-MM-DD 日期字符串，避免 UTC 偏移导致 0–8 点日期差一天
 */
export function formatLocalDate(input: Date | number = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 返回相对于本地今天的偏移日期（offsetDays 可正可负）
 */
export function formatLocalDateOffset(offsetDays: number, base: Date = new Date()): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays);
  return formatLocalDate(d);
}
