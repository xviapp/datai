import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { sanitizeReadOnlySql, type SqlParam, type SyncSqlDriver } from './types';

const LEGACY_STORAGE_KEY = 'omni_record_sqlite_v1_b64';
const IDB_NAME = 'folio_sqlite_store_v1';
const IDB_STORE = 'database';
const IDB_KEY = 'main';

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

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = window.indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const idb = req.result;
        if (!idb.objectStoreNames.contains(IDB_STORE)) {
          idb.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function readBytesFromIdb(idb: IDBDatabase): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(IDB_KEY);
    req.onsuccess = () => {
      const val = req.result;
      if (val instanceof Uint8Array) {
        resolve(val);
      } else if (val instanceof ArrayBuffer) {
        resolve(new Uint8Array(val));
      } else {
        resolve(null);
      }
    };
    req.onerror = () => reject(req.error ?? new Error('读取 IndexedDB 失败'));
  });
}

function writeBytesToIdb(idb: IDBDatabase, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    store.put(bytes, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('写入 IndexedDB 失败'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB 事务中止'));
  });
}

export async function getPlatformSqlDriver(): Promise<SyncSqlDriver> {
  if (cachedDriver) return cachedDriver;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const SQL = await initSqlJs({
      locateFile: () => '/sql-wasm.wasm',
      useOldExtensionFunctions: false,
    });

    const idb = await openIdb();
    const persistErrorListeners = new Set<(message: string | null) => void>();
    let lastPersistError: string | null = null;

    const reportPersistError = (message: string | null) => {
      if (lastPersistError === message) return;
      lastPersistError = message;
      for (const fn of persistErrorListeners) {
        fn(message);
      }
    };

    let initialBytes: Uint8Array | null = null;

    if (idb) {
      try {
        initialBytes = await readBytesFromIdb(idb);
      } catch {
        initialBytes = null;
      }
    }

    // 兼容旧版 localStorage：若 IndexedDB 中尚无数据，则自动迁移旧库并清理 localStorage
    if (!initialBytes && typeof window !== 'undefined') {
      try {
        const legacyB64 = window.localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyB64) {
          initialBytes = base64ToUint8(legacyB64);
          if (idb) {
            await writeBytesToIdb(idb, initialBytes);
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
        }
      } catch {
        // ignore corrupted legacy data
      }
    }

    let db: SqlJsDatabase;
    try {
      db = initialBytes ? new SQL.Database(initialBytes) : new SQL.Database();
    } catch {
      db = new SQL.Database();
    }

    db.run('PRAGMA foreign_keys = ON;');

    let inTx = false;
    let pendingBytes: Uint8Array | null = null;
    let flushing = false;

    const flushLoop = async () => {
      if (flushing) return;
      flushing = true;
      try {
        while (pendingBytes) {
          const snapshot = pendingBytes;
          pendingBytes = null;
          if (idb) {
            await writeBytesToIdb(idb, snapshot);
          } else if (typeof window !== 'undefined') {
            window.localStorage.setItem(LEGACY_STORAGE_KEY, uint8ToBase64(snapshot));
          }
          reportPersistError(null);
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        reportPersistError(
          `浏览器本地存储写入失败（刷新后可能丢失最新改动）：${detail}`
        );
      } finally {
        flushing = false;
        if (pendingBytes) {
          void flushLoop();
        }
      }
    };

    const persist = () => {
      if (inTx || typeof window === 'undefined') return;
      try {
        pendingBytes = db.export();
        void flushLoop();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        reportPersistError(`导出本地数据库失败：${detail}`);
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
      subscribePersistError(listener: (message: string | null) => void): () => void {
        persistErrorListeners.add(listener);
        if (lastPersistError) {
          listener(lastPersistError);
        }
        return () => {
          persistErrorListeners.delete(listener);
        };
      },
    };

    return cachedDriver;
  })();

  return initPromise;
}
