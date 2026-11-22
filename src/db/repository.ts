import { evaluateFormula, evaluateHighlightRules, type EvaluatedHighlight } from '@/engine/formula';
import { createId } from '@/engine/id';
import { buildEntryPayloadValidator, type FieldDef } from '@/schema/field-defs';
import {
  type AccentTone,
  type ArchitectPlan,
  type DashboardWidget,
  type DraftEntryItem,
  type LibraryBlueprint,
  type LibraryLayoutBundle,
} from '@/schema/view-dsl';
import { runCoreMigrations } from './migrations';
import { buildDefaultSeedBundle } from './seed-templates';
import type { SyncSqlDriver } from './types';
import {
  buildDatabaseCatalogPrompt,
  compileLibrarySqlView,
  dropLibrarySqlView,
  type LibraryCatalogItem,
} from './view-compiler';

export interface LibraryRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: AccentTone;
  fields: FieldDef[];
  views: LibraryLayoutBundle;
  entryCount: number;
  updatedAt: number;
}

export interface LinkedEntryRef {
  id: string;
  title: string;
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  libraryIcon: string;
  fieldKey: string;
}

export interface HydratedEntry {
  id: string;
  libraryId: string;
  librarySlug: string;
  titleSummary: string;
  rawData: Record<string, unknown>;
  /** 合并了 Rollup 聚合值与 Formula 计算值之后的完整字段字典 */
  computedData: Record<string, unknown>;
  /** 正向关联解析出的记录标签映射：fieldKey -> LinkedEntryRef[] */
  forwardLinks: Record<string, LinkedEntryRef[]>;
  /** 反向引用该记录的所有其它库条目（双向反链 Backlinks） */
  backlinks: LinkedEntryRef[];
  highlight: EvaluatedHighlight | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiSnapshotItem {
  id: string;
  actionSummary: string;
  undone: boolean;
  createdAt: number;
}

export interface SavedDashboardWidget extends DashboardWidget {
  librarySlug: string | null;
  pinnedOverview: boolean;
  sortOrder: number;
}

export interface FullBackupBundle {
  version: 1;
  exportedAt: string;
  libraries: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
  widgets: Array<Record<string, unknown>>;
}

type ChangeListener = () => void;

export class OmniRepository {
  private driver: SyncSqlDriver;
  private listeners = new Set<ChangeListener>();

  constructor(driver: SyncSqlDriver) {
    this.driver = driver;
    runCoreMigrations(this.driver);
    this.ensureViewsCompiled();
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  private ensureViewsCompiled(): void {
    const rows = this.driver.getAllSync<{
      id: string;
      slug: string;
      fields_json: string;
    }>('SELECT id, slug, fields_json FROM libraries');
    for (const r of rows) {
      try {
        const fields = JSON.parse(r.fields_json) as FieldDef[];
        compileLibrarySqlView(this.driver, r.id, r.slug, fields);
      } catch {
        // ignore corrupted custom view
      }
    }
  }

  seedIfEmpty(): void {
    const existing = this.driver.getFirstSync<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM libraries');
    if (existing && existing.cnt > 0) {
      // 平滑更新旧版预置看板的技术型副标题，不影响用户自定义图表
      this.driver.runSync(
        "UPDATE dashboard_widgets SET title = '账单累计支出', subtitle = '全部账单合计' WHERE id = 'w_total_bills' AND subtitle = '实时聚合 v_daily_bills'"
      );
      this.driver.runSync(
        "UPDATE dashboard_widgets SET title = '装备净投入', subtitle = '购入价减去预估残值' WHERE id = 'w_asset_net' AND subtitle = '购入总价减去预估二手残值'"
      );
      this.driver.runSync(
        "UPDATE dashboard_widgets SET subtitle = '按分类查看支出占比' WHERE id = 'w_bills_by_cat' AND subtitle = '按分类统计累计开销占比'"
      );
      this.driver.runSync(
        "UPDATE dashboard_widgets SET title = '装备总投入排行', subtitle = '含本体购入价与相关配件账单' WHERE id = 'w_asset_compare' AND subtitle LIKE '%JOIN%'"
      );
      return;
    }

    const seed = buildDefaultSeedBundle();
    this.driver.withTransactionSync(() => {
      const refToEntryId = new Map<string, string>();

      for (let idx = 0; idx < seed.libraries.length; idx++) {
        this.upsertLibraryInternal(seed.libraries[idx], idx);
      }

      // 先插入被引用库，再插入引用库，按顺序解析 @ref:xxx
      for (const lib of seed.libraries) {
        const items = seed.entriesBySlug[lib.slug] ?? [];
        items.forEach((item, idx) => {
          const resolvedData: Record<string, unknown> = { ...item.data };
          for (const [k, v] of Object.entries(resolvedData)) {
            if (Array.isArray(v)) {
              resolvedData[k] = v
                .map((token) =>
                  typeof token === 'string' && token.startsWith('@ref:')
                    ? refToEntryId.get(token.slice(5)) ?? ''
                    : String(token)
                )
                .filter(Boolean);
            }
          }
          const createdId = this.createEntryInternal(
            lib.slug,
            resolvedData,
            Date.now() - (items.length - idx) * 60_000
          );
          if (item.tempRef) {
            refToEntryId.set(item.tempRef, createdId);
          }
        });
      }

      seed.widgets.forEach((w, idx) => {
        this.saveDashboardWidgetInternal(w, null, idx);
      });
    });

    this.notify();
  }

  listLibraries(): LibraryRecord[] {
    const rows = this.driver.getAllSync<{
      id: string;
      slug: string;
      name: string;
      description: string;
      icon: string;
      color: AccentTone;
      fields_json: string;
      views_json: string;
      updated_at: number;
      entry_count: number;
    }>(`
      SELECT
        l.*,
        (SELECT COUNT(*) FROM entries e WHERE e.library_id = l.id) AS entry_count
      FROM libraries l
      ORDER BY l.sort_order ASC, l.created_at ASC
    `);

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      icon: r.icon,
      color: r.color,
      fields: JSON.parse(r.fields_json) as FieldDef[],
      views: JSON.parse(r.views_json) as LibraryLayoutBundle,
      entryCount: Number(r.entry_count ?? 0),
      updatedAt: r.updated_at,
    }));
  }

  getLibraryBySlug(slug: string): LibraryRecord | null {
    const libs = this.listLibraries();
    return libs.find((l) => l.slug === slug) ?? null;
  }

  private upsertLibraryInternal(bp: LibraryBlueprint, sortOrder?: number): string {
    const now = Date.now();
    const existing = this.driver.getFirstSync<{ id: string; sort_order: number }>(
      'SELECT id, sort_order FROM libraries WHERE slug = ?',
      [bp.slug]
    );

    const id = existing ? existing.id : createId('lib');
    let order = sortOrder ?? existing?.sort_order;
    if (order === undefined) {
      const maxRow = this.driver.getFirstSync<{ max_order: number | null }>(
        'SELECT MAX(sort_order) AS max_order FROM libraries'
      );
      order = (maxRow?.max_order ?? -1) + 1;
    }

    if (existing) {
      this.driver.runSync(
        `UPDATE libraries
         SET name = ?, description = ?, icon = ?, color = ?, fields_json = ?, views_json = ?, updated_at = ?
         WHERE id = ?`,
        [
          bp.name,
          bp.description ?? '',
          bp.icon || '📦',
          bp.color || 'teal',
          JSON.stringify(bp.fields),
          JSON.stringify(bp.views),
          now,
          id,
        ]
      );
    } else {
      this.driver.runSync(
        `INSERT INTO libraries (id, slug, name, description, icon, color, fields_json, views_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          bp.slug,
          bp.name,
          bp.description ?? '',
          bp.icon || '📦',
          bp.color || 'teal',
          JSON.stringify(bp.fields),
          JSON.stringify(bp.views),
          order,
          now,
          now,
        ]
      );
    }

    compileLibrarySqlView(this.driver, id, bp.slug, bp.fields);
    return id;
  }

  upsertLibrary(bp: LibraryBlueprint): string {
    const id = this.driver.withTransactionSync(() => this.upsertLibraryInternal(bp));
    this.notify();
    return id;
  }

  deleteLibrary(slug: string): void {
    const target = this.getLibraryBySlug(slug);
    const backupBefore = this.exportBackupBundle();

    this.driver.withTransactionSync(() => {
      if (target) {
        this.saveSnapshotInternal(`删除记录本「${target.name}」`, backupBefore);
      }
      dropLibrarySqlView(this.driver, slug);
      this.driver.runSync(
        'DELETE FROM dashboard_widgets WHERE library_slug = ? OR readonly_sql LIKE ?',
        [slug, `%v_${slug}%`]
      );
      this.driver.runSync('DELETE FROM libraries WHERE slug = ?', [slug]);
    });
    this.notify();
  }

  private computeTitleAndSearch(lib: LibraryRecord, data: Record<string, unknown>): {
    titleSummary: string;
    searchText: string;
  } {
    const titleKey = lib.views.card.titleFieldKey || lib.fields[0]?.key || '';
    const rawTitle = data[titleKey];
    const titleSummary =
      rawTitle !== undefined && rawTitle !== null && String(rawTitle).trim() !== ''
        ? String(rawTitle)
        : `${lib.name}记录`;

    const parts: string[] = [titleSummary];
    for (const v of Object.values(data)) {
      if (typeof v === 'string' || typeof v === 'number') {
        parts.push(String(v));
      } else if (Array.isArray(v)) {
        parts.push(v.join(' '));
      }
    }
    return { titleSummary, searchText: parts.join(' ').toLowerCase() };
  }

  private syncEntryRelationsInternal(
    entryId: string,
    libraryId: string,
    fields: FieldDef[],
    data: Record<string, unknown>
  ): void {
    this.driver.runSync('DELETE FROM entry_relations WHERE source_entry_id = ?', [entryId]);

    for (const f of fields) {
      if (f.type !== 'relation') continue;
      const rawTargets = data[f.key];
      const targets = Array.isArray(rawTargets)
        ? rawTargets.map(String).filter(Boolean)
        : typeof rawTargets === 'string' && rawTargets.trim()
          ? [rawTargets.trim()]
          : [];

      targets.forEach((targetId, idx) => {
        // 仅关联真实存在的目标条目，防止脏外键报错
        const exists = this.driver.getFirstSync<{ id: string }>('SELECT id FROM entries WHERE id = ?', [
          targetId,
        ]);
        if (exists) {
          this.driver.runSync(
            `INSERT OR IGNORE INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [createId('rel'), entryId, targetId, libraryId, f.key, idx]
          );
        }
      });
    }
  }

  private createEntryInternal(
    librarySlug: string,
    inputData: Record<string, unknown>,
    customTimestamp?: number
  ): string {
    const lib = this.getLibraryBySlug(librarySlug);
    if (!lib) {
      throw new Error(`找不到数据表: ${librarySlug}`);
    }

    const validator = buildEntryPayloadValidator(lib.fields);
    const parsed = validator.parse(inputData) as Record<string, unknown>;
    const { titleSummary, searchText } = this.computeTitleAndSearch(lib, parsed);
    const now = customTimestamp ?? Date.now();
    const id = createId('ent');

    this.driver.runSync(
      `INSERT INTO entries (id, library_id, title_summary, search_text, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, lib.id, titleSummary, searchText, JSON.stringify(parsed), now, now]
    );

    this.syncEntryRelationsInternal(id, lib.id, lib.fields, parsed);
    return id;
  }

  createEntry(librarySlug: string, inputData: Record<string, unknown>): string {
    const id = this.driver.withTransactionSync(() => this.createEntryInternal(librarySlug, inputData));
    this.notify();
    return id;
  }

  updateEntry(entryId: string, inputData: Record<string, unknown>): void {
    this.driver.withTransactionSync(() => {
      const existing = this.driver.getFirstSync<{ library_id: string }>(
        'SELECT library_id FROM entries WHERE id = ?',
        [entryId]
      );
      if (!existing) throw new Error('记录不存在');

      const libRow = this.driver.getFirstSync<{ slug: string }>(
        'SELECT slug FROM libraries WHERE id = ?',
        [existing.library_id]
      );
      if (!libRow) throw new Error('所属库不存在');

      const lib = this.getLibraryBySlug(libRow.slug)!;
      const validator = buildEntryPayloadValidator(lib.fields);
      const parsed = validator.parse(inputData) as Record<string, unknown>;
      const { titleSummary, searchText } = this.computeTitleAndSearch(lib, parsed);

      this.driver.runSync(
        `UPDATE entries
         SET title_summary = ?, search_text = ?, data_json = ?, updated_at = ?
         WHERE id = ?`,
        [titleSummary, searchText, JSON.stringify(parsed), Date.now(), entryId]
      );

      this.syncEntryRelationsInternal(entryId, lib.id, lib.fields, parsed);
    });
    this.notify();
  }

  deleteEntry(entryId: string): void {
    this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
    this.notify();
  }

  /**
   * 批量提交 AI 万能快记跨库草稿（支持 "@prev:0" 引用同一事务内前序新建条目）
   */
  commitOmniDrafts(drafts: DraftEntryItem[], snapshotNote?: string): string[] {
    const createdIds: string[] = [];
    const backup = snapshotNote ? this.exportBackupBundle() : null;

    this.driver.withTransactionSync(() => {
      if (backup && snapshotNote) {
        this.saveSnapshotInternal(snapshotNote, backup);
      }

      drafts.forEach((draft) => {
        const resolved: Record<string, unknown> = { ...draft.data };
        for (const [k, v] of Object.entries(resolved)) {
          if (Array.isArray(v)) {
            resolved[k] = v
              .map((item) => {
                if (typeof item === 'string' && item.startsWith('@prev:')) {
                  const idx = Number(item.slice(6));
                  return createdIds[idx] ?? '';
                }
                return String(item);
              })
              .filter(Boolean);
          } else if (typeof v === 'string' && v.startsWith('@prev:')) {
            const idx = Number(v.slice(6));
            resolved[k] = createdIds[idx] ? [createdIds[idx]] : [];
          }
        }
        const newId = this.createEntryInternal(draft.librarySlug, resolved);
        createdIds.push(newId);
      });
    });

    this.notify();
    return createdIds;
  }

  /**
   * 读取并完整水合（Hydrate）某个库的全部条目：包含双向关联、Rollup 跨表汇总、Formula 行内公式与条件着色
   */
  listHydratedEntries(librarySlug: string, searchQuery?: string): HydratedEntry[] {
    const lib = this.getLibraryBySlug(librarySlug);
    if (!lib) return [];

    const allLibsById = new Map(this.listLibraries().map((l) => [l.id, l]));
    const allLibsBySlug = new Map(this.listLibraries().map((l) => [l.slug, l]));

    const sql = searchQuery?.trim()
      ? `SELECT * FROM entries WHERE library_id = ? AND search_text LIKE ? ORDER BY created_at DESC`
      : `SELECT * FROM entries WHERE library_id = ? ORDER BY created_at DESC`;
    const params = searchQuery?.trim()
      ? [lib.id, `%${searchQuery.trim().toLowerCase()}%`]
      : [lib.id];

    const rows = this.driver.getAllSync<{
      id: string;
      library_id: string;
      title_summary: string;
      data_json: string;
      created_at: number;
      updated_at: number;
    }>(sql, params);

    const hydrated = rows.map((row) =>
      this.hydrateSingleRow(row, lib, allLibsById, allLibsBySlug)
    );

    // 根据视图配置的排序规则排序
    const sortKey = lib.views.card.sortFieldKey;
    const sortDir = lib.views.card.sortDir ?? 'desc';
    if (sortKey) {
      hydrated.sort((a, b) => {
        const va = a.computedData[sortKey];
        const vb = b.computedData[sortKey];
        if (va === vb) return b.createdAt - a.createdAt;
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortDir === 'asc' ? va - vb : vb - va;
        }
        const cmp = String(va ?? '').localeCompare(String(vb ?? ''));
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return hydrated;
  }

  getHydratedEntryById(entryId: string): { entry: HydratedEntry; library: LibraryRecord } | null {
    const row = this.driver.getFirstSync<{
      id: string;
      library_id: string;
      title_summary: string;
      data_json: string;
      created_at: number;
      updated_at: number;
    }>('SELECT * FROM entries WHERE id = ?', [entryId]);
    if (!row) return null;

    const libs = this.listLibraries();
    const allLibsById = new Map(libs.map((l) => [l.id, l]));
    const allLibsBySlug = new Map(libs.map((l) => [l.slug, l]));
    const lib = allLibsById.get(row.library_id);
    if (!lib) return null;

    return {
      library: lib,
      entry: this.hydrateSingleRow(row, lib, allLibsById, allLibsBySlug),
    };
  }

  private hydrateSingleRow(
    row: {
      id: string;
      library_id: string;
      title_summary: string;
      data_json: string;
      created_at: number;
      updated_at: number;
    },
    lib: LibraryRecord,
    allLibsById: Map<string, LibraryRecord>,
    allLibsBySlug: Map<string, LibraryRecord>
  ): HydratedEntry {
    const rawData = JSON.parse(row.data_json) as Record<string, unknown>;
    const computedData: Record<string, unknown> = { ...rawData };

    // 1. 正向关联查询
    const forwardRows = this.driver.getAllSync<{
      field_key: string;
      target_id: string;
      target_title: string;
      target_lib_id: string;
      target_data_json: string;
    }>(
      `SELECT
         r.field_key,
         t.id AS target_id,
         t.title_summary AS target_title,
         t.library_id AS target_lib_id,
         t.data_json AS target_data_json
       FROM entry_relations r
       JOIN entries t ON t.id = r.target_entry_id
       WHERE r.source_entry_id = ?
       ORDER BY r.sort_order ASC`,
      [row.id]
    );

    const forwardLinks: Record<string, LinkedEntryRef[]> = {};
    const forwardTargetPayloads: Record<string, Array<Record<string, unknown>>> = {};

    for (const fr of forwardRows) {
      const targetLib = allLibsById.get(fr.target_lib_id);
      if (!targetLib) continue;
      if (!forwardLinks[fr.field_key]) forwardLinks[fr.field_key] = [];
      if (!forwardTargetPayloads[fr.field_key]) forwardTargetPayloads[fr.field_key] = [];

      forwardLinks[fr.field_key].push({
        id: fr.target_id,
        title: fr.target_title,
        libraryId: targetLib.id,
        librarySlug: targetLib.slug,
        libraryName: targetLib.name,
        libraryIcon: targetLib.icon,
        fieldKey: fr.field_key,
      });
      forwardTargetPayloads[fr.field_key].push(JSON.parse(fr.target_data_json));
    }

    // 2. 反向引用查询（Backlinks）
    const backRows = this.driver.getAllSync<{
      field_key: string;
      source_id: string;
      source_title: string;
      source_lib_id: string;
      source_data_json: string;
    }>(
      `SELECT
         r.field_key,
         s.id AS source_id,
         s.title_summary AS source_title,
         s.library_id AS source_lib_id,
         s.data_json AS source_data_json
       FROM entry_relations r
       JOIN entries s ON s.id = r.source_entry_id
       WHERE r.target_entry_id = ?
       ORDER BY s.created_at DESC`,
      [row.id]
    );

    const backlinks: LinkedEntryRef[] = [];
    const reversePayloadsByKey: Record<string, Array<Record<string, unknown>>> = {};

    for (const br of backRows) {
      const srcLib = allLibsById.get(br.source_lib_id);
      if (!srcLib) continue;
      backlinks.push({
        id: br.source_id,
        title: br.source_title,
        libraryId: srcLib.id,
        librarySlug: srcLib.slug,
        libraryName: srcLib.name,
        libraryIcon: srcLib.icon,
        fieldKey: br.field_key,
      });
      const revKey = `reverse:${srcLib.slug}.${br.field_key}`;
      if (!reversePayloadsByKey[revKey]) reversePayloadsByKey[revKey] = [];
      reversePayloadsByKey[revKey].push(JSON.parse(br.source_data_json));
    }

    // 3. 计算 Rollup 汇总字段（支持正向 relationFieldKey 与反向 reverse:<slug>.<fieldKey>）
    for (const field of lib.fields) {
      if (field.type !== 'rollup' || !field.rollupConfig) continue;
      const { relationFieldKey, targetFieldKey, fn } = field.rollupConfig;

      let payloads: Array<Record<string, unknown>> = [];
      if (relationFieldKey.startsWith('reverse:')) {
        payloads = reversePayloadsByKey[relationFieldKey] ?? [];
      } else if (allLibsBySlug.has(relationFieldKey)) {
        // 容错：若 AI 直接填了源库 slug，匹配所有来自该库的反向引用
        const prefix = `reverse:${relationFieldKey}.`;
        for (const [rk, list] of Object.entries(reversePayloadsByKey)) {
          if (rk.startsWith(prefix)) payloads.push(...list);
        }
      } else {
        payloads = forwardTargetPayloads[relationFieldKey] ?? [];
      }

      if (fn === 'COUNT') {
        computedData[field.key] = payloads.length;
        continue;
      }

      const nums = payloads
        .map((p) => Number(p[targetFieldKey]))
        .filter((n) => Number.isFinite(n));

      if (nums.length === 0) {
        computedData[field.key] = 0;
      } else if (fn === 'SUM') {
        computedData[field.key] = Math.round(nums.reduce((a, b) => a + b, 0) * 100) / 100;
      } else if (fn === 'AVG') {
        computedData[field.key] =
          Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
      } else if (fn === 'MIN') {
        computedData[field.key] = Math.min(...nums);
      } else if (fn === 'MAX') {
        computedData[field.key] = Math.max(...nums);
      }
    }

    // 4. 计算行内 Formula 字段（可引用基础字段与刚算出的 Rollup 字段）
    for (const field of lib.fields) {
      if (field.type !== 'formula' || !field.formulaExpr) continue;
      computedData[field.key] = evaluateFormula(field.formulaExpr, computedData);
    }

    // 5. 计算条件高亮规则
    const highlight = evaluateHighlightRules(lib.views.card.highlightRules, computedData);

    return {
      id: row.id,
      libraryId: row.library_id,
      librarySlug: lib.slug,
      titleSummary: row.title_summary,
      rawData,
      computedData,
      forwardLinks,
      backlinks,
      highlight,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 看板组件 CRUD 与离线实时求值
   */
  listDashboardWidgets(librarySlug?: string | null): DashboardWidget[] {
    const rows = librarySlug
      ? this.driver.getAllSync<{
          id: string;
          title: string;
          subtitle: string | null;
          chart_type: DashboardWidget['chartType'];
          readonly_sql: string;
          x_key: string | null;
          y_key: string;
          unit_prefix: string | null;
          unit_suffix: string | null;
          accent_tone: AccentTone;
        }>(
          'SELECT * FROM dashboard_widgets WHERE library_slug = ? ORDER BY sort_order ASC, created_at ASC',
          [librarySlug]
        )
      : this.driver.getAllSync<{
          id: string;
          title: string;
          subtitle: string | null;
          chart_type: DashboardWidget['chartType'];
          readonly_sql: string;
          x_key: string | null;
          y_key: string;
          unit_prefix: string | null;
          unit_suffix: string | null;
          accent_tone: AccentTone;
        }>(
          'SELECT * FROM dashboard_widgets WHERE library_slug IS NULL ORDER BY sort_order ASC, created_at ASC'
        );

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      chartType: r.chart_type,
      readonlySql: r.readonly_sql,
      xKey: r.x_key ?? undefined,
      yKey: r.y_key,
      unitPrefix: r.unit_prefix ?? undefined,
      unitSuffix: r.unit_suffix ?? undefined,
      accentTone: r.accent_tone,
    }));
  }

  listAllDashboardWidgets(): SavedDashboardWidget[] {
    const rows = this.driver.getAllSync<{
      id: string;
      library_slug: string | null;
      title: string;
      subtitle: string | null;
      chart_type: DashboardWidget['chartType'];
      readonly_sql: string;
      x_key: string | null;
      y_key: string;
      unit_prefix: string | null;
      unit_suffix: string | null;
      accent_tone: AccentTone;
      pinned_overview: number;
      sort_order: number;
    }>('SELECT * FROM dashboard_widgets ORDER BY sort_order ASC, created_at ASC');

    return rows.map((r) => ({
      id: r.id,
      librarySlug: r.library_slug ?? null,
      title: r.title,
      subtitle: r.subtitle ?? undefined,
      chartType: r.chart_type,
      readonlySql: r.readonly_sql,
      xKey: r.x_key ?? undefined,
      yKey: r.y_key,
      unitPrefix: r.unit_prefix ?? undefined,
      unitSuffix: r.unit_suffix ?? undefined,
      accentTone: r.accent_tone,
      pinnedOverview: r.pinned_overview !== 0,
      sortOrder: Number(r.sort_order ?? 0),
    }));
  }

  listWidgetsForLibrary(slug: string): SavedDashboardWidget[] {
    const all = this.listAllDashboardWidgets();
    const viewToken = `v_${slug}`;
    return all.filter(
      (w) => w.librarySlug === slug || w.readonlySql.includes(viewToken)
    );
  }

  private saveDashboardWidgetInternal(
    w: DashboardWidget,
    librarySlug: string | null = null,
    sortOrder?: number,
    pinnedOverview = true
  ): void {
    const id = w.id || createId('wdg');
    let order = sortOrder;
    if (order === undefined) {
      const maxRow = this.driver.getFirstSync<{ max_order: number | null }>(
        'SELECT MAX(sort_order) AS max_order FROM dashboard_widgets'
      );
      order = (maxRow?.max_order ?? -1) + 1;
    }
    this.driver.runSync(
      `INSERT OR REPLACE INTO dashboard_widgets
       (id, library_slug, title, subtitle, chart_type, readonly_sql, x_key, y_key, unit_prefix, unit_suffix, accent_tone, pinned_overview, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        librarySlug,
        w.title,
        w.subtitle ?? null,
        w.chartType,
        w.readonlySql,
        w.xKey ?? null,
        w.yKey,
        w.unitPrefix ?? null,
        w.unitSuffix ?? null,
        w.accentTone ?? 'teal',
        pinnedOverview ? 1 : 0,
        order,
        Date.now(),
      ]
    );
  }

  saveDashboardWidget(w: DashboardWidget, librarySlug: string | null = null): void {
    // 落盘前先在只读沙盒预执行校验一次 SQL 合法性
    this.driver.queryReadOnlySync(w.readonlySql);
    this.saveDashboardWidgetInternal(w, librarySlug);
    this.notify();
  }

  setWidgetPinnedOverview(widgetId: string, pinned: boolean): void {
    this.driver.runSync('UPDATE dashboard_widgets SET pinned_overview = ? WHERE id = ?', [
      pinned ? 1 : 0,
      widgetId,
    ]);
    this.notify();
  }

  moveDashboardWidget(
    widgetId: string,
    direction: 'up' | 'down',
    scopeIds: string[]
  ): void {
    const scopeIdx = scopeIds.indexOf(widgetId);
    if (scopeIdx < 0) return;
    const neighborIdx = direction === 'up' ? scopeIdx - 1 : scopeIdx + 1;
    if (neighborIdx < 0 || neighborIdx >= scopeIds.length) return;

    const neighborId = scopeIds[neighborIdx];
    const allIds = this.listAllDashboardWidgets().map((w) => w.id);
    const fromGlobal = allIds.indexOf(widgetId);
    const toGlobal = allIds.indexOf(neighborId);
    if (fromGlobal < 0 || toGlobal < 0) return;

    const nextIds = [...allIds];
    nextIds.splice(fromGlobal, 1);
    const insertAt = nextIds.indexOf(neighborId);
    if (insertAt < 0) return;
    nextIds.splice(direction === 'up' ? insertAt : insertAt + 1, 0, widgetId);

    this.driver.withTransactionSync(() => {
      nextIds.forEach((id, idx) => {
        this.driver.runSync('UPDATE dashboard_widgets SET sort_order = ? WHERE id = ?', [idx, id]);
      });
    });
    this.notify();
  }

  deleteDashboardWidget(widgetId: string): void {
    this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [widgetId]);
    this.notify();
  }

  executeReadOnlyQuery(sql: string): Array<Record<string, unknown>> {
    return this.driver.queryReadOnlySync(sql);
  }

  /**
   * AI 建筑师方案应用（自动保存全量回滚点快照 + 创建/更新多表 + 创建看板组件）
   */
  applyArchitectPlan(plan: ArchitectPlan): string {
    const backupBefore = this.exportBackupBundle();
    let snapshotId = '';

    // 先提交表结构与视图变更，再使用独立只读连接校验并保存看板图表
    this.driver.withTransactionSync(() => {
      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', backupBefore);

      plan.libraries.forEach((bp) => {
        this.upsertLibraryInternal(bp);
      });
    });

    if (plan.dashboardWidgets.length > 0) {
      plan.dashboardWidgets.forEach((w, idx) => {
        try {
          this.driver.queryReadOnlySync(w.readonlySql);
          this.saveDashboardWidgetInternal(w, null, 50 + idx);
        } catch {
          // 跳过语法有误的可选图表，不阻塞主模型创建
        }
      });
    }

    this.notify();
    return snapshotId;
  }

  private saveSnapshotInternal(summary: string, bundle: FullBackupBundle): string {
    const id = createId('snap');
    this.driver.runSync(
      `INSERT INTO ai_snapshots (id, action_summary, snapshot_json, undone, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [id, summary, JSON.stringify(bundle), Date.now()]
    );
    return id;
  }

  listSnapshots(): AiSnapshotItem[] {
    const rows = this.driver.getAllSync<{
      id: string;
      action_summary: string;
      undone: number;
      created_at: number;
    }>('SELECT id, action_summary, undone, created_at FROM ai_snapshots ORDER BY created_at DESC LIMIT 20');

    return rows.map((r) => ({
      id: r.id,
      actionSummary: r.action_summary,
      undone: Boolean(r.undone),
      createdAt: r.created_at,
    }));
  }

  undoSnapshot(snapshotId: string): void {
    const row = this.driver.getFirstSync<{ snapshot_json: string; undone: number }>(
      'SELECT snapshot_json, undone FROM ai_snapshots WHERE id = ?',
      [snapshotId]
    );
    if (!row || row.undone) {
      throw new Error('该快照不存在或已撤销');
    }

    const bundle = JSON.parse(row.snapshot_json) as FullBackupBundle;
    this.importBackupBundle(bundle, false);
    this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE id = ?', [snapshotId]);
    this.notify();
  }

  /**
   * 导出/导入完整纯单机离线快照包
   */
  exportBackupBundle(): FullBackupBundle {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      libraries: this.driver.getAllSync('SELECT * FROM libraries ORDER BY sort_order ASC'),
      entries: this.driver.getAllSync('SELECT * FROM entries ORDER BY created_at ASC'),
      relations: this.driver.getAllSync('SELECT * FROM entry_relations'),
      widgets: this.driver.getAllSync('SELECT * FROM dashboard_widgets ORDER BY sort_order ASC'),
    };
  }

  importBackupBundle(bundle: FullBackupBundle, shouldNotify = true): void {
    this.driver.withTransactionSync(() => {
      // 清理旧逻辑视图
      const oldLibs = this.driver.getAllSync<{ slug: string }>('SELECT slug FROM libraries');
      for (const l of oldLibs) {
        dropLibrarySqlView(this.driver, l.slug);
      }

      this.driver.execSync('DELETE FROM entry_relations;');
      this.driver.execSync('DELETE FROM entries;');
      this.driver.execSync('DELETE FROM dashboard_widgets;');
      this.driver.execSync('DELETE FROM libraries;');

      for (const l of bundle.libraries) {
        this.driver.runSync(
          `INSERT INTO libraries (id, slug, name, description, icon, color, fields_json, views_json, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(l.id),
            String(l.slug),
            String(l.name),
            String(l.description ?? ''),
            String(l.icon ?? '📦'),
            String(l.color ?? 'teal'),
            String(l.fields_json),
            String(l.views_json),
            Number(l.sort_order ?? 0),
            Number(l.created_at ?? Date.now()),
            Number(l.updated_at ?? Date.now()),
          ]
        );
      }

      for (const e of bundle.entries) {
        this.driver.runSync(
          `INSERT INTO entries (id, library_id, title_summary, search_text, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            String(e.id),
            String(e.library_id),
            String(e.title_summary ?? ''),
            String(e.search_text ?? ''),
            String(e.data_json),
            Number(e.created_at ?? Date.now()),
            Number(e.updated_at ?? Date.now()),
          ]
        );
      }

      for (const r of bundle.relations) {
        this.driver.runSync(
          `INSERT INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            String(r.id),
            String(r.source_entry_id),
            String(r.target_entry_id),
            String(r.source_library_id),
            String(r.field_key),
            Number(r.sort_order ?? 0),
          ]
        );
      }

      for (const w of bundle.widgets) {
        this.driver.runSync(
          `INSERT INTO dashboard_widgets (id, library_slug, title, subtitle, chart_type, readonly_sql, x_key, y_key, unit_prefix, unit_suffix, accent_tone, pinned_overview, sort_order, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            String(w.id),
            w.library_slug ? String(w.library_slug) : null,
            String(w.title),
            w.subtitle ? String(w.subtitle) : null,
            String(w.chart_type),
            String(w.readonly_sql),
            w.x_key ? String(w.x_key) : null,
            String(w.y_key),
            w.unit_prefix ? String(w.unit_prefix) : null,
            w.unit_suffix ? String(w.unit_suffix) : null,
            String(w.accent_tone ?? 'teal'),
            w.pinned_overview === undefined ? 1 : Number(w.pinned_overview),
            Number(w.sort_order ?? 0),
            Number(w.created_at ?? Date.now()),
          ]
        );
      }

      this.ensureViewsCompiled();
    });

    if (shouldNotify) {
      this.notify();
    }
  }

  /**
   * 构造发往 deepseek-flash 的精简上下文目录（含各库最近 30 条记录 ID 供外键消歧）
   */
  getAiCatalogPrompt(includeEntryCandidates = false): string {
    const libs = this.listLibraries();
    const items: LibraryCatalogItem[] = libs.map((l) => {
      const recentEntries = includeEntryCandidates
        ? this.driver
            .getAllSync<{ id: string; title_summary: string }>(
              'SELECT id, title_summary FROM entries WHERE library_id = ? ORDER BY updated_at DESC LIMIT 30',
              [l.id]
            )
            .map((r) => ({ id: r.id, title: r.title_summary }))
        : undefined;

      return {
        id: l.id,
        slug: l.slug,
        name: l.name,
        description: l.description,
        icon: l.icon,
        fields: l.fields,
        recentEntries,
      };
    });

    return buildDatabaseCatalogPrompt(items);
  }

  /**
   * 列表选择关联目标候选集
   */
  listRelationCandidates(targetLibrarySlug: string): Array<{ id: string; title: string }> {
    const lib = this.getLibraryBySlug(targetLibrarySlug);
    if (!lib) return [];
    return this.driver
      .getAllSync<{ id: string; title_summary: string }>(
        'SELECT id, title_summary FROM entries WHERE library_id = ? ORDER BY updated_at DESC LIMIT 200',
        [lib.id]
      )
      .map((r) => ({ id: r.id, title: r.title_summary }));
  }
}
