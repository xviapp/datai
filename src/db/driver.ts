import * as SQLite from 'expo-sqlite';
import { sanitizeReadOnlySql, type SqlParam, type SyncSqlDriver } from './types';

let cachedDriver: SyncSqlDriver | null = null;

export async function getPlatformSqlDriver(): Promise<SyncSqlDriver> {
  if (cachedDriver) return cachedDriver;

  const rwDb = SQLite.openDatabaseSync('omni_record_v1.db');
  rwDb.execSync('PRAGMA journal_mode = WAL;');
  rwDb.execSync('PRAGMA foreign_keys = ON;');

  // 独立只读数据库连接，用于 AI 数据分析师与看板统计查询
  const roDb = SQLite.openDatabaseSync('omni_record_v1.db');
  roDb.execSync('PRAGMA query_only = ON;');

  cachedDriver = {
    execSync(sql: string) {
      rwDb.execSync(sql);
    },
    runSync(sql: string, params: SqlParam[] = []) {
      rwDb.runSync(sql, params);
    },
    getAllSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
      return rwDb.getAllSync<T>(sql, params);
    },
    getFirstSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | null {
      return rwDb.getFirstSync<T>(sql, params);
    },
    withTransactionSync<T>(fn: () => T): T {
      let result!: T;
      rwDb.withTransactionSync(() => {
        result = fn();
      });
      return result;
    },
    queryReadOnlySync<T = Record<string, unknown>>(sql: string): T[] {
      const safeSql = sanitizeReadOnlySql(sql);
      roDb.execSync('PRAGMA query_only = ON;');
      return roDb.getAllSync<T>(safeSql);
    },
  };

  return cachedDriver;
}
