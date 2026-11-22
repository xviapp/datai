import { evaluateFormula, evaluateHighlightRules, type EvaluatedHighlight } from '@/engine/formula';
import { createId } from '@/engine/id';
import { buildEntryPayloadValidator, type FieldDef, type FieldType } from '@/schema/field-defs';
import {
  type AccentTone,
  type ArchitectPlan,
  type DashboardWidget,
  type DraftEntryItem,
  type LibraryBlueprint,
  type LibraryLayoutBundle,
} from '@/schema/view-dsl';
import { MAX_AI_SNAPSHOTS, runCoreMigrations } from './migrations';
import { buildDefaultSeedBundle } from './seed-templates';
import {
  escapeLikePattern,
  sqlReferencesLibraryView,
  type SyncSqlDriver,
} from './types';
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

export interface EntrySearchHit {
  id: string;
  title: string;
  libraryId: string;
  librarySlug: string;
  libraryName: string;
  libraryIcon: string;
}

export interface AiSnapshotItem {
  id: string;
  actionSummary: string;
  undone: boolean;
  createdAt: number;
}

export interface SnapshotUndoImpact {
  summary: string;
  isFullRestore: boolean;
  affectedEntriesCount: number;
  warningText: string;
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

export interface ArchitectFieldTypeChange {
  key: string;
  label: string;
  fromType: FieldType;
  toType: FieldType;
}

export interface ArchitectLibraryDiff {
  slug: string;
  name: string;
  entryCount: number;
  removedFields: Array<{ key: string; label: string; type: FieldType }>;
  typeChangedFields: ArchitectFieldTypeChange[];
  newlyRequiredFields: Array<{ key: string; label: string }>;
  hasDestructiveChanges: boolean;
}

type SnapshotPayload =
  | {
      kind: 'entries_created';
      entryIds: string[];
    }
  | {
      kind: 'entry_deleted';
      entry: Record<string, unknown>;
      relations: Array<Record<string, unknown>>;
    }
  | {
      kind: 'library_deleted';
      library: Record<string, unknown>;
      entries: Array<Record<string, unknown>>;
      relations: Array<Record<string, unknown>>;
      widgets: Array<Record<string, unknown>>;
    }
  | {
      kind: 'architect_plan';
      createdLibrarySlugs: string[];
      previousLibraries: Array<Record<string, unknown>>;
      createdWidgetIds: string[];
    }
  | FullBackupBundle;

interface RawEntryRow {
  id: string;
  library_id: string;
  title_summary: string;
  data_json: string;
  created_at: number;
  updated_at: number;
}

interface ForwardRelRow {
  source_entry_id: string;
  field_key: string;
  target_id: string;
  target_title: string;
  target_lib_id: string;
  target_data_json: string;
}

interface BackRelRow {
  target_entry_id: string;
  field_key: string;
  source_id: string;
  source_title: string;
  source_lib_id: string;
  source_data_json: string;
}

const SEARCHABLE_FIELD_TYPES = new Set<FieldType>([
  'text',
  'select',
  'multi_select',
  'date',
  'number',
  'currency',
]);

const RELATION_QUERY_CHUNK_SIZE = 400;

function isCompatibleFieldTypeChange(fromType: FieldType, toType: FieldType): boolean {
  if (fromType === toType) return true;
  const numericTypes = new Set<FieldType>(['number', 'currency', 'rating']);
  if (numericTypes.has(fromType) && numericTypes.has(toType)) return true;
  const stringTypes = new Set<FieldType>(['text', 'select', 'date']);
  if (stringTypes.has(fromType) && stringTypes.has(toType)) return true;
  return false;
}

type ChangeListener = () => void;

export class OmniRepository {
  private driver: SyncSqlDriver;
  private listeners = new Set<ChangeListener>();
  private librariesCache: LibraryRecord[] | null = null;
  private librariesByIdCache: Map<string, LibraryRecord> | null = null;
  private librariesBySlugCache: Map<string, LibraryRecord> | null = null;

  constructor(driver: SyncSqlDriver) {
    this.driver = driver;
    runCoreMigrations(this.driver);
    this.driver.withTransactionSync(() => {
      this.ensureViewsCompiled();
    });
  }

  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private invalidateLibrariesCache(): void {
    this.librariesCache = null;
    this.librariesByIdCache = null;
    this.librariesBySlugCache = null;
  }

  private notify(): void {
    this.invalidateLibrariesCache();
    for (const fn of this.listeners) {
      fn();
    }
  }

  private ensureLibrariesCache(): {
    list: LibraryRecord[];
    byId: Map<string, LibraryRecord>;
    bySlug: Map<string, LibraryRecord>;
  } {
    if (this.librariesCache && this.librariesByIdCache && this.librariesBySlugCache) {
      return {
        list: this.librariesCache,
        byId: this.librariesByIdCache,
        bySlug: this.librariesBySlugCache,
      };
    }

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

    const list: LibraryRecord[] = rows.map((r) => ({
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

    const byId = new Map<string, LibraryRecord>();
    const bySlug = new Map<string, LibraryRecord>();
    for (const lib of list) {
      byId.set(lib.id, lib);
      bySlug.set(lib.slug, lib);
    }

    this.librariesCache = list;
    this.librariesByIdCache = byId;
    this.librariesBySlugCache = bySlug;

    return { list, byId, bySlug };
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
    return this.ensureLibrariesCache().list;
  }

  getLibraryBySlug(slug: string): LibraryRecord | null {
    return this.ensureLibrariesCache().bySlug.get(slug) ?? null;
  }

  private getLibraryById(id: string): LibraryRecord | null {
    return this.ensureLibrariesCache().byId.get(id) ?? null;
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
    this.invalidateLibrariesCache();
    return id;
  }

  upsertLibrary(bp: LibraryBlueprint): string {
    const id = this.driver.withTransactionSync(() => this.upsertLibraryInternal(bp));
    this.notify();
    return id;
  }

  deleteLibrary(slug: string): void {
    const rawLib = this.driver.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM libraries WHERE slug = ?',
      [slug]
    );

    this.driver.withTransactionSync(() => {
      if (rawLib) {
        const libId = String(rawLib.id);
        const libName = String(rawLib.name ?? slug);
        const libEntries = this.driver.getAllSync<Record<string, unknown>>(
          'SELECT * FROM entries WHERE library_id = ? ORDER BY created_at ASC',
          [libId]
        );
        const libRelations = this.driver.getAllSync<Record<string, unknown>>(
          `SELECT * FROM entry_relations
           WHERE source_entry_id IN (SELECT id FROM entries WHERE library_id = ?)
              OR target_entry_id IN (SELECT id FROM entries WHERE library_id = ?)`,
          [libId, libId]
        );

        const allRawWidgets = this.driver.getAllSync<Record<string, unknown>>(
          'SELECT * FROM dashboard_widgets'
        );
        const matchedWidgets = allRawWidgets.filter(
          (w) =>
            w.library_slug === slug ||
            sqlReferencesLibraryView(String(w.readonly_sql ?? ''), slug)
        );

        this.saveSnapshotInternal(`删除记录本「${libName}」`, {
          kind: 'library_deleted',
          library: rawLib,
          entries: libEntries,
          relations: libRelations,
          widgets: matchedWidgets,
        });

        for (const w of matchedWidgets) {
          this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [String(w.id)]);
        }
      }

      dropLibrarySqlView(this.driver, slug);
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

    const fieldByKey = new Map(lib.fields.map((f) => [f.key, f]));
    const parts: string[] = [titleSummary];

    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue;
      const field = fieldByKey.get(k);
      // 仅收录可搜索字段（text / select / multi_select / date / number / currency），排除 image / relation 等
      if (field && !SEARCHABLE_FIELD_TYPES.has(field.type)) {
        continue;
      }
      if (typeof v === 'string') {
        if (v.startsWith('data:image/') || v.startsWith('images/')) continue;
        parts.push(v);
      } else if (typeof v === 'number') {
        parts.push(String(v));
      } else if (Array.isArray(v)) {
        const cleanItems = v
          .map(String)
          .filter((item) => item && !item.startsWith('data:image/'));
        if (cleanItems.length > 0) {
          parts.push(cleanItems.join(' '));
        }
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
    this.invalidateLibrariesCache();
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

      const lib = this.getLibraryById(existing.library_id);
      if (!lib) throw new Error('所属库不存在');

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

  deleteEntry(entryId: string): string | null {
    let snapshotId: string | null = null;
    this.driver.withTransactionSync(() => {
      const entryRow = this.driver.getFirstSync<Record<string, unknown>>(
        'SELECT * FROM entries WHERE id = ?',
        [entryId]
      );
      if (!entryRow) return;

      const relRows = this.driver.getAllSync<Record<string, unknown>>(
        'SELECT * FROM entry_relations WHERE source_entry_id = ? OR target_entry_id = ?',
        [entryId, entryId]
      );

      const title = String(entryRow.title_summary ?? '记录');
      snapshotId = this.saveSnapshotInternal(`删除记录「${title}」`, {
        kind: 'entry_deleted',
        entry: entryRow,
        relations: relRows,
      });

      this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
    });
    this.notify();
    return snapshotId;
  }

  /**
   * 批量提交 AI 万能快记跨库草稿（支持 "@prev:0" 引用同一事务内前序新建条目）
   * 使用轻量增量快照仅记录新建 ID，撤销时只删本批记录且不膨胀数据库
   */
  commitOmniDrafts(drafts: DraftEntryItem[], snapshotNote?: string): string[] {
    const createdIds: string[] = [];

    this.driver.withTransactionSync(() => {
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

      if (snapshotNote && createdIds.length > 0) {
        this.saveSnapshotInternal(snapshotNote, {
          kind: 'entries_created',
          entryIds: [...createdIds],
        });
      }
    });

    this.notify();
    return createdIds;
  }

  /**
   * 轻量级跨库全局搜索：单条 SQL 直接返回标题与所属库，不做全量水合或 JSON 解析
   */
  searchEntrySummaries(query: string, limit = 30): EntrySearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const { byId } = this.ensureLibrariesCache();
    const escaped = escapeLikePattern(trimmed.toLowerCase());
    const rows = this.driver.getAllSync<{
      id: string;
      library_id: string;
      title_summary: string;
    }>(
      `SELECT id, library_id, title_summary
       FROM entries
       WHERE search_text LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
      [`%${escaped}%`, limit]
    );

    const hits: EntrySearchHit[] = [];
    for (const r of rows) {
      const lib = byId.get(r.library_id);
      if (!lib) continue;
      hits.push({
        id: r.id,
        title: r.title_summary,
        libraryId: lib.id,
        librarySlug: lib.slug,
        libraryName: lib.name,
        libraryIcon: lib.icon,
      });
    }
    return hits;
  }

  /**
   * 批量查询一组条目的正向关联和反向引用，彻底消除列表页 N+1 SQL 查询
   */
  private loadRelationsBatch(entryIds: string[]): {
    forwardBySourceId: Map<string, ForwardRelRow[]>;
    backByTargetId: Map<string, BackRelRow[]>;
  } {
    const forwardBySourceId = new Map<string, ForwardRelRow[]>();
    const backByTargetId = new Map<string, BackRelRow[]>();
    if (entryIds.length === 0) {
      return { forwardBySourceId, backByTargetId };
    }

    for (let i = 0; i < entryIds.length; i += RELATION_QUERY_CHUNK_SIZE) {
      const chunk = entryIds.slice(i, i + RELATION_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');

      const forwardRows = this.driver.getAllSync<ForwardRelRow>(
        `SELECT
           r.source_entry_id,
           r.field_key,
           t.id AS target_id,
           t.title_summary AS target_title,
           t.library_id AS target_lib_id,
           t.data_json AS target_data_json
         FROM entry_relations r
         JOIN entries t ON t.id = r.target_entry_id
         WHERE r.source_entry_id IN (${placeholders})
         ORDER BY r.sort_order ASC`,
        chunk
      );

      for (const fr of forwardRows) {
        let list = forwardBySourceId.get(fr.source_entry_id);
        if (!list) {
          list = [];
          forwardBySourceId.set(fr.source_entry_id, list);
        }
        list.push(fr);
      }

      const backRows = this.driver.getAllSync<BackRelRow>(
        `SELECT
           r.target_entry_id,
           r.field_key,
           s.id AS source_id,
           s.title_summary AS source_title,
           s.library_id AS source_lib_id,
           s.data_json AS source_data_json
         FROM entry_relations r
         JOIN entries s ON s.id = r.source_entry_id
         WHERE r.target_entry_id IN (${placeholders})
         ORDER BY s.created_at DESC`,
        chunk
      );

      for (const br of backRows) {
        let list = backByTargetId.get(br.target_entry_id);
        if (!list) {
          list = [];
          backByTargetId.set(br.target_entry_id, list);
        }
        list.push(br);
      }
    }

    return { forwardBySourceId, backByTargetId };
  }

  /**
   * 读取并完整水合（Hydrate）某个库的全部条目：包含双向关联、Rollup 跨表汇总、Formula 行内公式与条件着色
   */
  listHydratedEntries(librarySlug: string, searchQuery?: string): HydratedEntry[] {
    const { byId: allLibsById, bySlug: allLibsBySlug } = this.ensureLibrariesCache();
    const lib = allLibsBySlug.get(librarySlug);
    if (!lib) return [];

    const trimmedQuery = searchQuery?.trim();
    const sql = trimmedQuery
      ? `SELECT id, library_id, title_summary, data_json, created_at, updated_at
         FROM entries
         WHERE library_id = ? AND search_text LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC`
      : `SELECT id, library_id, title_summary, data_json, created_at, updated_at
         FROM entries
         WHERE library_id = ?
         ORDER BY created_at DESC`;
    const params = trimmedQuery
      ? [lib.id, `%${escapeLikePattern(trimmedQuery.toLowerCase())}%`]
      : [lib.id];

    const rows = this.driver.getAllSync<RawEntryRow>(sql, params);
    if (rows.length === 0) return [];

    const { forwardBySourceId, backByTargetId } = this.loadRelationsBatch(rows.map((r) => r.id));
    const parsedJsonCache = new Map<string, Record<string, unknown>>();

    const hydrated = rows.map((row) =>
      this.hydrateRowWithRelations(
        row,
        lib,
        allLibsById,
        allLibsBySlug,
        forwardBySourceId.get(row.id) ?? [],
        backByTargetId.get(row.id) ?? [],
        parsedJsonCache
      )
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
    const row = this.driver.getFirstSync<RawEntryRow>(
      'SELECT id, library_id, title_summary, data_json, created_at, updated_at FROM entries WHERE id = ?',
      [entryId]
    );
    if (!row) return null;

    const { byId: allLibsById, bySlug: allLibsBySlug } = this.ensureLibrariesCache();
    const lib = allLibsById.get(row.library_id);
    if (!lib) return null;

    const { forwardBySourceId, backByTargetId } = this.loadRelationsBatch([row.id]);
    const parsedJsonCache = new Map<string, Record<string, unknown>>();

    return {
      library: lib,
      entry: this.hydrateRowWithRelations(
        row,
        lib,
        allLibsById,
        allLibsBySlug,
        forwardBySourceId.get(row.id) ?? [],
        backByTargetId.get(row.id) ?? [],
        parsedJsonCache
      ),
    };
  }

  private hydrateRowWithRelations(
    row: RawEntryRow,
    lib: LibraryRecord,
    allLibsById: Map<string, LibraryRecord>,
    allLibsBySlug: Map<string, LibraryRecord>,
    forwardRows: ForwardRelRow[],
    backRows: BackRelRow[],
    parsedJsonCache: Map<string, Record<string, unknown>>
  ): HydratedEntry {
    const parsePayload = (entryId: string, jsonStr: string): Record<string, unknown> => {
      const cached = parsedJsonCache.get(entryId);
      if (cached) return cached;
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      parsedJsonCache.set(entryId, parsed);
      return parsed;
    };

    const rawData = parsePayload(row.id, row.data_json);
    const computedData: Record<string, unknown> = { ...rawData };

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
      forwardTargetPayloads[fr.field_key].push(parsePayload(fr.target_id, fr.target_data_json));
    }

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
      reversePayloadsByKey[revKey].push(parsePayload(br.source_id, br.source_data_json));
    }

    // 计算 Rollup 汇总字段（支持正向 relationFieldKey 与反向 reverse:<slug>.<fieldKey>）
    for (const field of lib.fields) {
      if (field.type !== 'rollup' || !field.rollupConfig) continue;
      const { relationFieldKey, targetFieldKey, fn } = field.rollupConfig;

      let payloads: Array<Record<string, unknown>> = [];
      if (relationFieldKey.startsWith('reverse:')) {
        payloads = reversePayloadsByKey[relationFieldKey] ?? [];
      } else if (allLibsBySlug.has(relationFieldKey)) {
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

    // 计算行内 Formula 字段（可引用基础字段与刚算出的 Rollup 字段）
    for (const field of lib.fields) {
      if (field.type !== 'formula' || !field.formulaExpr) continue;
      computedData[field.key] = evaluateFormula(field.formulaExpr, computedData);
    }

    // 计算条件高亮规则
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
    return all.filter(
      (w) => w.librarySlug === slug || sqlReferencesLibraryView(w.readonlySql, slug)
    );
  }

  private saveDashboardWidgetInternal(
    w: DashboardWidget,
    librarySlug: string | null = null,
    sortOrder?: number,
    pinnedOverview = true
  ): string {
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
    return id;
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
   * 对比 AI 建筑师方案与当前存量库结构，检测可能导致旧数据不可见或校验失败的字段变更
   */
  analyzeArchitectPlanDiff(plan: ArchitectPlan): ArchitectLibraryDiff[] {
    const diffs: ArchitectLibraryDiff[] = [];

    for (const bp of plan.libraries) {
      const existing = this.getLibraryBySlug(bp.slug);
      if (!existing) continue;

      const nextByKey = new Map(bp.fields.map((f) => [f.key, f]));
      const removedFields: ArchitectLibraryDiff['removedFields'] = [];
      const typeChangedFields: ArchitectFieldTypeChange[] = [];
      const newlyRequiredFields: ArchitectLibraryDiff['newlyRequiredFields'] = [];

      for (const oldField of existing.fields) {
        const nextField = nextByKey.get(oldField.key);
        if (!nextField) {
          // rollup / formula 无物理存储值，删除不会丢原始数据
          if (oldField.type !== 'rollup' && oldField.type !== 'formula') {
            removedFields.push({
              key: oldField.key,
              label: oldField.label,
              type: oldField.type,
            });
          }
          continue;
        }
        if (oldField.type !== nextField.type) {
          typeChangedFields.push({
            key: oldField.key,
            label: oldField.label,
            fromType: oldField.type,
            toType: nextField.type,
          });
        }
        if (!oldField.required && nextField.required) {
          newlyRequiredFields.push({ key: oldField.key, label: nextField.label });
        }
      }

      const hasIncompatibleTypeChange = typeChangedFields.some(
        (c) => !isCompatibleFieldTypeChange(c.fromType, c.toType)
      );
      const hasDestructiveChanges =
        existing.entryCount > 0 && (removedFields.length > 0 || hasIncompatibleTypeChange);

      if (
        removedFields.length > 0 ||
        typeChangedFields.length > 0 ||
        newlyRequiredFields.length > 0
      ) {
        diffs.push({
          slug: existing.slug,
          name: existing.name,
          entryCount: existing.entryCount,
          removedFields,
          typeChangedFields,
          newlyRequiredFields,
          hasDestructiveChanges,
        });
      }
    }

    return diffs;
  }

  /**
   * AI 建筑师方案应用（自动保存增量回滚快照 + 创建/更新多表 + 创建看板组件）
   */
  applyArchitectPlan(
    plan: ArchitectPlan,
    options?: { allowDestructiveFieldChanges?: boolean }
  ): string {
    const diffs = this.analyzeArchitectPlanDiff(plan);
    const destructive = diffs.filter((d) => d.hasDestructiveChanges);
    if (destructive.length > 0 && !options?.allowDestructiveFieldChanges) {
      const details = destructive
        .map((d) => {
          const msgs: string[] = [];
          if (d.removedFields.length > 0) {
            msgs.push(`移除字段: ${d.removedFields.map((f) => f.label).join('、')}`);
          }
          if (d.typeChangedFields.length > 0) {
            msgs.push(
              `变更类型: ${d.typeChangedFields
                .map((f) => `${f.label}(${f.fromType}->${f.toType})`)
                .join('、')}`
            );
          }
          return `「${d.name}」(${d.entryCount} 条记录，${msgs.join('；')})`;
        })
        .join('；');
      throw new Error(`方案包含破坏性字段变更，可能导致旧数据无法显示或保存：${details}`);
    }

    const createdLibrarySlugs: string[] = [];
    const previousLibraries: Array<Record<string, unknown>> = [];
    let snapshotId = '';

    // 先提交表结构与视图变更，再使用独立只读连接校验并保存看板图表
    this.driver.withTransactionSync(() => {
      for (const bp of plan.libraries) {
        const existingRaw = this.driver.getFirstSync<Record<string, unknown>>(
          'SELECT * FROM libraries WHERE slug = ?',
          [bp.slug]
        );
        if (existingRaw) {
          previousLibraries.push(existingRaw);
        } else {
          createdLibrarySlugs.push(bp.slug);
        }
      }

      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', {
        kind: 'architect_plan',
        createdLibrarySlugs,
        previousLibraries,
        createdWidgetIds: [],
      });

      plan.libraries.forEach((bp) => {
        this.upsertLibraryInternal(bp);
      });
    });

    const createdWidgetIds: string[] = [];
    if (plan.dashboardWidgets.length > 0) {
      plan.dashboardWidgets.forEach((w, idx) => {
        try {
          this.driver.queryReadOnlySync(w.readonlySql);
          const wid = this.saveDashboardWidgetInternal(w, null, 50 + idx);
          createdWidgetIds.push(wid);
        } catch {
          // 跳过语法有误的可选图表，不阻塞主模型创建
        }
      });
    }

    if (createdWidgetIds.length > 0 && snapshotId) {
      this.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
        JSON.stringify({
          kind: 'architect_plan',
          createdLibrarySlugs,
          previousLibraries,
          createdWidgetIds,
        } satisfies SnapshotPayload),
        snapshotId,
      ]);
    }

    this.notify();
    return snapshotId;
  }

  private saveSnapshotInternal(summary: string, payload: SnapshotPayload): string {
    const id = createId('snap');
    this.driver.runSync(
      `INSERT INTO ai_snapshots (id, action_summary, snapshot_json, undone, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [id, summary, JSON.stringify(payload), Date.now()]
    );
    // 严格保留最近 MAX_AI_SNAPSHOTS 条，防止快照无限膨胀
    this.driver.runSync(
      `DELETE FROM ai_snapshots
       WHERE id NOT IN (
         SELECT id FROM ai_snapshots ORDER BY created_at DESC LIMIT ?
       )`,
      [MAX_AI_SNAPSHOTS]
    );
    return id;
  }

  listSnapshots(): AiSnapshotItem[] {
    const rows = this.driver.getAllSync<{
      id: string;
      action_summary: string;
      undone: number;
      created_at: number;
    }>(
      'SELECT id, action_summary, undone, created_at FROM ai_snapshots ORDER BY created_at DESC LIMIT ?',
      [MAX_AI_SNAPSHOTS]
    );

    return rows.map((r) => ({
      id: r.id,
      actionSummary: r.action_summary,
      undone: Boolean(r.undone),
      createdAt: r.created_at,
    }));
  }

  /**
   * 评估撤销某条快照的影响范围，用于撤销前向用户清晰提示
   */
  describeSnapshotUndoImpact(snapshotId: string): SnapshotUndoImpact {
    const row = this.driver.getFirstSync<{
      action_summary: string;
      snapshot_json: string;
      created_at: number;
    }>('SELECT action_summary, snapshot_json, created_at FROM ai_snapshots WHERE id = ?', [
      snapshotId,
    ]);
    if (!row) {
      throw new Error('该操作记录不存在');
    }

    const payload = JSON.parse(row.snapshot_json) as SnapshotPayload;

    if ('kind' in payload) {
      if (payload.kind === 'entries_created') {
        const placeholders = payload.entryIds.map(() => '?').join(', ');
        const cntRow =
          payload.entryIds.length > 0
            ? this.driver.getFirstSync<{ cnt: number }>(
                `SELECT COUNT(*) AS cnt FROM entries WHERE id IN (${placeholders})`,
                payload.entryIds
              )
            : { cnt: 0 };
        const count = Number(cntRow?.cnt ?? 0);
        return {
          summary: row.action_summary,
          isFullRestore: false,
          affectedEntriesCount: count,
          warningText: `将删除本次添加的 ${count} 条记录，不影响其他数据。`,
        };
      }

      if (payload.kind === 'entry_deleted') {
        return {
          summary: row.action_summary,
          isFullRestore: false,
          affectedEntriesCount: 1,
          warningText: '将恢复被删除的这条记录及其关联关系，不影响其他数据。',
        };
      }

      if (payload.kind === 'library_deleted') {
        const libName = String(payload.library.name ?? '');
        return {
          summary: row.action_summary,
          isFullRestore: false,
          affectedEntriesCount: payload.entries.length,
          warningText: `将恢复记录本「${libName}」及其 ${payload.entries.length} 条记录，不影响其他记录本。`,
        };
      }

      if (payload.kind === 'architect_plan') {
        let newLibEntryCount = 0;
        for (const slug of payload.createdLibrarySlugs) {
          const lib = this.getLibraryBySlug(slug);
          if (lib) newLibEntryCount += lib.entryCount;
        }
        const warningText =
          newLibEntryCount > 0
            ? `将移除本次新建的记录本（含此后新增的 ${newLibEntryCount} 条记录），并还原被修改记录本的结构；其他记录本数据不受影响。`
            : '将撤销本次记录本结构与图表变更，其他记录本及已有条目不受影响。';
        return {
          summary: row.action_summary,
          isFullRestore: false,
          affectedEntriesCount: newLibEntryCount,
          warningText,
        };
      }
    }

    // 兼容历史全量快照
    const newerRow = this.driver.getFirstSync<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM entries WHERE created_at > ? OR updated_at > ?',
      [row.created_at, row.created_at]
    );
    const newerCount = Number(newerRow?.cnt ?? 0);
    return {
      summary: row.action_summary,
      isFullRestore: true,
      affectedEntriesCount: newerCount,
      warningText:
        newerCount > 0
          ? `此历史快照会恢复整个数据库，将丢失此后新增或修改的 ${newerCount} 条记录。`
          : '此历史快照会恢复整个数据库到操作前的状态。',
    };
  }

  undoSnapshot(snapshotId: string): void {
    const row = this.driver.getFirstSync<{ snapshot_json: string; undone: number }>(
      'SELECT snapshot_json, undone FROM ai_snapshots WHERE id = ?',
      [snapshotId]
    );
    if (!row || row.undone) {
      throw new Error('该快照不存在或已撤销');
    }

    const payload = JSON.parse(row.snapshot_json) as SnapshotPayload;

    this.driver.withTransactionSync(() => {
      if ('kind' in payload) {
        if (payload.kind === 'entries_created') {
          for (const entryId of payload.entryIds) {
            this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
          }
        } else if (payload.kind === 'entry_deleted') {
          const e = payload.entry;
          const libExists = this.driver.getFirstSync<{ id: string }>(
            'SELECT id FROM libraries WHERE id = ?',
            [String(e.library_id)]
          );
          if (!libExists) {
            throw new Error('所属记录本已被删除，请先撤销删除记录本的操作');
          }
          this.insertRawEntry(e);
          this.insertRawRelationsSafe(payload.relations);
        } else if (payload.kind === 'library_deleted') {
          const l = payload.library;
          const conflict = this.driver.getFirstSync<{ id: string }>(
            'SELECT id FROM libraries WHERE id = ? OR slug = ?',
            [String(l.id), String(l.slug)]
          );
          if (conflict) {
            throw new Error(`已存在同标识记录本（${String(l.slug)}），无法直接撤销`);
          }
          this.insertRawLibrary(l);
          const fields = JSON.parse(String(l.fields_json)) as FieldDef[];
          compileLibrarySqlView(this.driver, String(l.id), String(l.slug), fields);
          for (const e of payload.entries) {
            this.insertRawEntry(e);
          }
          this.insertRawRelationsSafe(payload.relations);
          for (const w of payload.widgets) {
            this.insertRawWidget(w);
          }
        } else if (payload.kind === 'architect_plan') {
          for (const slug of payload.createdLibrarySlugs) {
            dropLibrarySqlView(this.driver, slug);
            const allRawWidgets = this.driver.getAllSync<{ id: string; library_slug: string | null; readonly_sql: string }>(
              'SELECT id, library_slug, readonly_sql FROM dashboard_widgets'
            );
            for (const w of allRawWidgets) {
              if (w.library_slug === slug || sqlReferencesLibraryView(w.readonly_sql, slug)) {
                this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [w.id]);
              }
            }
            this.driver.runSync('DELETE FROM libraries WHERE slug = ?', [slug]);
          }

          for (const prev of payload.previousLibraries) {
            const exists = this.driver.getFirstSync<{ id: string }>(
              'SELECT id FROM libraries WHERE id = ?',
              [String(prev.id)]
            );
            if (exists) {
              this.driver.runSync(
                `UPDATE libraries
                 SET name = ?, description = ?, icon = ?, color = ?, fields_json = ?, views_json = ?, updated_at = ?
                 WHERE id = ?`,
                [
                  String(prev.name),
                  String(prev.description ?? ''),
                  String(prev.icon ?? '📦'),
                  String(prev.color ?? 'teal'),
                  String(prev.fields_json),
                  String(prev.views_json),
                  Number(prev.updated_at ?? Date.now()),
                  String(prev.id),
                ]
              );
            } else {
              this.insertRawLibrary(prev);
            }
            const fields = JSON.parse(String(prev.fields_json)) as FieldDef[];
            compileLibrarySqlView(this.driver, String(prev.id), String(prev.slug), fields);
          }

          for (const wid of payload.createdWidgetIds) {
            this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [wid]);
          }
        }
      } else {
        // 兼容旧版全量备份快照
        this.importBackupBundleInternal(payload);
      }

      this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE id = ?', [snapshotId]);
    });

    this.notify();
  }

  private insertRawLibrary(l: Record<string, unknown>): void {
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

  private insertRawEntry(e: Record<string, unknown>): void {
    this.driver.runSync(
      `INSERT OR REPLACE INTO entries (id, library_id, title_summary, search_text, data_json, created_at, updated_at)
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

  private insertRawRelationsSafe(relations: Array<Record<string, unknown>>): void {
    for (const r of relations) {
      const srcExists = this.driver.getFirstSync<{ id: string }>(
        'SELECT id FROM entries WHERE id = ?',
        [String(r.source_entry_id)]
      );
      const tgtExists = this.driver.getFirstSync<{ id: string }>(
        'SELECT id FROM entries WHERE id = ?',
        [String(r.target_entry_id)]
      );
      if (!srcExists || !tgtExists) continue;
      this.driver.runSync(
        `INSERT OR IGNORE INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
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
  }

  private insertRawWidget(w: Record<string, unknown>): void {
    this.driver.runSync(
      `INSERT OR REPLACE INTO dashboard_widgets (id, library_slug, title, subtitle, chart_type, readonly_sql, x_key, y_key, unit_prefix, unit_suffix, accent_tone, pinned_overview, sort_order, created_at)
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

  private importBackupBundleInternal(bundle: FullBackupBundle): void {
    const oldLibs = this.driver.getAllSync<{ slug: string }>('SELECT slug FROM libraries');
    for (const l of oldLibs) {
      dropLibrarySqlView(this.driver, l.slug);
    }

    this.driver.execSync('DELETE FROM entry_relations;');
    this.driver.execSync('DELETE FROM entries;');
    this.driver.execSync('DELETE FROM dashboard_widgets;');
    this.driver.execSync('DELETE FROM libraries;');

    for (const l of bundle.libraries) {
      this.insertRawLibrary(l);
    }

    for (const e of bundle.entries) {
      this.insertRawEntry(e);
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
      this.insertRawWidget(w);
    }

    this.ensureViewsCompiled();
  }

  importBackupBundle(bundle: FullBackupBundle, shouldNotify = true): void {
    this.driver.withTransactionSync(() => {
      this.importBackupBundleInternal(bundle);
    });

    if (shouldNotify) {
      this.notify();
    } else {
      this.invalidateLibrariesCache();
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
