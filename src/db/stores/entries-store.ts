import {
  isBatchRefToken,
  resolveDraftDataForCommit,
  type CommitDraftEntryItem,
  type PriorDraftTarget,
} from '@/engine/capture-drafts';
import { createId } from '@/engine/id';
import {
  buildEntryPayloadValidator,
  normalizeRelationValueList,
  type FieldDef,
  type FieldType,
} from '@/schema/field-defs';
import {
  hydrateRowWithRelations,
  loadRelationsBatch,
  sortHydratedEntries,
} from '../hydration';
import type {
  BacklinkGroupSection,
  ChildLibrarySection,
  DetachedSourceRecord,
  EntrySearchHit,
  HydratedEntry,
  LibraryRecord,
  RawEntryRow,
} from '../models';
import { escapeLikePattern, type SqlParam, type SyncSqlDriver } from '../types';
import type { LibrariesStore } from './libraries-store';

const SEARCHABLE_FIELD_TYPES = new Set<FieldType>([
  'text',
  'select',
  'multi_select',
  'date',
  'number',
  'currency',
]);

const ENTRY_QUERY_CHUNK_SIZE = 400;
const RELATIVE_IMAGE_REGEX = /images\/img_[A-Z0-9]+\.[a-z0-9]+/gi;

export class EntriesStore {
  constructor(
    private driver: SyncSqlDriver,
    private libraries: LibrariesStore
  ) {}

  private computeTitleAndSearch(
    lib: LibraryRecord,
    data: Record<string, unknown>
  ): { titleSummary: string; searchText: string } {
    const titleKey = lib.views.card.titleFieldKey || lib.fields[0]?.key || '';
    let rawTitle = data[titleKey];
    if (rawTitle === undefined || rawTitle === null || String(rawTitle).trim() === '') {
      const fallbackField = lib.fields.find(
        (f) =>
          (f.type === 'text' || f.type === 'select' || f.type === 'date') &&
          data[f.key] !== undefined &&
          data[f.key] !== null &&
          String(data[f.key]).trim() !== ''
      );
      if (fallbackField) {
        rawTitle = data[fallbackField.key];
      }
    }
    const firstLine =
      rawTitle !== undefined && rawTitle !== null
        ? String(rawTitle)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find(Boolean) ?? ''
        : '';
    const titleSummary = firstLine
      ? firstLine.length > 72
        ? `${firstLine.slice(0, 72)}…`
        : firstLine
      : `${lib.name}记录`;

    const fieldByKey = new Map(lib.fields.map((f) => [f.key, f]));
    const parts: string[] = [titleSummary];

    for (const [k, v] of Object.entries(data)) {
      if (v === undefined || v === null || v === '') continue;
      const field = fieldByKey.get(k);
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
      const targets = Array.from(new Set(normalizeRelationValueList(data[f.key])));

      if (f.relationConfig?.allowMultiple === false && targets.length > 1) {
        throw new Error(`关联字段「${f.label}」仅支持关联 1 条记录`);
      }

      const targetSlug = f.relationConfig?.targetLibrarySlug;
      const targetLib = targetSlug ? this.libraries.getLibraryBySlug(targetSlug) : null;
      if (targets.length > 0 && targetSlug && !targetLib) {
        throw new Error(`关联字段「${f.label}」指向的目标记录本不存在: ${targetSlug}`);
      }

      targets.forEach((targetId, idx) => {
        if (isBatchRefToken(targetId)) {
          throw new Error(`关联字段「${f.label}」包含未解析的草稿引用（${targetId}），请重新选择后再保存`);
        }
        const targetRow = this.driver.getFirstSync<{ id: string; library_id: string }>(
          'SELECT id, library_id FROM entries WHERE id = ?',
          [targetId]
        );
        if (!targetRow) {
          throw new Error(`关联字段「${f.label}」引用的目标记录不存在，请重新选择后再保存`);
        }
        if (targetLib && targetRow.library_id !== targetLib.id) {
          throw new Error(`关联字段「${f.label}」只能关联「${targetLib.name}」中的记录`);
        }
        this.driver.runSync(
          `INSERT OR IGNORE INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [createId('rel'), entryId, targetId, libraryId, f.key, idx]
        );
      });
    }
  }

  /**
   * 宽容重建单条记录的 entry_relations 索引（供字段结构演进、备份导入与快照撤销后同步索引使用）：
   * 严格按 data[field.key] 的有序 ID 列表写入 sort_order，仅写入当前存在且归属正确目标库的边。
   */
  syncEntryRelationsNonStrictInternal(
    entryId: string,
    libraryId: string,
    fields: readonly FieldDef[],
    data: Record<string, unknown>
  ): void {
    this.driver.runSync('DELETE FROM entry_relations WHERE source_entry_id = ?', [entryId]);

    for (const f of fields) {
      if (f.type !== 'relation') continue;
      const targets = Array.from(new Set(normalizeRelationValueList(data[f.key])));
      if (targets.length === 0) continue;

      const targetSlug = f.relationConfig?.targetLibrarySlug;
      const targetLib = targetSlug ? this.libraries.getLibraryBySlug(targetSlug) : null;
      if (targetSlug && !targetLib) continue;

      const effectiveTargets =
        f.relationConfig?.allowMultiple === false ? targets.slice(0, 1) : targets;
      effectiveTargets.forEach((targetId, idx) => {
        if (isBatchRefToken(targetId)) return;
        const targetRow = this.driver.getFirstSync<{ id: string; library_id: string }>(
          'SELECT id, library_id FROM entries WHERE id = ?',
          [targetId]
        );
        if (!targetRow) return;
        if (targetLib && targetRow.library_id !== targetLib.id) return;
        this.driver.runSync(
          `INSERT OR IGNORE INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [createId('rel'), entryId, targetId, libraryId, f.key, idx]
        );
      });
    }
  }

  /**
   * 当记录本新增/修改 relation 字段或导入备份后，按最新字段定义为该库全部条目补建/刷新 entry_relations 索引。
   */
  syncLibraryEntryRelationsInternal(libraryId: string): void {
    const lib = this.libraries.getLibraryById(libraryId);
    if (!lib) return;

    const rows = this.driver.getAllSync<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM entries WHERE library_id = ?',
      [lib.id]
    );
    if (rows.length === 0) return;

    const hasRelationFields = lib.fields.some((f) => f.type === 'relation');
    if (!hasRelationFields) {
      this.driver.runSync('DELETE FROM entry_relations WHERE source_library_id = ?', [lib.id]);
      return;
    }

    for (const row of rows) {
      let parsed: Record<string, unknown> | null = null;
      try {
        const raw = JSON.parse(row.data_json);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsed = raw as Record<string, unknown>;
        }
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      this.syncEntryRelationsNonStrictInternal(row.id, lib.id, lib.fields, parsed);
    }
  }

  createEntryInternal(
    librarySlug: string,
    inputData: Record<string, unknown>,
    customTimestamp?: number
  ): string {
    const lib = this.libraries.getLibraryBySlug(librarySlug);
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
    this.libraries.invalidateCache();
    return id;
  }

  updateEntryInternal(entryId: string, inputData: Record<string, unknown>): void {
    const existing = this.driver.getFirstSync<{ library_id: string }>(
      'SELECT library_id FROM entries WHERE id = ?',
      [entryId]
    );
    if (!existing) throw new Error('记录不存在');

    const lib = this.libraries.getLibraryById(existing.library_id);
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
  }

  /**
   * 批量清理存活条目 data_json 中指向待删条目的关联引用：
   * - 优先通过 entry_relations 索引精准定位反向引用；
   * - 仅对关联目标指向待删条目所属库的来源库做定向兜底查询（不扫描无关记录本）；
   * - 手动删库（clearDanglingForDeletedLibrarySlug）时一并清理指向该库的已失效历史 ID（不碰指向其他存活库的有效 ID）；
   * - 仅对 JSON.parse 捕获格式错误，SQLite UPDATE 异常直接抛出以触发事务回滚。
   */
  detachReferencesToEntriesInternal(
    targetEntryIds: readonly string[],
    options?: { clearDanglingForDeletedLibrarySlug?: string }
  ): DetachedSourceRecord[] {
    const targetIdSet = new Set(targetEntryIds.filter(Boolean));
    const clearDeletedSlug = options?.clearDanglingForDeletedLibrarySlug;
    if (targetIdSet.size === 0 && !clearDeletedSlug) return [];

    const fieldsBySourceId = new Map<string, Set<string>>();
    const danglingFieldsBySourceId = new Map<string, Set<string>>();

    const addFieldForSource = (
      map: Map<string, Set<string>>,
      srcId: string,
      fieldKey: string
    ) => {
      if (targetIdSet.has(srcId)) return;
      let keys = map.get(srcId);
      if (!keys) {
        keys = new Set<string>();
        map.set(srcId, keys);
      }
      keys.add(fieldKey);
    };

    const uniqueTargets = Array.from(targetIdSet);
    const targetLibSlugs = new Set<string>();
    if (clearDeletedSlug) {
      targetLibSlugs.add(clearDeletedSlug);
    }

    const { byId } = this.libraries.ensureCache();
    for (let i = 0; i < uniqueTargets.length; i += ENTRY_QUERY_CHUNK_SIZE) {
      const chunk = uniqueTargets.slice(i, i + ENTRY_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const relRows = this.driver.getAllSync<{ source_entry_id: string; field_key: string }>(
        `SELECT source_entry_id, field_key FROM entry_relations WHERE target_entry_id IN (${placeholders})`,
        chunk
      );
      for (const r of relRows) {
        addFieldForSource(fieldsBySourceId, r.source_entry_id, r.field_key);
      }

      const libRows = this.driver.getAllSync<{ library_id: string }>(
        `SELECT DISTINCT library_id FROM entries WHERE id IN (${placeholders})`,
        chunk
      );
      for (const lr of libRows) {
        const lib = byId.get(lr.library_id);
        if (lib) targetLibSlugs.add(lib.slug);
      }
    }

    const entryExistsCache = new Map<string, boolean>();
    const entryExistsInDb = (entryId: string): boolean => {
      const cached = entryExistsCache.get(entryId);
      if (cached !== undefined) return cached;
      const found = Boolean(
        this.driver.getFirstSync<{ id: string }>('SELECT id FROM entries WHERE id = ?', [entryId])
      );
      entryExistsCache.set(entryId, found);
      return found;
    };

    // 仅定向检查关联目标属于 targetLibSlugs 的来源库，绝不读取无关记录本
    if (targetLibSlugs.size > 0) {
      const allLibs = this.libraries.listLibraries();
      for (const lib of allLibs) {
        if (clearDeletedSlug && lib.slug === clearDeletedSlug) continue;
        const matchingFields = lib.fields.filter(
          (f) =>
            f.type === 'relation' &&
            f.relationConfig?.targetLibrarySlug &&
            targetLibSlugs.has(f.relationConfig.targetLibrarySlug)
        );
        if (matchingFields.length === 0) continue;

        const hasClearDeletedField = Boolean(
          clearDeletedSlug &&
            matchingFields.some((f) => f.relationConfig?.targetLibrarySlug === clearDeletedSlug)
        );

        let candidateRows: Array<{ id: string; data_json: string }>;
        if (!hasClearDeletedField && uniqueTargets.length > 0 && uniqueTargets.length <= 20) {
          const likeClauses = uniqueTargets.map(() => "data_json LIKE ? ESCAPE '\\'").join(' OR ');
          const likeParams: SqlParam[] = [
            lib.id,
            ...uniqueTargets.map((id) => `%${escapeLikePattern(id)}%`),
          ];
          candidateRows = this.driver.getAllSync<{ id: string; data_json: string }>(
            `SELECT id, data_json FROM entries WHERE library_id = ? AND (${likeClauses})`,
            likeParams
          );
        } else if (hasClearDeletedField || uniqueTargets.length > 20) {
          candidateRows = this.driver.getAllSync<{ id: string; data_json: string }>(
            'SELECT id, data_json FROM entries WHERE library_id = ?',
            [lib.id]
          );
        } else {
          candidateRows = [];
        }

        for (const r of candidateRows) {
          if (targetIdSet.has(r.id)) continue;
          let parsed: Record<string, unknown> | null = null;
          try {
            const raw = JSON.parse(r.data_json);
            if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
              parsed = raw as Record<string, unknown>;
            }
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
          for (const f of matchingFields) {
            const tokens = normalizeRelationValueList(parsed[f.key]);
            if (tokens.length === 0) continue;
            if (tokens.some((id) => targetIdSet.has(id))) {
              addFieldForSource(fieldsBySourceId, r.id, f.key);
            }
            if (
              clearDeletedSlug &&
              f.relationConfig?.targetLibrarySlug === clearDeletedSlug &&
              tokens.some((id) => !targetIdSet.has(id) && !entryExistsInDb(id))
            ) {
              addFieldForSource(fieldsBySourceId, r.id, f.key);
              addFieldForSource(danglingFieldsBySourceId, r.id, f.key);
            }
          }
        }
      }
    }

    const detachedSources: DetachedSourceRecord[] = [];
    for (const [srcId, fieldKeys] of fieldsBySourceId.entries()) {
      const srcRow = this.driver.getFirstSync<{ id: string; data_json: string }>(
        'SELECT id, data_json FROM entries WHERE id = ?',
        [srcId]
      );
      if (!srcRow) continue;

      let parsedData: Record<string, unknown> | null = null;
      try {
        const raw = JSON.parse(srcRow.data_json);
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          parsedData = raw as Record<string, unknown>;
        }
      } catch {
        parsedData = null;
      }
      if (!parsedData) continue;

      const danglingFieldsForSrc = danglingFieldsBySourceId.get(srcId);
      const removedByField: Record<string, string[]> = {};
      let changed = false;
      for (const fk of fieldKeys) {
        const curTokens = normalizeRelationValueList(parsedData[fk]);
        if (curTokens.length === 0) continue;
        const allowClearDangling = Boolean(danglingFieldsForSrc?.has(fk));
        const shouldRemove = (id: string) =>
          targetIdSet.has(id) || (allowClearDangling && !entryExistsInDb(id));
        const removed = curTokens.filter(shouldRemove);
        if (removed.length === 0) continue;
        const nextTokens = curTokens.filter((id) => !shouldRemove(id));
        parsedData[fk] = nextTokens;
        removedByField[fk] = removed;
        changed = true;
      }

      if (changed) {
        // 数据库写入置于 try/catch 之外，确保任何写入异常都能中断并回滚外层事务
        this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
          JSON.stringify(parsedData),
          srcRow.id,
        ]);
        detachedSources.push({
          id: srcRow.id,
          prevDataJson: srcRow.data_json,
          removedByField,
        });
      }
    }

    return detachedSources;
  }

  /**
   * 清理存活记录中指向指定记录本实际条目的引用；
   * 手动删库时可开启 `clearDangling` 一并清理指向该库的已失效历史引用（即使该库当前已为空）。
   */
  detachReferencesToLibraryInternal(
    librarySlug: string,
    options?: { clearDangling?: boolean }
  ): DetachedSourceRecord[] {
    const libRow = this.driver.getFirstSync<{ id: string }>(
      'SELECT id FROM libraries WHERE slug = ?',
      [librarySlug]
    );
    const entryIds = libRow
      ? this.driver
          .getAllSync<{ id: string }>('SELECT id FROM entries WHERE library_id = ?', [libRow.id])
          .map((r) => r.id)
      : [];
    return this.detachReferencesToEntriesInternal(entryIds, {
      clearDanglingForDeletedLibrarySlug: options?.clearDangling ? librarySlug : undefined,
    });
  }

  /**
   * 解绑所有反向引用并删除单条记录，返回用于增量撤销的上下文负载
   */
  deleteEntryWithDetachInternal(entryId: string): {
    entryRow: Record<string, unknown>;
    relRows: Array<Record<string, unknown>>;
    detachedSources: DetachedSourceRecord[];
  } | null {
    const entryRow = this.driver.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM entries WHERE id = ?',
      [entryId]
    );
    if (!entryRow) return null;

    const relRows = this.driver.getAllSync<Record<string, unknown>>(
      'SELECT * FROM entry_relations WHERE source_entry_id = ? OR target_entry_id = ?',
      [entryId, entryId]
    );

    const detachedSources = this.detachReferencesToEntriesInternal([entryId]);
    this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
    return { entryRow, relRows, detachedSources };
  }

  commitOmniDraftsInternal(drafts: readonly CommitDraftEntryItem[]): string[] {
    const createdIds: string[] = [];
    const priorTargets: PriorDraftTarget[] = [];
    drafts.forEach((draft) => {
      const lib = this.libraries.getLibraryBySlug(draft.librarySlug);
      const resolved = resolveDraftDataForCommit(draft, lib, priorTargets);
      const newId = this.createEntryInternal(draft.librarySlug, resolved);
      createdIds.push(newId);
      priorTargets.push({
        draftId: draft.draftId,
        librarySlug: draft.librarySlug,
        createdEntryId: newId,
      });
    });
    return createdIds;
  }

  /**
   * 轻量批量读取条目 ID -> 标题与所属库 slug 映射（供草稿预览同时做标题展示与跨库校验）
   */
  getEntrySummaryMap(entryIds: string[]): Map<string, { title: string; librarySlug: string }> {
    const map = new Map<string, { title: string; librarySlug: string }>();
    const uniqueIds = Array.from(new Set(entryIds.filter(Boolean)));
    if (uniqueIds.length === 0) return map;

    const { byId } = this.libraries.ensureCache();
    for (let i = 0; i < uniqueIds.length; i += ENTRY_QUERY_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + ENTRY_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.driver.getAllSync<{
        id: string;
        library_id: string;
        title_summary: string;
      }>(
        `SELECT id, library_id, title_summary FROM entries WHERE id IN (${placeholders})`,
        chunk
      );
      for (const r of rows) {
        const lib = byId.get(r.library_id);
        if (lib) {
          map.set(r.id, { title: r.title_summary, librarySlug: lib.slug });
        }
      }
    }
    return map;
  }

  /**
   * 轻量批量读取条目 ID -> 标题映射（避免 UI 展示关联草稿时做全量水合）
   */
  getEntryTitleMap(entryIds: string[]): Map<string, string> {
    const map = new Map<string, string>();
    const uniqueIds = Array.from(new Set(entryIds.filter(Boolean)));
    if (uniqueIds.length === 0) return map;

    for (let i = 0; i < uniqueIds.length; i += ENTRY_QUERY_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + ENTRY_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.driver.getAllSync<{ id: string; title_summary: string }>(
        `SELECT id, title_summary FROM entries WHERE id IN (${placeholders})`,
        chunk
      );
      for (const r of rows) {
        map.set(r.id, r.title_summary);
      }
    }
    return map;
  }

  searchEntrySummaries(query: string, limit = 30): EntrySearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const { byId } = this.libraries.ensureCache();
    const escaped = escapeLikePattern(trimmed.toLowerCase());
    const rows = this.driver.getAllSync<{
      id: string;
      library_id: string;
      title_summary: string;
      updated_at: number;
    }>(
      `SELECT id, library_id, title_summary, updated_at
       FROM entries
       WHERE search_text LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC
       LIMIT ?`,
      [`%${escaped}%`, limit]
    );

    return this.mapSummaryRowsToHits(rows, byId);
  }

  listRecentEntrySummaries(limit = 6): EntrySearchHit[] {
    const { byId } = this.libraries.ensureCache();
    const rows = this.driver.getAllSync<{
      id: string;
      library_id: string;
      title_summary: string;
      updated_at: number;
    }>(
      `SELECT id, library_id, title_summary, updated_at
       FROM entries
       ORDER BY updated_at DESC
       LIMIT ?`,
      [limit]
    );

    return this.mapSummaryRowsToHits(rows, byId);
  }

  private mapSummaryRowsToHits(
    rows: Array<{ id: string; library_id: string; title_summary: string; updated_at: number }>,
    byId: Map<string, LibraryRecord>
  ): EntrySearchHit[] {
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
        updatedAt: r.updated_at,
      });
    }
    return hits;
  }

  /**
   * 使用 SQLite 窗口函数仅返回每个记录本最新 1 条记录的摘要，避免全表回传到 JS 去重
   */
  listLatestEntryByLibrary(): Map<string, { title: string; updatedAt: number }> {
    const rows = this.driver.getAllSync<{
      library_id: string;
      title_summary: string;
      updated_at: number;
    }>(`
      SELECT library_id, title_summary, updated_at
      FROM (
        SELECT
          library_id,
          title_summary,
          updated_at,
          ROW_NUMBER() OVER (PARTITION BY library_id ORDER BY updated_at DESC, created_at DESC) AS rn
        FROM entries
      )
      WHERE rn = 1
    `);
    const map = new Map<string, { title: string; updatedAt: number }>();
    for (const r of rows) {
      map.set(r.library_id, { title: r.title_summary, updatedAt: r.updated_at });
    }
    return map;
  }

  listHydratedEntries(librarySlug: string, searchQuery?: string): HydratedEntry[] {
    const { byId: allLibsById, bySlug: allLibsBySlug } = this.libraries.ensureCache();
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

    const { forwardBySourceId, backByTargetId } = loadRelationsBatch(
      this.driver,
      rows.map((r) => r.id)
    );
    const parsedJsonCache = new Map<string, Record<string, unknown>>();

    const hydrated = rows.map((row) =>
      hydrateRowWithRelations(
        row,
        lib,
        allLibsById,
        allLibsBySlug,
        forwardBySourceId.get(row.id) ?? [],
        backByTargetId.get(row.id) ?? [],
        parsedJsonCache
      )
    );

    return sortHydratedEntries(hydrated, lib.views.card);
  }

  getHydratedEntryById(entryId: string): { entry: HydratedEntry; library: LibraryRecord } | null {
    const row = this.driver.getFirstSync<RawEntryRow>(
      'SELECT id, library_id, title_summary, data_json, created_at, updated_at FROM entries WHERE id = ?',
      [entryId]
    );
    if (!row) return null;

    const { byId: allLibsById, bySlug: allLibsBySlug } = this.libraries.ensureCache();
    const lib = allLibsById.get(row.library_id);
    if (!lib) return null;

    const { forwardBySourceId, backByTargetId } = loadRelationsBatch(this.driver, [row.id]);
    const parsedJsonCache = new Map<string, Record<string, unknown>>();

    return {
      library: lib,
      entry: hydrateRowWithRelations(
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

  listChildSectionsForEntry(entryId: string, parentLibrarySlug: string): ChildLibrarySection[] {
    const { byId: allLibsById, bySlug: allLibsBySlug } = this.libraries.ensureCache();
    const childLibs = this.libraries.listChildLibraries(parentLibrarySlug);
    if (childLibs.length === 0) return [];

    const sections: ChildLibrarySection[] = [];
    for (const childLib of childLibs) {
      const relField = childLib.fields.find(
        (f) => f.type === 'relation' && f.relationConfig?.targetLibrarySlug === parentLibrarySlug
      );
      if (!relField) continue;

      const rows = this.driver.getAllSync<RawEntryRow>(
        `SELECT s.id, s.library_id, s.title_summary, s.data_json, s.created_at, s.updated_at
         FROM entry_relations r
         JOIN entries s ON s.id = r.source_entry_id
         WHERE r.target_entry_id = ? AND s.library_id = ? AND r.field_key = ?
         ORDER BY s.created_at DESC`,
        [entryId, childLib.id, relField.key]
      );

      if (rows.length === 0) {
        sections.push({
          childLibrary: childLib,
          relationFieldKey: relField.key,
          entries: [],
        });
        continue;
      }

      const { forwardBySourceId, backByTargetId } = loadRelationsBatch(
        this.driver,
        rows.map((r) => r.id)
      );
      const parsedJsonCache = new Map<string, Record<string, unknown>>();
      const hydrated = rows.map((row) =>
        hydrateRowWithRelations(
          row,
          childLib,
          allLibsById,
          allLibsBySlug,
          forwardBySourceId.get(row.id) ?? [],
          backByTargetId.get(row.id) ?? [],
          parsedJsonCache
        )
      );

      sortHydratedEntries(hydrated, childLib.views.card);

      sections.push({
        childLibrary: childLib,
        relationFieldKey: relField.key,
        entries: hydrated,
      });
    }

    return sections;
  }

  listBacklinkGroupsForEntry(
    entryId: string,
    excludeLibrarySlugs?: Set<string>
  ): BacklinkGroupSection[] {
    const { byId: allLibsById, bySlug: allLibsBySlug } = this.libraries.ensureCache();

    const rawRows = this.driver.getAllSync<RawEntryRow & { field_key: string }>(
      `SELECT
         r.field_key,
         s.id,
         s.library_id,
         s.title_summary,
         s.data_json,
         s.created_at,
         s.updated_at
       FROM entry_relations r
       JOIN entries s ON s.id = r.source_entry_id
       WHERE r.target_entry_id = ?
       ORDER BY s.created_at DESC`,
      [entryId]
    );

    const filteredRows = rawRows.filter((row) => {
      const srcLib = allLibsById.get(row.library_id);
      if (!srcLib) return false;
      if (excludeLibrarySlugs?.has(srcLib.slug)) return false;
      return true;
    });

    if (filteredRows.length === 0) return [];

    const uniqueEntryIds = Array.from(new Set(filteredRows.map((r) => r.id)));
    const { forwardBySourceId, backByTargetId } = loadRelationsBatch(this.driver, uniqueEntryIds);
    const parsedJsonCache = new Map<string, Record<string, unknown>>();
    const hydratedById = new Map<string, HydratedEntry>();

    for (const row of filteredRows) {
      if (hydratedById.has(row.id)) continue;
      const srcLib = allLibsById.get(row.library_id)!;
      hydratedById.set(
        row.id,
        hydrateRowWithRelations(
          row,
          srcLib,
          allLibsById,
          allLibsBySlug,
          forwardBySourceId.get(row.id) ?? [],
          backByTargetId.get(row.id) ?? [],
          parsedJsonCache
        )
      );
    }

    const groupMap = new Map<
      string,
      {
        sourceLibrary: LibraryRecord;
        relationFieldKey: string;
        relationFieldLabel: string;
        entries: HydratedEntry[];
        seenEntryIds: Set<string>;
      }
    >();

    for (const row of filteredRows) {
      const srcLib = allLibsById.get(row.library_id)!;
      const groupKey = `${srcLib.slug}::${row.field_key}`;
      let group = groupMap.get(groupKey);
      if (!group) {
        const relField = srcLib.fields.find((f) => f.key === row.field_key);
        group = {
          sourceLibrary: srcLib,
          relationFieldKey: row.field_key,
          relationFieldLabel: relField?.label ?? '关联记录',
          entries: [],
          seenEntryIds: new Set<string>(),
        };
        groupMap.set(groupKey, group);
      }
      if (!group.seenEntryIds.has(row.id)) {
        group.seenEntryIds.add(row.id);
        const hydrated = hydratedById.get(row.id);
        if (hydrated) group.entries.push(hydrated);
      }
    }

    const sections: BacklinkGroupSection[] = [];
    for (const g of groupMap.values()) {
      sortHydratedEntries(g.entries, g.sourceLibrary.views.card);
      sections.push({
        sourceLibrary: g.sourceLibrary,
        relationFieldKey: g.relationFieldKey,
        relationFieldLabel: g.relationFieldLabel,
        entries: g.entries,
      });
    }

    return sections;
  }

  listRelationCandidates(
    targetLibrarySlug: string,
    searchQuery?: string,
    limit = 200
  ): Array<{ id: string; title: string }> {
    const lib = this.libraries.getLibraryBySlug(targetLibrarySlug);
    if (!lib) return [];
    const trimmed = searchQuery?.trim();
    if (trimmed) {
      const escaped = escapeLikePattern(trimmed.toLowerCase());
      return this.driver
        .getAllSync<{ id: string; title_summary: string }>(
          `SELECT id, title_summary
           FROM entries
           WHERE library_id = ? AND search_text LIKE ? ESCAPE '\\'
           ORDER BY updated_at DESC
           LIMIT ?`,
          [lib.id, `%${escaped}%`, limit]
        )
        .map((r) => ({ id: r.id, title: r.title_summary }));
    }
    return this.driver
      .getAllSync<{ id: string; title_summary: string }>(
        'SELECT id, title_summary FROM entries WHERE library_id = ? ORDER BY updated_at DESC LIMIT ?',
        [lib.id, limit]
      )
      .map((r) => ({ id: r.id, title: r.title_summary }));
  }

  /**
   * 收集所有被现有条目或未撤销快照引用的本地图片相对路径，供安全清理孤儿图片使用
   */
  collectReferencedImagePaths(): Set<string> {
    const refs = new Set<string>();
    const entryRows = this.driver.getAllSync<{ data_json: string }>(
      "SELECT data_json FROM entries WHERE data_json LIKE '%images/img_%'"
    );
    for (const r of entryRows) {
      const matches = r.data_json.match(RELATIVE_IMAGE_REGEX);
      if (matches) {
        for (const m of matches) refs.add(m);
      }
    }
    const snapRows = this.driver.getAllSync<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM ai_snapshots WHERE undone = 0 AND snapshot_json LIKE '%images/img_%'"
    );
    for (const r of snapRows) {
      const matches = r.snapshot_json.match(RELATIVE_IMAGE_REGEX);
      if (matches) {
        for (const m of matches) refs.add(m);
      }
    }
    return refs;
  }

  insertRawEntry(e: Record<string, unknown>): void {
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

  insertRawRelationsSafe(relations: Array<Record<string, unknown>>): void {
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
}
