export type SqlParam = string | number | null;

export interface SyncSqlDriver {
  execSync(sql: string): void;
  runSync(sql: string, params?: SqlParam[]): void;
  getAllSync<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
  getFirstSync<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | null;
  withTransactionSync<T>(fn: () => T): T;
  queryReadOnlySync<T = Record<string, unknown>>(sql: string): T[];
  /** 可选：订阅持久化写入失败（如 Web 端存储配额不足） */
  subscribePersistError?: (listener: (message: string | null) => void) => () => void;
}

/**
 * 剥离 SQL 中的注释、单引号字符串字面量和双引号标识符，仅用于结构合法性校验，
 * 避免字符串内容中的分号或 replace() 等内置函数被误拦。
 */
function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // 单行注释 -- ...
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      out += ' ';
      continue;
    }

    // 块注释 /* ... */
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }

    // 单引号字符串或双引号标识符（支持 '' / "" 转义）
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < len) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * 校验并规范化 AI 或看板执行的只读 SQL：
 * 原生端与 Web 端均通过 PRAGMA query_only = ON 做底层只读兜底；
 * 此处仅校验必须以 SELECT / WITH 开头且为单条语句，避免误拦 REPLACE() 或字符串内的分号。
 */
export function sanitizeReadOnlySql(rawSql: string): string {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '');
  if (!trimmed) {
    throw new Error('SQL 不能为空');
  }

  const stripped = stripSqlLiteralsAndComments(trimmed).trim();
  if (!stripped) {
    throw new Error('SQL 不能为空');
  }

  // 禁止多语句执行（已在剥离字符串字面量与注释后检查）
  if (stripped.includes(';')) {
    throw new Error('安全沙盒仅允许单条只读 SELECT / WITH 查询');
  }

  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    throw new Error('只读沙盒仅允许 SELECT 或 WITH 查询语句');
  }

  // 自动补充上限防止笛卡尔积撑爆移动端内存
  if (!/\bLIMIT\s+\d+/i.test(stripped)) {
    return `${trimmed} LIMIT 300`;
  }
  return trimmed;
}

/**
 * 按标识符单词边界判断 SQL 是否引用了某库的逻辑视图 v_<slug>
 * （避免 v_bill 误匹配到 v_bills 或 LIKE 下划线通配符误伤）
 */
export function sqlReferencesLibraryView(sql: string, slug: string): boolean {
  if (!/^[a-z][a-z0-9_]*$/.test(slug)) return false;
  const pattern = new RegExp(`\\bv_${slug}\\b`, 'i');
  return pattern.test(sql);
}

/**
 * 转义 SQLite LIKE 模式中的特殊通配符（\、%、_），需配合 ESCAPE '\' 使用
 */
export function escapeLikePattern(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
