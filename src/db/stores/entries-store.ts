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
  ConvertedFieldBackup,
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

/**
 * 提取记录本字段定义中与 entry_relations 相关的规范化签名（与字段顺序无关），
 * 供结构变更与建库方案撤销判断是否真正需要重建 entry_relations。
 */
export function getRelationFieldsSignature(fields: readonly FieldDef[]): string {
  return JSON.stringify(
    fields
      .filter((f) => f.type === 'relation')
      .map(
        (f) =>
          [
            f.key,
            f.relationConfig?.targetLibrarySlug ?? '',
            f.relationConfig?.allowMultiple ?? true,
          ] as const
      )
      .sort((a, b) => a[0].localeCompare(b[0]))
  );
}

export interface DeferredMissingSource {
  id: string;
  prevDataJson: string;
  missingByField: Record<string, string[]>;
}

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

  /**
   * 更新单条记录的 data_json，并同步重算 title_summary 与 search_text（供撤销恢复非关联字段值使用）
   */
  persistEntryDataAndMetadataInternal(
    entryId: string,
    lib: LibraryRecord,
    data: Record<string, unknown>
  ): void {
    const { titleSummary, searchText } = this.computeTitleAndSearch(lib, data);
    this.driver.runSync(
      'UPDATE entries SET title_summary = ?, search_text = ?, data_json = ? WHERE id = ?',
      [titleSummary, searchText, JSON.stringify(data), entryId]
    );
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
   * 批量查询一批条目 ID 的所属 library_id 映射（按 400 条分片，避免超长列表逐条 SELECT）
   */
  private loadEntryLibraryIdMap(entryIds: readonly string[]): Map<string, string> {
    const map = new Map<string, string>();
    const unique = Array.from(new Set(entryIds.filter(Boolean)));
    for (let i = 0; i < unique.length; i += ENTRY_QUERY_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + ENTRY_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.driver.getAllSync<{ id: string; library_id: string }>(
        `SELECT id, library_id FROM entries WHERE id IN (${placeholders})`,
        chunk
      );
      for (const r of rows) {
        map.set(r.id, r.library_id);
      }
    }
    return map;
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

    const relationFields = fields.filter((f) => f.type === 'relation');
    if (relationFields.length === 0) return;

    const targetsByField: Array<{ field: FieldDef; targets: string[] }> = [];
    const allCandidateIds: string[] = [];
    for (const f of relationFields) {
      const targets = Array.from(new Set(normalizeRelationValueList(data[f.key]))).filter(
        (id) => !isBatchRefToken(id)
      );
      if (targets.length === 0) continue;
      targetsByField.push({ field: f, targets });
      allCandidateIds.push(...targets);
    }
    if (targetsByField.length === 0) return;

    const targetLibIdByEntryId = this.loadEntryLibraryIdMap(allCandidateIds);

    for (const { field: f, targets } of targetsByField) {
      const targetSlug = f.relationConfig?.targetLibrarySlug;
      const targetLib = targetSlug ? this.libraries.getLibraryBySlug(targetSlug) : null;
      if (targetSlug && !targetLib) continue;

      const validTargets: string[] = [];
      for (const targetId of targets) {
        const actualLibId = targetLibIdByEntryId.get(targetId);
        if (!actualLibId) continue;
        if (targetLib && actualLibId !== targetLib.id) continue;
        validTargets.push(targetId);
        if (f.relationConfig?.allowMultiple === false) break;
      }

      validTargets.forEach((targetId, idx) => {
        this.driver.runSync(
          `INSERT OR IGNORE INTO entry_relations (id, source_entry_id, target_entry_id, source_library_id, field_key, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [createId('rel'), entryId, targetId, libraryId, f.key, idx]
        );
      });
    }
  }

  /**
   * 当记录本新增/修改 relation 字段或导入备份后，按最新字段定义为该库全部条目补建/刷新 entry_relations 索引：
   * - 自动剥离已失效/归属错误目标库或超出单选上限的 ID，并将非关联字段转换后的标量原值规范化为 []，保证字段值与索引严格一致且记录保持可编辑；
   * - 返回每条实际被裁剪/剥离或涉及非关联->关联类型转换的记录快照（含原 data_json、removedByField 与 convertedFields），供建库方案撤销时无损还原。
   */
  syncLibraryEntryRelationsInternal(
    libraryId: string,
    options?: { convertedFromTypeByField?: ReadonlyMap<string, FieldType> }
  ): DetachedSourceRecord[] {
    const lib = this.libraries.getLibraryById(libraryId);
    if (!lib) return [];

    const relationFields = lib.fields.filter((f) => f.type === 'relation');
    if (relationFields.length === 0) {
      this.driver.runSync('DELETE FROM entry_relations WHERE source_library_id = ?', [lib.id]);
      return [];
    }

    const rows = this.driver.getAllSync<{ id: string; data_json: string }>(
      'SELECT id, data_json FROM entries WHERE library_id = ?',
      [lib.id]
    );
    if (rows.length === 0) return [];

    const { bySlug } = this.libraries.ensureCache();
    const entryLibCache = new Map<string, string | null>();
    const getEntryLibraryId = (entryId: string): string | null => {
      if (entryLibCache.has(entryId)) {
        return entryLibCache.get(entryId) ?? null;
      }
      const found = this.driver.getFirstSync<{ library_id: string }>(
        'SELECT library_id FROM entries WHERE id = ?',
        [entryId]
      );
      const actualLibId = found?.library_id ?? null;
      entryLibCache.set(entryId, actualLibId);
      return actualLibId;
    };

    const convertedFromTypeByField = options?.convertedFromTypeByField;
    const modifiedSources: DetachedSourceRecord[] = [];
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

      let dataChanged = false;
      const removedByField: Record<string, string[]> = {};
      const convertedFields: Record<string, ConvertedFieldBackup> = {};

      for (const f of relationFields) {
        const convertedFromType = convertedFromTypeByField?.get(f.key);
        const rawValue = parsed[f.key];
        if (convertedFromType) {
          const hadValue = Object.prototype.hasOwnProperty.call(parsed, f.key);
          convertedFields[f.key] = {
            fromType: convertedFromType,
            hadValue,
            ...(hadValue ? { prevValue: rawValue } : {}),
          };
        }

        const rawTokens = normalizeRelationValueList(rawValue);
        const uniqueTargets = Array.from(new Set(rawTokens));
        if (uniqueTargets.length === 0) {
          // 字段刚由非关联类型（如 number 42、checkbox true/false、空字符串）转为关联时，将非数组旧值规范化为 []
          if (
            rawValue !== undefined &&
            rawValue !== null &&
            !(Array.isArray(rawValue) && rawValue.length === 0)
          ) {
            parsed[f.key] = [];
            dataChanged = true;
          }
          continue;
        }

        const targetSlug = f.relationConfig?.targetLibrarySlug;
        const targetLib = targetSlug ? (bySlug.get(targetSlug) ?? null) : null;

        const validTargets: string[] = [];
        for (const targetId of uniqueTargets) {
          if (isBatchRefToken(targetId)) continue;
          const actualLibId = getEntryLibraryId(targetId);
          if (!actualLibId) continue;
          if (targetSlug && (!targetLib || actualLibId !== targetLib.id)) continue;
          validTargets.push(targetId);
        }

        const finalTargets =
          f.relationConfig?.allowMultiple === false ? validTargets.slice(0, 1) : validTargets;
        const finalSet = new Set(finalTargets);
        const removed = uniqueTargets.filter((id) => !finalSet.has(id));

        if (
          removed.length > 0 ||
          !Array.isArray(rawValue) ||
          finalTargets.length !== rawTokens.length ||
          finalTargets.some((id, idx) => id !== rawTokens[idx])
        ) {
          parsed[f.key] = finalTargets;
          dataChanged = true;
          if (removed.length > 0 && !convertedFromType) {
            removedByField[f.key] = removed;
          }
        }
      }

      if (dataChanged) {
        this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
          JSON.stringify(parsed),
          row.id,
        ]);
      }

      const hasRemoved = Object.keys(removedByField).length > 0;
      const hasConverted = Object.keys(convertedFields).length > 0;
      if (hasRemoved || hasConverted) {
        modifiedSources.push({
          id: row.id,
          prevDataJson: row.data_json,
          ...(hasRemoved ? { removedByField } : {}),
          ...(hasConverted ? { convertedFields } : {}),
        });
      }

      this.syncEntryRelationsNonStrictInternal(row.id, lib.id, lib.fields, parsed);
    }

    return modifiedSources;
  }

  /**
   * 恢复被删条目后，按所属库当前字段定义校验并清洗被恢复条目自身的关联字段，再重建其正向 entry_relations：
   * - 剔除明确归属错误目标库、未解析草稿引用、超出单选上限以及当前已删除（不在 entries 表）的目标 ID，保证恢复后立即可编辑保存；
   * - 返回因目标尚未恢复而被剥离的条目与目标 ID 映射（DeferredMissingSource[]），供上层挂接到待撤销的目标快照中，
   *   当目标后续被恢复时可自动无损还原关联。
   */
  sanitizeRestoredEntryRelationsInternal(entryIds: readonly string[]): DeferredMissingSource[] {
    const uniqueIds = Array.from(new Set(entryIds.filter(Boolean)));
    if (uniqueIds.length === 0) return [];

    this.libraries.invalidateCache();
    const { byId, bySlug } = this.libraries.ensureCache();
    const deferredSources: DeferredMissingSource[] = [];

    for (const entryId of uniqueIds) {
      const row = this.driver.getFirstSync<{ id: string; library_id: string; data_json: string }>(
        'SELECT id, library_id, data_json FROM entries WHERE id = ?',
        [entryId]
      );
      if (!row) continue;

      const lib = byId.get(row.library_id);
      if (!lib) continue;

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

      let dataChanged = false;
      const missingByField: Record<string, string[]> = {};
      for (const f of lib.fields) {
        if (f.type !== 'relation') continue;
        const rawTokens = normalizeRelationValueList(parsed[f.key]);
        const uniqueTokens = Array.from(new Set(rawTokens));
        if (uniqueTokens.length === 0) continue;

        const targetSlug = f.relationConfig?.targetLibrarySlug;
        const targetLib = targetSlug ? (bySlug.get(targetSlug) ?? null) : null;
        const targetLibIdByEntryId = this.loadEntryLibraryIdMap(
          uniqueTokens.filter((t) => !isBatchRefToken(t))
        );

        const validExistingTokens: string[] = [];
        const missingTokens: string[] = [];
        for (const token of uniqueTokens) {
          if (isBatchRefToken(token)) {
            dataChanged = true;
            continue;
          }
          const actualLibId = targetLibIdByEntryId.get(token);
          if (actualLibId) {
            if (targetSlug && (!targetLib || actualLibId !== targetLib.id)) {
              dataChanged = true;
              continue;
            }
            validExistingTokens.push(token);
          } else {
            missingTokens.push(token);
            dataChanged = true;
          }
        }

        let finalTokens = validExistingTokens;
        if (f.relationConfig?.allowMultiple === false && finalTokens.length > 1) {
          finalTokens = [finalTokens[0]];
          dataChanged = true;
        }

        if (missingTokens.length > 0) {
          missingByField[f.key] = missingTokens;
        }

        if (
          finalTokens.length !== rawTokens.length ||
          finalTokens.some((token, idx) => token !== rawTokens[idx])
        ) {
          parsed[f.key] = finalTokens;
          dataChanged = true;
        }
      }

      if (dataChanged) {
        this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
          JSON.stringify(parsed),
          row.id,
        ]);
      }

      if (Object.keys(missingByField).length > 0) {
        deferredSources.push({
          id: row.id,
          prevDataJson: row.data_json,
          missingByField,
        });
      }

      this.syncEntryRelationsNonStrictInternal(row.id, lib.id, lib.fields, parsed);
    }

    return deferredSources;
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
   * - 仅对 JSON.parse 捕获格式错误，SQLite UPDATE 异常直接抛出以触发事务回滚。
   */
  detachReferencesToEntriesInternal(targetEntryIds: readonly string[]): DetachedSourceRecord[] {
    const targetIdSet = new Set(targetEntryIds.filter(Boolean));
    if (targetIdSet.size === 0) return [];

    const fieldsBySourceId = new Map<string, Set<string>>();

    const addFieldForSource = (srcId: string, fieldKey: string) => {
      if (targetIdSet.has(srcId)) return;
      let keys = fieldsBySourceId.get(srcId);
      if (!keys) {
        keys = new Set<string>();
        fieldsBySourceId.set(srcId, keys);
      }
      keys.add(fieldKey);
    };

    const uniqueTargets = Array.from(targetIdSet);
    const targetLibSlugs = new Set<string>();

    const { byId } = this.libraries.ensureCache();
    for (let i = 0; i < uniqueTargets.length; i += ENTRY_QUERY_CHUNK_SIZE) {
      const chunk = uniqueTargets.slice(i, i + ENTRY_QUERY_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const relRows = this.driver.getAllSync<{ source_entry_id: string; field_key: string }>(
        `SELECT source_entry_id, field_key FROM entry_relations WHERE target_entry_id IN (${placeholders})`,
        chunk
      );
      for (const r of relRows) {
        addFieldForSource(r.source_entry_id, r.field_key);
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

    // 仅定向检查关联目标属于 targetLibSlugs 的来源库，绝不读取无关记录本
    if (targetLibSlugs.size > 0) {
      const allLibs = this.libraries.listLibraries();
      for (const lib of allLibs) {
        const matchingFields = lib.fields.filter(
          (f) =>
            f.type === 'relation' &&
            (!f.relationConfig?.targetLibrarySlug ||
              targetLibSlugs.has(f.relationConfig.targetLibrarySlug))
        );
        if (matchingFields.length === 0) continue;

        let candidateRows: Array<{ id: string; data_json: string }>;
        if (uniqueTargets.length <= 20) {
          const likeClauses = uniqueTargets.map(() => "data_json LIKE ? ESCAPE '\\'").join(' OR ');
          const likeParams: SqlParam[] = [
            lib.id,
            ...uniqueTargets.map((id) => `%${escapeLikePattern(id)}%`),
          ];
          candidateRows = this.driver.getAllSync<{ id: string; data_json: string }>(
            `SELECT id, data_json FROM entries WHERE library_id = ? AND (${likeClauses})`,
            likeParams
          );
        } else {
          candidateRows = this.driver.getAllSync<{ id: string; data_json: string }>(
            'SELECT id, data_json FROM entries WHERE library_id = ?',
            [lib.id]
          );
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
            if (tokens.some((id) => targetIdSet.has(id))) {
              addFieldForSource(r.id, f.key);
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

      const removedByField: Record<string, string[]> = {};
      let changed = false;
      for (const fk of fieldKeys) {
        const curTokens = normalizeRelationValueList(parsedData[fk]);
        if (curTokens.length === 0) continue;
        const removed = curTokens.filter((id) => targetIdSet.has(id));
        if (removed.length === 0) continue;
        parsedData[fk] = curTokens.filter((id) => !targetIdSet.has(id));
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
   * 清理存活记录中指向指定记录本全部条目的引用
   */
  detachReferencesToLibraryInternal(librarySlug: string): DetachedSourceRecord[] {
    const libRow = this.driver.getFirstSync<{ id: string }>(
      'SELECT id FROM libraries WHERE slug = ?',
      [librarySlug]
    );
    if (!libRow) return [];
    const entryIds = this.driver
      .getAllSync<{ id: string }>('SELECT id FROM entries WHERE library_id = ?', [libRow.id])
      .map((r) => r.id);
    return this.detachReferencesToEntriesInternal(entryIds);
  }

  /**
   * 解绑所有反向引用并删除单条记录，返回用于增量撤销的上下文负载
   */
  deleteEntryWithDetachInternal(entryId: string): {
    entryRow: Record<string, unknown>;
    detachedSources: DetachedSourceRecord[];
  } | null {
    const entryRow = this.driver.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM entries WHERE id = ?',
      [entryId]
    );
    if (!entryRow) return null;

    const detachedSources = this.detachReferencesToEntriesInternal([entryId]);
    this.driver.runSync('DELETE FROM entries WHERE id = ?', [entryId]);
    return { entryRow, detachedSources };
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
}
