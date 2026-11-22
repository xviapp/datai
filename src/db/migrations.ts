import type { SyncSqlDriver } from './types';

export const CORE_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS libraries (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon TEXT NOT NULL DEFAULT '📦',
  color TEXT NOT NULL DEFAULT 'teal',
  fields_json TEXT NOT NULL,
  views_json TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

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

export function runCoreMigrations(driver: SyncSqlDriver): void {
  driver.execSync(CORE_MIGRATION_SQL);
}
