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

/**
 * 生成指定年月的月历日期格矩阵（前置空白格为 null，其余为 YYYY-MM-DD）
 * @param year 公历年份
 * @param monthIndex0 0-based 月份（0 = 1月，11 = 12月）
 */
export function buildMonthCalendarCells(year: number, monthIndex0: number): Array<string | null> {
  const firstWeekday = new Date(year, monthIndex0, 1).getDay();
  const daysInMonth = new Date(year, monthIndex0 + 1, 0).getDate();
  const prefix = `${year}-${String(monthIndex0 + 1).padStart(2, '0')}`;
  const cells: Array<string | null> = [];
  for (let i = 0; i < firstWeekday; i++) {
    cells.push(null);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push(`${prefix}-${String(d).padStart(2, '0')}`);
  }
  return cells;
}

/**
 * 格式化简短相对日期（今天 / 昨天 / N天前 / M/D）
 */
export function formatShortRelativeTime(ts: number, now: Date = new Date()): string {
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfToday - startOfTarget) / 86_400_000);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
