import type { SyncSqlDriver } from './types';

export const LATEST_SCHEMA_VERSION = 3;
export const MAX_AI_SNAPSHOTS = 20;

export const CORE_MIGRATION_SQL = `
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

function getUserVersion(driver: SyncSqlDriver): number {
  const row = driver.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  return Number(row?.user_version ?? 0);
}

/**
 * 使用 SQLite 原生 PRAGMA user_version 按版本号顺序执行增量迁移
 */
export function runCoreMigrations(driver: SyncSqlDriver): void {
  driver.withTransactionSync(() => {
    driver.execSync(CORE_MIGRATION_SQL);

    let version = getUserVersion(driver);

    if (version < 1) {
      // v1: 补齐旧版 dashboard_widgets.pinned_overview 列，并一次性迁移旧版预置看板副标题
      const cols = driver.getAllSync<{ name: string }>('PRAGMA table_info(dashboard_widgets)');
      if (!cols.some((c) => c.name === 'pinned_overview')) {
        driver.execSync(
          'ALTER TABLE dashboard_widgets ADD COLUMN pinned_overview INTEGER NOT NULL DEFAULT 1;'
        );
      }

      driver.runSync(
        "UPDATE dashboard_widgets SET title = '账单累计支出', subtitle = '全部账单合计' WHERE id = 'w_total_bills' AND subtitle = '实时聚合 v_daily_bills'"
      );
      driver.runSync(
        "UPDATE dashboard_widgets SET title = '装备净投入', subtitle = '购入价减去预估残值' WHERE id = 'w_asset_net' AND subtitle = '购入总价减去预估二手残值'"
      );
      driver.runSync(
        "UPDATE dashboard_widgets SET subtitle = '按分类查看支出占比' WHERE id = 'w_bills_by_cat' AND subtitle = '按分类统计累计开销占比'"
      );
      driver.runSync(
        "UPDATE dashboard_widgets SET title = '装备总投入排行', subtitle = '含本体购入价与相关配件账单' WHERE id = 'w_asset_compare' AND subtitle LIKE '%JOIN%'"
      );

      driver.execSync('PRAGMA user_version = 1;');
      version = 1;
    }

    if (version < 2) {
      // v2: 清理历史上混入 search_text 的 base64 图片数据，并按上限裁减历史快照
      const dirtyEntries = driver.getAllSync<{ id: string; search_text: string }>(
        "SELECT id, search_text FROM entries WHERE search_text LIKE '%data:image/%'"
      );
      for (const row of dirtyEntries) {
        const cleaned = row.search_text
          .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '')
          .replace(/\s+/g, ' ')
          .trim();
        driver.runSync('UPDATE entries SET search_text = ? WHERE id = ?', [cleaned, row.id]);
      }

      driver.runSync(
        `DELETE FROM ai_snapshots
         WHERE id NOT IN (
           SELECT id FROM ai_snapshots ORDER BY created_at DESC LIMIT ?
         )`,
        [MAX_AI_SNAPSHOTS]
      );

      driver.execSync('PRAGMA user_version = 2;');
      version = 2;
    }

    if (version < 3) {
      // v3: 为 libraries 增加主从附属标识 parent_slug 与首页显隐控制 show_on_home
      const libCols = driver.getAllSync<{ name: string }>('PRAGMA table_info(libraries)');
      if (!libCols.some((c) => c.name === 'parent_slug')) {
        driver.execSync('ALTER TABLE libraries ADD COLUMN parent_slug TEXT DEFAULT NULL;');
      }
      if (!libCols.some((c) => c.name === 'show_on_home')) {
        driver.execSync(
          'ALTER TABLE libraries ADD COLUMN show_on_home INTEGER NOT NULL DEFAULT 1;'
        );
      }

      driver.execSync(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    }
  });
}
