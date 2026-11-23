import { sqlReferencesLibraryView, type SyncSqlDriver } from './types';

export const LATEST_SCHEMA_VERSION = 4;
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

function backfillViewsAndRelationsV4(driver: SyncSqlDriver): void {
  const now = Date.now();
  const libs = driver.getAllSync<{
    id: string;
    slug: string;
    parent_slug: string | null;
    fields_json: string;
    views_json: string;
  }>('SELECT id, slug, parent_slug, fields_json, views_json FROM libraries');

  const widgets = driver.getAllSync<{ library_slug: string | null; readonly_sql: string }>(
    'SELECT library_slug, readonly_sql FROM dashboard_widgets'
  );

  const slugToId = new Map<string, string>();
  for (const lib of libs) {
    slugToId.set(lib.slug, lib.id);
  }

  for (const lib of libs) {
    // 1. 回填 library_views（仅在该库还没有视图记录时）
    const existingViewCount = driver.getFirstSync<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM library_views WHERE library_id = ?',
      [lib.id]
    );
    if (!existingViewCount || existingViewCount.cnt === 0) {
      let parsedViews: {
        card?: Record<string, unknown>;
        gallery?: Record<string, unknown>;
        calendar?: Record<string, unknown>;
      } = {};
      try {
        parsedViews = JSON.parse(lib.views_json);
      } catch {
        parsedViews = {};
      }

      let order = 0;
      driver.runSync(
        `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `vw_${lib.id}_card`,
          lib.id,
          '列表',
          'card',
          JSON.stringify(parsedViews.card ?? {}),
          order++,
          1,
          now,
          now,
        ]
      );

      if (parsedViews.gallery) {
        driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `vw_${lib.id}_gallery`,
            lib.id,
            '画廊',
            'gallery',
            JSON.stringify(parsedViews.gallery),
            order++,
            0,
            now,
            now,
          ]
        );
      }

      if (parsedViews.calendar) {
        driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `vw_${lib.id}_calendar`,
            lib.id,
            '日历',
            'calendar',
            JSON.stringify(parsedViews.calendar),
            order++,
            0,
            now,
            now,
          ]
        );
      }

      const hasWidgets = widgets.some(
        (w) => w.library_slug === lib.slug || sqlReferencesLibraryView(w.readonly_sql, lib.slug)
      );
      if (hasWidgets) {
        driver.runSync(
          `INSERT INTO library_views (id, library_id, name, view_type, config_json, sort_order, is_default, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [`vw_${lib.id}_stats`, lib.id, '统计', 'stats', '{}', order++, 0, now, now]
        );
      }
    }

    // 2. 回填 library_relations（表级关联关系）
    let parsedFields: Array<{
      key?: string;
      type?: string;
      relationConfig?: { targetLibrarySlug?: string; allowMultiple?: boolean };
    }> = [];
    try {
      parsedFields = JSON.parse(lib.fields_json);
    } catch {
      parsedFields = [];
    }

    for (const f of parsedFields) {
      if (f.type !== 'relation' || !f.key || !f.relationConfig?.targetLibrarySlug) continue;
      const targetId = slugToId.get(f.relationConfig.targetLibrarySlug);
      if (!targetId) continue;
      const relationKind =
        lib.parent_slug && f.relationConfig.targetLibrarySlug === lib.parent_slug
          ? 'parent_child'
          : 'reference';
      const allowMultiple = f.relationConfig.allowMultiple === false ? 0 : 1;
      driver.runSync(
        `INSERT OR IGNORE INTO library_relations (id, source_library_id, target_library_id, field_key, relation_kind, allow_multiple, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          `lrel_${lib.id}_${f.key}`,
          lib.id,
          targetId,
          f.key,
          relationKind,
          allowMultiple,
          now,
        ]
      );
    }
  }
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

      driver.execSync('PRAGMA user_version = 3;');
      version = 3;
    }

    if (version < 4) {
      // v4: 数据/表现/关系解耦 — 将存量视图与表间关系迁入独立的 library_views 与 library_relations 表
      backfillViewsAndRelationsV4(driver);
      driver.execSync(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION};`);
    }
  });
}
