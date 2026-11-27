import type { SyncSqlDriver } from './types';

export const LATEST_SCHEMA_VERSION = 1;
export const MAX_AI_SNAPSHOTS = 20;

export const CORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '📦',
  color TEXT NOT NULL DEFAULT 'teal',
  parent_slug TEXT DEFAULT NULL,
  show_on_home INTEGER NOT NULL DEFAULT 1,
  fields_json TEXT NOT NULL,
  views_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library_views (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  view_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_library_views_library
  ON library_views(library_id, sort_order ASC);

CREATE TABLE IF NOT EXISTS library_relations (
  id TEXT PRIMARY KEY NOT NULL,
  source_library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  target_library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  relation_kind TEXT NOT NULL DEFAULT 'reference',
  allow_multiple INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(source_library_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_library_relations_source
  ON library_relations(source_library_id);

CREATE INDEX IF NOT EXISTS idx_library_relations_target
  ON library_relations(target_library_id);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY NOT NULL,
  library_id TEXT NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  title_summary TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entries_library_created
  ON entries(library_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_library_updated
  ON entries(library_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_entries_search
  ON entries(search_text);

CREATE TABLE IF NOT EXISTS entry_relations (
  id TEXT PRIMARY KEY NOT NULL,
  source_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  target_entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  source_library_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source_entry_id, target_entry_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_relations_source
  ON entry_relations(source_entry_id, field_key);

CREATE INDEX IF NOT EXISTS idx_relations_target
  ON entry_relations(target_entry_id);

CREATE TABLE IF NOT EXISTS dashboard_widgets (
  id TEXT PRIMARY KEY NOT NULL,
  library_slug TEXT,
  title TEXT NOT NULL,
  subtitle TEXT,
  chart_type TEXT NOT NULL,
  readonly_sql TEXT NOT NULL,
  x_key TEXT,
  y_key TEXT NOT NULL,
  unit_prefix TEXT,
  unit_suffix TEXT,
  accent_tone TEXT NOT NULL DEFAULT 'teal',
  pinned_overview INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  action_summary TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

/**
 * 初始化核心 SQLite 表结构并写入当前 schema 版本号
 */
export function initCoreSchema(driver: SyncSqlDriver): void {
  driver.withTransactionSync(() => {
    driver.execSync(CORE_SCHEMA_SQL);
    const row = driver.getFirstSync<{ user_version: number }>('PRAGMA user_version');
    if (Number(row?.user_version ?? 0) < LATEST_SCHEMA_VERSION) {
      driver.execSync(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    }
  });
}
