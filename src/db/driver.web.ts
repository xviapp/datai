import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { sanitizeReadOnlySql, type SqlParam, type SyncSqlDriver } from './types';

const STORAGE_KEY = 'omni_record_sqlite_v1_b64';
let cachedDriver: SyncSqlDriver | null = null;
let initPromise: Promise<SyncSqlDriver> | null = null;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function getPlatformSqlDriver(): Promise<SyncSqlDriver> {
  if (cachedDriver) return cachedDriver;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs({
      locateFile: () => '/sql-wasm.wasm',
      useOldExtensionFunctions: false,
    });

    let db: SqlJsDatabase;
    try {
      const saved = typeof window !== 'undefined' ? window.localStorage.getItem(STORAGE_KEY) : null;
      db = saved ? new SQL.Database(base64ToUint8(saved)) : new SQL.Database();
    } catch {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON;');

    let inTx = false;
    const persist = () => {
      if (inTx || typeof window === 'undefined') return;
      try {
        const exported = db.export();
        window.localStorage.setItem(STORAGE_KEY, uint8ToBase64(exported));
      } catch {
        // Ignore storage quota warnings in preview
      }
    };

    const queryRows = <T>(sql: string, params: SqlParam[] = []): T[] => {
      const stmt = db.prepare(sql);
      try {
        if (params.length > 0) {
          stmt.bind(params);
        }
        const rows: T[] = [];
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as T);
        }
        return rows;
      } finally {
        stmt.free();
      }
    };

    cachedDriver = {
      execSync(sql: string) {
        db.exec(sql);
        persist();
      },
      runSync(sql: string, params: SqlParam[] = []) {
        db.run(sql, params);
        persist();
      },
      getAllSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
        return queryRows<T>(sql, params);
      },
      getFirstSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | null {
        const rows = queryRows<T>(sql, params);
        return rows[0] ?? null;
      },
      withTransactionSync<T>(fn: () => T): T {
        const outerTx = inTx;
        if (!outerTx) {
          db.run('BEGIN TRANSACTION;');
          inTx = true;
        }
        try {
          const res = fn();
          if (!outerTx) {
            db.run('COMMIT;');
            inTx = false;
            persist();
          }
          return res;
        } catch (err) {
          if (!outerTx) {
            try {
              db.run('ROLLBACK;');
            } catch {
              // ignore rollback errors
            }
            inTx = false;
          }
          throw err;
        }
      },
      queryReadOnlySync<T = Record<string, unknown>>(sql: string): T[] {
        const safeSql = sanitizeReadOnlySql(sql);
        db.run('PRAGMA query_only = ON;');
        try {
          return queryRows<T>(safeSql);
        } finally {
          db.run('PRAGMA query_only = OFF;');
        }
      },
    };

    return cachedDriver;
  })();

  return initPromise;
}
