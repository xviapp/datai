import {
  resolveDraftDataForCommit,
  type CommitDraftEntryItem,
} from '@/engine/capture-drafts';
import { createId } from '@/engine/id';
import { buildEntryPayloadValidator, type FieldDef, type FieldType } from '@/schema/field-defs';
import {
  hydrateRowWithRelations,
  loadRelationsBatch,
  sortHydratedEntries,
} from '../hydration';
import type {
  BacklinkGroupSection,
  ChildLibrarySection,
  EntrySearchHit,
  HydratedEntry,
  LibraryRecord,
  RawEntryRow,
} from '../models';
import { escapeLikePattern, type SyncSqlDriver } from '../types';
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
      const rawTargets = data[f.key];
      const targets = Array.isArray(rawTargets)
        ? rawTargets.map(String).filter(Boolean)
        : typeof rawTargets === 'string' && rawTargets.trim()
          ? [rawTargets.trim()]
          : [];

      const targetLib = f.relationConfig?.targetLibrarySlug
        ? this.libraries.getLibraryBySlug(f.relationConfig.targetLibrarySlug)
        : null;

      targets.forEach((targetId, idx) => {
        const exists = targetLib
          ? this.driver.getFirstSync<{ id: string }>(
              'SELECT id FROM entries WHERE id = ? AND library_id = ?',
              [targetId, targetLib.id]
            )
          : this.driver.getFirstSync<{ id: string }>(
              'SELECT id FROM entries WHERE id = ?',
              [targetId]
            );
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
   * 解绑所有反向引用并删除单条记录，返回用于增量撤销的上下文负载
   */
  deleteEntryWithDetachInternal(entryId: string): {
    entryRow: Record<string, unknown>;
    relRows: Array<Record<string, unknown>>;
    detachedSources: Array<{ id: string; prevDataJson: string }>;
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

    const fieldsBySourceId = new Map<string, Set<string>>();
    for (const r of relRows) {
      if (String(r.target_entry_id) === entryId) {
        const srcId = String(r.source_entry_id);
        let keys = fieldsBySourceId.get(srcId);
        if (!keys) {
          keys = new Set<string>();
          fieldsBySourceId.set(srcId, keys);
        }
        keys.add(String(r.field_key));
      }
    }

    const detachedSources: Array<{ id: string; prevDataJson: string }> = [];
    for (const [srcId, fieldKeys] of fieldsBySourceId.entries()) {
      const srcRow = this.driver.getFirstSync<{ id: string; data_json: string }>(
        'SELECT id, data_json FROM entries WHERE id = ?',
        [srcId]
      );
      if (!srcRow) continue;
      detachedSources.push({ id: srcRow.id, prevDataJson: srcRow.data_json });
      try {
        const parsedData = JSON.parse(srcRow.data_json) as Record<string, unknown>;
        for (const fk of fieldKeys) {
          const cur = parsedData[fk];
          if (Array.isArray(cur)) {
            parsedData[fk] = cur.map(String).filter((id) => id !== entryId);
          } else if (cur === entryId) {
            parsedData[fk] = [];
          }
        }
        this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
          JSON.stringify(parsedData),
          srcRow.id,
        ]);
      } catch {
        // ignore malformed payload
      }
    }

    this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
    return { entryRow, relRows, detachedSources };
  }

  commitOmniDraftsInternal(drafts: readonly CommitDraftEntryItem[]): string[] {
    const createdIds: string[] = [];
    const createdIdByDraftId = new Map<string, string>();
    drafts.forEach((draft) => {
      const lib = this.libraries.getLibraryBySlug(draft.librarySlug);
      const resolved = resolveDraftDataForCommit(draft, lib, createdIds, createdIdByDraftId);
      const newId = this.createEntryInternal(draft.librarySlug, resolved);
      createdIds.push(newId);
      if (draft.draftId) {
        createdIdByDraftId.set(draft.draftId, newId);
      }
    });
    return createdIds;
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

  listRelationCandidates(targetLibrarySlug: string): Array<{ id: string; title: string }> {
    const lib = this.libraries.getLibraryBySlug(targetLibrarySlug);
    if (!lib) return [];
    return this.driver
      .getAllSync<{ id: string; title_summary: string }>(
        'SELECT id, title_summary FROM entries WHERE library_id = ? ORDER BY updated_at DESC LIMIT 200',
        [lib.id]
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
