export type SqlParam = string | number | null;

export interface SyncSqlDriver {
  execSync(sql: string): void;
  runSync(sql: string, params?: SqlParam[]): void;
  getAllSync<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
  getFirstSync<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | null;
  withTransactionSync<T>(fn: () => T): T;
  queryReadOnlySync<T = Record<string, unknown>>(sql: string): T[];
}

/**
 * 校验并规范化 AI 或看板执行的只读 SQL，拦截任何 DDL/DML 变更或潜在注入
 */
export function sanitizeReadOnlySql(rawSql: string): string {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new Error('SQL 不能为空');
  }

  // 禁止多语句执行
  if (trimmed.includes(';')) {
    throw new Error('安全沙盒仅允许单条只读 SELECT / WITH 查询');
  }

  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error('只读沙盒仅允许 SELECT 或 WITH 查询语句');
  }

  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REPLACE|TRUNCATE)\b/i;
  if (forbidden.test(trimmed)) {
    throw new Error('检测到非只读 SQL 关键字，已被安全沙盒拦截');
  }

  // 自动补充上限防止笛卡尔积撑爆移动端内存
  if (!/\bLIMIT\s+\d+/i.test(trimmed)) {
    return `${trimmed} LIMIT 300`;
  }
  return trimmed;
}
