import type { ArchitectPlan } from '@/ai/schemas';
import { isBatchRefToken } from '@/engine/capture-drafts';
import { createId } from '@/engine/id';
import {
  normalizeRelationValueList,
  type FieldDef,
  type FieldType,
} from '@/schema/field-defs';
import type { LibraryLayoutBundle } from '@/schema/view-dsl';
import { MAX_AI_SNAPSHOTS } from '../migrations';
import type {
  AiSnapshotItem,
  ArchitectFieldTypeChange,
  ArchitectLibraryDiff,
  DetachedSourceRecord,
  SnapshotPayload,
  SnapshotUndoImpact,
} from '../models';
import { sqlReferencesLibraryView, type SyncSqlDriver } from '../types';
import { compileLibrarySqlView, dropLibrarySqlView } from '../view-compiler';
import {
  getRelationFieldsSignature,
  type DeferredMissingSource,
  type EntriesStore,
} from './entries-store';
import type { LibrariesStore } from './libraries-store';
import type { WidgetsStore } from './widgets-store';

function isEmptyRestorableValue(val: unknown): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') return val.trim() === '';
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed json
  }
  return {};
}

function cloneDetachedSourceRecord(src: DetachedSourceRecord): DetachedSourceRecord {
  const cloned: DetachedSourceRecord = {
    id: src.id,
    prevDataJson: src.prevDataJson,
  };
  if (src.removedByField && Object.keys(src.removedByField).length > 0) {
    cloned.removedByField = Object.fromEntries(
      Object.entries(src.removedByField).map(([fk, ids]) => [fk, [...ids]])
    );
  }
  if (src.convertedFields && Object.keys(src.convertedFields).length > 0) {
    cloned.convertedFields = Object.fromEntries(
      Object.entries(src.convertedFields).map(([fk, backup]) => [fk, { ...backup }])
    );
  }
  return cloned;
}

function isCompatibleFieldTypeChange(fromType: FieldType, toType: FieldType): boolean {
  if (fromType === toType) return true;
  const numericTypes = new Set<FieldType>(['number', 'currency', 'rating']);
  if (numericTypes.has(fromType) && numericTypes.has(toType)) return true;
  const stringTypes = new Set<FieldType>(['text', 'select', 'date']);
  if (stringTypes.has(fromType) && stringTypes.has(toType)) return true;
  return false;
}

/**
 * 线性时间 O(N + M) 合并撤销恢复的多选关联 ID：
 * - existingTokens 为空时直接按 prevOrder 顺序输出，避免大批量恢复阻塞主线程；
 * - existingTokens 非空时严格保持用户现有选择的相对顺序不变，
 *   通过前缀最大位置/最近前驱与后缀最小位置数组将待恢复 ID 一次性分桶插回对应锚点。
 */
function mergeRestoredRelationOrder(
  existingTokens: readonly string[],
  validToRestore: readonly string[],
  prevOrder: readonly string[]
): string[] {
  const existing = Array.from(new Set(existingTokens));
  const uniqueRestore = Array.from(new Set(validToRestore));
  if (uniqueRestore.length === 0) return existing;

  const uniquePrev = Array.from(new Set(prevOrder));
  if (existing.length === 0) {
    const restoreSet = new Set(uniqueRestore);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of uniquePrev) {
      if (restoreSet.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const id of uniqueRestore) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  const existingPos = new Map<string, number>();
  existing.forEach((id, idx) => existingPos.set(id, idx));

  const toInsertSet = new Set<string>();
  for (const id of uniqueRestore) {
    if (!existingPos.has(id)) {
      toInsertSet.add(id);
    }
  }
  if (toInsertSet.size === 0) return existing;

  const len = uniquePrev.length;
  const prefixMaxPos = new Array<number>(len).fill(-1);
  const nearestPredPos = new Array<number>(len).fill(-1);
  let runningMax = -1;
  let lastPred = -1;
  for (let i = 0; i < len; i++) {
    prefixMaxPos[i] = runningMax;
    nearestPredPos[i] = lastPred;
    const pos = existingPos.get(uniquePrev[i]);
    if (pos !== undefined) {
      if (pos > runningMax) runningMax = pos;
      lastPred = pos;
    }
  }

  const suffixMinPos = new Array<number>(len).fill(Infinity);
  let runningMin = Infinity;
  for (let i = len - 1; i >= 0; i--) {
    suffixMinPos[i] = runningMin;
    const pos = existingPos.get(uniquePrev[i]);
    if (pos !== undefined && pos < runningMin) {
      runningMin = pos;
    }
  }

  const buckets: string[][] = Array.from({ length: existing.length + 1 }, () => []);
  const placed = new Set<string>();
  for (let i = 0; i < len; i++) {
    const id = uniquePrev[i];
    if (!toInsertSet.has(id)) continue;
    placed.add(id);

    const hasPred = prefixMaxPos[i] !== -1;
    const hasSucc = suffixMinPos[i] !== Infinity;
    let bucket = existing.length;
    if (hasPred && !hasSucc) {
      bucket = prefixMaxPos[i] + 1;
    } else if (!hasPred && hasSucc) {
      bucket = suffixMinPos[i];
    } else if (hasPred && hasSucc) {
      bucket = prefixMaxPos[i] < suffixMinPos[i] ? prefixMaxPos[i] + 1 : nearestPredPos[i] + 1;
    }
    buckets[bucket].push(id);
  }

  for (const id of uniqueRestore) {
    if (toInsertSet.has(id) && !placed.has(id)) {
      buckets[existing.length].push(id);
    }
  }

  const out: string[] = [];
  for (let slot = 0; slot < existing.length; slot++) {
    for (const id of buckets[slot]) out.push(id);
    out.push(existing[slot]);
  }
  for (const id of buckets[existing.length]) out.push(id);
  return out;
}

/**
 * 合并同一来源条目的两份待恢复记录（DetachedSourceRecord）：
 * - 合并 prevDataJson 中关联字段的相对顺序，确保多次分次删除后任意顺序恢复均不颠倒顺序；
 * - 一并保留与合并 convertedFields（字段转换前的类型与原值）。
 */
function mergeDetachedSourceRecord(
  existing: DetachedSourceRecord,
  incoming: DetachedSourceRecord
): void {
  const existingPrev = parseJsonObject(existing.prevDataJson);
  const incomingPrev = parseJsonObject(incoming.prevDataJson);

  const existingRemoved = existing.removedByField ?? {};
  const incomingRemoved = incoming.removedByField ?? {};
  const relFieldKeys = new Set([
    ...Object.keys(existingRemoved),
    ...Object.keys(incomingRemoved),
  ]);

  const mergedRemoved: Record<string, string[]> = {};
  for (const fk of relFieldKeys) {
    const existingOrder = normalizeRelationValueList(existingPrev[fk]);
    const incomingOrder = normalizeRelationValueList(incomingPrev[fk]);

    let mergedOrder: string[];
    if (existingOrder.length === 0) {
      mergedOrder = incomingOrder;
    } else if (incomingOrder.length === 0) {
      mergedOrder = existingOrder;
    } else {
      mergedOrder = mergeRestoredRelationOrder(existingOrder, incomingOrder, incomingOrder);
    }

    if (mergedOrder.length > 0) {
      existingPrev[fk] = mergedOrder;
    }

    const curIds = existingRemoved[fk] ?? [];
    const addIds = incomingRemoved[fk] ?? [];
    const combinedIds = Array.from(new Set([...curIds, ...addIds]));
    if (mergedOrder.length > 0) {
      const orderPos = new Map(mergedOrder.map((id, idx) => [id, idx]));
      combinedIds.sort((a, b) => {
        const pa = orderPos.get(a);
        const pb = orderPos.get(b);
        if (pa === undefined && pb === undefined) return 0;
        if (pa === undefined) return 1;
        if (pb === undefined) return -1;
        return pa - pb;
      });
    }
    if (combinedIds.length > 0) {
      mergedRemoved[fk] = combinedIds;
    }
  }

  for (const [k, v] of Object.entries(incomingPrev)) {
    if (!relFieldKeys.has(k) && !Object.prototype.hasOwnProperty.call(existingPrev, k)) {
      existingPrev[k] = v;
    }
  }

  if (incoming.convertedFields && Object.keys(incoming.convertedFields).length > 0) {
    existing.convertedFields = {
      ...(existing.convertedFields ?? {}),
      ...Object.fromEntries(
        Object.entries(incoming.convertedFields).map(([fk, backup]) => [fk, { ...backup }])
      ),
    };
  }

  existing.prevDataJson = JSON.stringify(existingPrev);
  existing.removedByField = Object.keys(mergedRemoved).length > 0 ? mergedRemoved : undefined;
}

export class SnapshotsStore {
  constructor(
    private driver: SyncSqlDriver,
    private libraries: LibrariesStore,
    private entries: EntriesStore,
    private widgets: WidgetsStore
  ) {}

  saveSnapshotInternal(summary: string, payload: SnapshotPayload): string {
    const id = createId('snap');
    this.driver.runSync(
      `INSERT INTO ai_snapshots (id, action_summary, snapshot_json, undone, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [id, summary, JSON.stringify(payload), Date.now()]
    );
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

  analyzeArchitectPlanDiff(plan: ArchitectPlan): ArchitectLibraryDiff[] {
    const diffs: ArchitectLibraryDiff[] = [];

    for (const bp of plan.libraries) {
      const existing = this.libraries.getLibraryBySlug(bp.slug);
      if (!existing) continue;

      const nextByKey = new Map(bp.fields.map((f) => [f.key, f]));
      const removedFields: ArchitectLibraryDiff['removedFields'] = [];
      const typeChangedFields: ArchitectFieldTypeChange[] = [];
      const newlyRequiredFields: ArchitectLibraryDiff['newlyRequiredFields'] = [];

      for (const oldField of existing.fields) {
        const nextField = nextByKey.get(oldField.key);
        if (!nextField) {
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

  applyArchitectPlanInternal(
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
      throw new Error(`方案包含破坏性字段变更，可能导致数据无法显示或保存：${details}`);
    }

    const createdLibraries: Array<{ id: string; slug: string }> = [];
    const previousLibraries: Array<Record<string, unknown>> = [];
    const previousLibraryViews: Array<Record<string, unknown>> = [];
    const trimmedSources: DetachedSourceRecord[] = [];
    let snapshotId = '';

    // 先提交表结构与视图变更（批量末尾统一同步一次 library_relations），再校验并保存看板图表
    this.driver.withTransactionSync(() => {
      const seenSlugs = new Set<string>();
      const createdSlugSet = new Set<string>();
      const originalFieldsByLibId = new Map<string, FieldDef[]>();

      for (const bp of plan.libraries) {
        if (seenSlugs.has(bp.slug)) continue;
        seenSlugs.add(bp.slug);
        const existingRaw = this.driver.getFirstSync<Record<string, unknown>>(
          'SELECT * FROM libraries WHERE slug = ?',
          [bp.slug]
        );
        if (existingRaw) {
          previousLibraries.push(existingRaw);
          const existingId = String(existingRaw.id);
          try {
            originalFieldsByLibId.set(
              existingId,
              JSON.parse(String(existingRaw.fields_json ?? '[]')) as FieldDef[]
            );
          } catch {
            originalFieldsByLibId.set(existingId, []);
          }
          const prevViews = this.driver.getAllSync<Record<string, unknown>>(
            'SELECT * FROM library_views WHERE library_id = ? ORDER BY sort_order ASC',
            [existingId]
          );
          previousLibraryViews.push(...prevViews);
        } else {
          createdSlugSet.add(bp.slug);
        }
      }

      const recordedCreatedIds = new Set<string>();
      const modifiedExistingLibIds: string[] = [];

      for (const bp of plan.libraries) {
        const libId = this.libraries.upsertLibraryInternal(bp, { skipRelationSync: true });
        if (createdSlugSet.has(bp.slug)) {
          if (!recordedCreatedIds.has(libId)) {
            recordedCreatedIds.add(libId);
            createdLibraries.push({ id: libId, slug: bp.slug });
          }
        } else if (originalFieldsByLibId.has(libId) && !modifiedExistingLibIds.includes(libId)) {
          modifiedExistingLibIds.push(libId);
        }
      }

      this.libraries.syncAllLibraryRelations();
      for (const libId of modifiedExistingLibIds) {
        const originalFields = originalFieldsByLibId.get(libId) ?? [];
        const nextLib = this.libraries.getLibraryById(libId);
        if (!nextLib) continue;

        const prevRelSig = getRelationFieldsSignature(originalFields);
        const nextRelSig = getRelationFieldsSignature(nextLib.fields);
        if (prevRelSig === nextRelSig) continue;

        const prevFieldByKey = new Map(originalFields.map((f) => [f.key, f]));
        const convertedFromTypeByField = new Map<string, FieldType>();
        for (const nextField of nextLib.fields) {
          if (nextField.type !== 'relation') continue;
          const prevField = prevFieldByKey.get(nextField.key);
          if (
            prevField &&
            prevField.type !== 'relation' &&
            prevField.type !== 'rollup' &&
            prevField.type !== 'formula'
          ) {
            convertedFromTypeByField.set(nextField.key, prevField.type);
          }
        }

        trimmedSources.push(
          ...this.entries.syncLibraryEntryRelationsInternal(
            libId,
            convertedFromTypeByField.size > 0 ? { convertedFromTypeByField } : undefined
          )
        );
      }

      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', {
        kind: 'architect_plan',
        createdLibraries,
        previousLibraries,
        previousLibraryViews,
        createdWidgetIds: [],
        ...(trimmedSources.length > 0 ? { trimmedSources } : {}),
      });
    });

    const createdWidgetIds: string[] = [];
    if (plan.dashboardWidgets.length > 0) {
      plan.dashboardWidgets.forEach((w, idx) => {
        try {
          this.driver.queryReadOnlySync(w.readonlySql);
          const { id: wid } = this.widgets.saveDashboardWidgetInternal(w, null, 50 + idx);
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
          createdLibraries,
          previousLibraries,
          previousLibraryViews,
          createdWidgetIds,
          ...(trimmedSources.length > 0 ? { trimmedSources } : {}),
        } satisfies SnapshotPayload),
        snapshotId,
      ]);
    }

    return snapshotId;
  }

  /**
   * 按精确 library.id 匹配 architect_plan 创建且当前仍存活的记录本
   */
  private resolveCreatedLibrariesToDelete(
    createdLibraries: ReadonlyArray<{ id: string; slug: string }>
  ): Array<{ id: string; slug: string }> {
    const matched: Array<{ id: string; slug: string }> = [];
    const seenIds = new Set<string>();
    for (const item of createdLibraries) {
      if (!item?.id || seenIds.has(item.id)) continue;
      const row = this.driver.getFirstSync<{ id: string; slug: string }>(
        'SELECT id, slug FROM libraries WHERE id = ?',
        [item.id]
      );
      if (row) {
        seenIds.add(row.id);
        matched.push(row);
      }
    }
    return matched;
  }

  /**
   * 查询所有尚未撤销的 library_deleted 快照，按被删记录本 ID 建立索引（同一 ID 取最新一条）
   */
  private loadPendingLibraryDeletedSnapshotsByLibIdInternal(): Map<
    string,
    {
      snapId: string;
      payload: Extract<SnapshotPayload, { kind: 'library_deleted' }>;
    }
  > {
    const map = new Map<
      string,
      { snapId: string; payload: Extract<SnapshotPayload, { kind: 'library_deleted' }> }
    >();
    const rows = this.driver.getAllSync<{ id: string; snapshot_json: string }>(
      `SELECT id, snapshot_json
       FROM ai_snapshots
       WHERE undone = 0 AND snapshot_json LIKE '%"library_deleted"%'
       ORDER BY created_at DESC`
    );
    for (const row of rows) {
      let payload: SnapshotPayload | null = null;
      try {
        payload = JSON.parse(row.snapshot_json) as SnapshotPayload;
      } catch {
        payload = null;
      }
      if (!payload || payload.kind !== 'library_deleted') continue;
      const libId = String(payload.library?.id ?? '');
      if (libId && !map.has(libId)) {
        map.set(libId, { snapId: row.id, payload });
      }
    }
    return map;
  }

  describeSnapshotUndoImpact(snapshotId: string): SnapshotUndoImpact {
    const row = this.driver.getFirstSync<{
      action_summary: string;
      snapshot_json: string;
    }>('SELECT action_summary, snapshot_json FROM ai_snapshots WHERE id = ?', [snapshotId]);
    if (!row) {
      throw new Error('该操作记录不存在');
    }

    const payload = JSON.parse(row.snapshot_json) as SnapshotPayload;

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
        affectedEntriesCount: count,
        warningText: `将删除本次添加的 ${count} 条记录，不影响其他数据。`,
      };
    }

    if (payload.kind === 'entry_deleted') {
      return {
        summary: row.action_summary,
        affectedEntriesCount: 1,
        warningText: '将恢复被删除的这条记录及其关联关系，不影响其他数据。',
      };
    }

    if (payload.kind === 'library_deleted') {
      const libName = String(payload.library.name ?? '');
      return {
        summary: row.action_summary,
        affectedEntriesCount: payload.entries.length,
        warningText: `将恢复记录本「${libName}」及其 ${payload.entries.length} 条记录，不影响其他记录本。`,
      };
    }

    const targetLibs = this.resolveCreatedLibrariesToDelete(payload.createdLibraries);
    let newLibEntryCount = 0;
    for (const target of targetLibs) {
      const lib = this.libraries.getLibraryById(target.id);
      if (lib) newLibEntryCount += lib.entryCount;
    }
    const warningText =
      newLibEntryCount > 0
        ? `将移除本次新建的记录本（含此后新增的 ${newLibEntryCount} 条记录），并还原被修改记录本的结构；其他记录本数据不受影响。`
        : '将撤销本次记录本结构与图表变更，其他记录本及已有条目不受影响。';
    return {
      summary: row.action_summary,
      affectedEntriesCount: newLibEntryCount,
      warningText,
    };
  }

  /**
   * 恢复删除记录、删库或建库方案裁剪/转换解绑的字段值与关联：
   * - 校验当前来源库字段类型、目标库及单选约束（不破坏用户后续编辑）；
   * - 当 restoreNonRelationFromPrev=true 时，按 convertedFields 精确还原非关联字段的原类型与原值，并重算标题与搜索文本；
   * - 支持分次撤销对称接力：来源已删时转发至来源快照 deferredSelfRestores；目标已删时转发至目标快照 detachedSources。
   */
  private restoreDetachedSourcesInternal(
    detachedSources: readonly DetachedSourceRecord[] | undefined,
    restoredTargetEntryIds: readonly string[],
    options?: {
      restoreNonRelationFromPrev?: boolean;
      allowDeferredMissingTargets?: boolean;
      preUndoFieldTypeByLibId?: ReadonlyMap<string, ReadonlyMap<string, FieldType>>;
      forceRestoreConvertedFields?: boolean;
    }
  ): void {
    if (!detachedSources || detachedSources.length === 0) return;

    this.libraries.invalidateCache();
    const { byId } = this.libraries.ensureCache();

    const restoredTargetIdSet = new Set(restoredTargetEntryIds.filter(Boolean));
    const restoredTargetSlugById = new Map<string, string>();
    const uniqueRestoredIds = Array.from(restoredTargetIdSet);
    for (let i = 0; i < uniqueRestoredIds.length; i += 400) {
      const chunk = uniqueRestoredIds.slice(i, i + 400);
      const placeholders = chunk.map(() => '?').join(', ');
      const targetRows = this.driver.getAllSync<{ id: string; library_id: string }>(
        `SELECT id, library_id FROM entries WHERE id IN (${placeholders})`,
        chunk
      );
      for (const tr of targetRows) {
        const targetLib = byId.get(tr.library_id);
        if (targetLib) {
          restoredTargetSlugById.set(tr.id, targetLib.slug);
        }
      }
    }

    const deferredMissingSources: DetachedSourceRecord[] = [];
    const deferredMissingTargets: DeferredMissingSource[] = [];

    for (const src of detachedSources) {
      const prevData = parseJsonObject(src.prevDataJson);

      const currentRow = this.driver.getFirstSync<{
        id: string;
        library_id: string;
        data_json: string;
      }>('SELECT id, library_id, data_json FROM entries WHERE id = ?', [src.id]);
      if (!currentRow) {
        const pendingByField: Record<string, string[]> = {};
        if (src.removedByField) {
          for (const [fk, ids] of Object.entries(src.removedByField)) {
            if (!Array.isArray(ids) || ids.length === 0) continue;
            const relevant = options?.allowDeferredMissingTargets
              ? ids.filter((id) => Boolean(id) && !isBatchRefToken(id))
              : ids.filter((id) => restoredTargetIdSet.has(id));
            if (relevant.length > 0) {
              pendingByField[fk] = relevant;
            }
          }
        }
        const pendingConvertedFields =
          options?.restoreNonRelationFromPrev &&
          src.convertedFields &&
          Object.keys(src.convertedFields).length > 0
            ? Object.fromEntries(
                Object.entries(src.convertedFields).map(([fk, backup]) => [fk, { ...backup }])
              )
            : undefined;

        const hasPendingRelations = Object.keys(pendingByField).length > 0;
        const hasPendingConverted = Boolean(
          pendingConvertedFields && Object.keys(pendingConvertedFields).length > 0
        );
        if (hasPendingRelations || hasPendingConverted) {
          deferredMissingSources.push({
            id: src.id,
            prevDataJson: src.prevDataJson,
            ...(hasPendingRelations ? { removedByField: pendingByField } : {}),
            ...(hasPendingConverted ? { convertedFields: pendingConvertedFields } : {}),
          });
        }
        continue;
      }

      const srcLib = byId.get(currentRow.library_id);
      if (!srcLib) continue;
      const fieldByKey = new Map(srcLib.fields.map((f) => [f.key, f]));
      const preUndoFieldTypes = options?.preUndoFieldTypeByLibId?.get(srcLib.id);

      let curData: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(currentRow.data_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          curData = parsed as Record<string, unknown>;
        }
      } catch {
        curData = null;
      }
      if (!curData) continue;

      let dataChanged = false;
      let nonRelationChanged = false;
      const handledConvertedKeys = new Set<string>();

      // 1. 恢复非关联字段转换为关联字段前的精确原值
      if (options?.restoreNonRelationFromPrev && src.convertedFields) {
        for (const [fk, backup] of Object.entries(src.convertedFields)) {
          const fDef = fieldByKey.get(fk);
          if (!fDef || fDef.type === 'relation' || fDef.type !== backup.fromType) continue;
          handledConvertedKeys.add(fk);

          const curVal = curData[fk];
          const preUndoType = preUndoFieldTypes?.get(fk);
          const shouldRestore =
            Boolean(options.forceRestoreConvertedFields) ||
            preUndoType === 'relation' ||
            isEmptyRestorableValue(curVal) ||
            (fDef.type !== 'multi_select' && Array.isArray(curVal));
          if (!shouldRestore) continue;

          if (backup.hadValue) {
            if (
              !Object.prototype.hasOwnProperty.call(curData, fk) ||
              JSON.stringify(curVal) !== JSON.stringify(backup.prevValue)
            ) {
              curData[fk] = backup.prevValue;
              dataChanged = true;
              nonRelationChanged = true;
            }
          } else if (Object.prototype.hasOwnProperty.call(curData, fk)) {
            delete curData[fk];
            dataChanged = true;
            nonRelationChanged = true;
          }
        }
      }

      // 2. 恢复被解绑或裁剪的关联目标 ID
      const missingTargetsByField: Record<string, string[]> = {};
      for (const [fk, candidateIds] of Object.entries(src.removedByField ?? {})) {
        if (handledConvertedKeys.has(fk) || !Array.isArray(candidateIds) || candidateIds.length === 0) {
          continue;
        }
        const fDef = fieldByKey.get(fk);
        if (!fDef || fDef.type !== 'relation') continue;

        const expectedTargetSlug = fDef.relationConfig?.targetLibrarySlug;
        const uniqueCandidates = Array.from(new Set(candidateIds));
        const validToRestore: string[] = [];
        const missingTargetIds: string[] = [];

        for (const id of uniqueCandidates) {
          const actualSlug = restoredTargetSlugById.get(id);
          if (actualSlug) {
            if (expectedTargetSlug && actualSlug !== expectedTargetSlug) continue;
            validToRestore.push(id);
          } else if (options?.allowDeferredMissingTargets && id && !isBatchRefToken(id)) {
            missingTargetIds.push(id);
          }
        }

        if (missingTargetIds.length > 0) {
          missingTargetsByField[fk] = missingTargetIds;
        }
        if (validToRestore.length === 0) continue;

        const existingTokens = normalizeRelationValueList(curData[fk]);
        if (fDef.relationConfig?.allowMultiple === false) {
          const hasBlockingExisting = existingTokens.some((tok) => {
            if (!tok || isBatchRefToken(tok)) return false;
            if (!expectedTargetSlug) return true;
            const foundRow = this.driver.getFirstSync<{ library_id: string }>(
              'SELECT library_id FROM entries WHERE id = ?',
              [tok]
            );
            if (!foundRow) return true;
            return byId.get(foundRow.library_id)?.slug === expectedTargetSlug;
          });
          if (hasBlockingExisting) continue;
          curData[fk] = [validToRestore[0]];
          dataChanged = true;
          continue;
        }

        const prevOrder = normalizeRelationValueList(prevData[fk]);
        const ordered = mergeRestoredRelationOrder(existingTokens, validToRestore, prevOrder);
        if (
          ordered.length !== existingTokens.length ||
          ordered.some((id, idx) => id !== existingTokens[idx])
        ) {
          curData[fk] = ordered;
          dataChanged = true;
        }
      }

      if (Object.keys(missingTargetsByField).length > 0) {
        deferredMissingTargets.push({
          id: src.id,
          prevDataJson: src.prevDataJson,
          missingByField: missingTargetsByField,
        });
      }

      if (dataChanged) {
        if (nonRelationChanged) {
          this.entries.persistEntryDataAndMetadataInternal(src.id, srcLib, curData);
        } else {
          this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
            JSON.stringify(curData),
            src.id,
          ]);
        }
      }
      this.entries.syncEntryRelationsNonStrictInternal(src.id, srcLib.id, srcLib.fields, curData);
    }

    if (deferredMissingSources.length > 0) {
      this.attachDeferredSelfRestoresToSnapshotsInternal(deferredMissingSources);
    }
    if (deferredMissingTargets.length > 0) {
      this.attachDeferredDetachedSourcesToSnapshotsInternal(deferredMissingTargets);
    }
  }

  /**
   * 校验撤销 architect_plan 删除 libsToDelete 后，是否仍有存活记录本对这些库存在必填关联。
   */
  private assertNoSurvivingRequiredDepsForUndo(
    libsToDelete: ReadonlyArray<{ id: string; slug: string }>,
    previousLibraries: readonly Record<string, unknown>[]
  ): void {
    const deletingIdSet = new Set(libsToDelete.map((l) => l.id));
    const deletingSlugSet = new Set(libsToDelete.map((l) => l.slug));
    if (deletingIdSet.size === 0) return;

    const prevById = new Map<string, Record<string, unknown>>();
    for (const p of previousLibraries) {
      prevById.set(String(p.id), p);
    }

    const currentLibs = this.driver.getAllSync<{
      id: string;
      slug: string;
      name: string;
      fields_json: string;
    }>('SELECT id, slug, name, fields_json FROM libraries');

    const seenIds = new Set<string>();
    const postUndoLibs: Array<{ slug: string; name: string; fieldsJson: string }> = [];

    for (const cur of currentLibs) {
      if (deletingIdSet.has(cur.id)) continue;
      seenIds.add(cur.id);
      const prev = prevById.get(cur.id);
      postUndoLibs.push({
        slug: cur.slug,
        name: prev ? String(prev.name ?? cur.name) : cur.name,
        fieldsJson: prev ? String(prev.fields_json ?? cur.fields_json) : cur.fields_json,
      });
    }

    for (const prev of previousLibraries) {
      const prevId = String(prev.id);
      const prevSlug = String(prev.slug ?? '');
      if (seenIds.has(prevId) || deletingIdSet.has(prevId)) continue;
      postUndoLibs.push({
        slug: prevSlug,
        name: String(prev.name ?? prevSlug),
        fieldsJson: String(prev.fields_json ?? '[]'),
      });
    }

    const blockingDeps: string[] = [];
    for (const lib of postUndoLibs) {
      let fields: FieldDef[] = [];
      try {
        fields = JSON.parse(lib.fieldsJson) as FieldDef[];
      } catch {
        fields = [];
      }
      for (const f of fields) {
        if (
          f.type === 'relation' &&
          f.required &&
          f.relationConfig?.targetLibrarySlug &&
          deletingSlugSet.has(f.relationConfig.targetLibrarySlug)
        ) {
          blockingDeps.push(`「${lib.name}」的「${f.label}」`);
        }
      }
    }

    if (blockingDeps.length > 0) {
      throw new Error(
        `无法撤销此建库方案：${blockingDeps.join('、')}仍将待删除的记录本设为必填关联字段，请先修改或取消必填后再撤销`
      );
    }
  }

  /**
   * 将恢复来源条目时因目标仍处于已删除状态而被暂时剥离的关联引用，
   * 挂接到尚未撤销且包含这些目标条目的 entry_deleted / library_deleted 快照中。
   */
  private attachDeferredDetachedSourcesToSnapshotsInternal(
    deferredSources: readonly DeferredMissingSource[]
  ): void {
    if (deferredSources.length === 0) return;

    const pendingSnapRows = this.driver.getAllSync<{ id: string; snapshot_json: string }>(
      `SELECT id, snapshot_json
       FROM ai_snapshots
       WHERE undone = 0
         AND (snapshot_json LIKE '%"entry_deleted"%' OR snapshot_json LIKE '%"library_deleted"%')`
    );
    if (pendingSnapRows.length === 0) return;

    for (const snapRow of pendingSnapRows) {
      let payload: SnapshotPayload | null = null;
      try {
        payload = JSON.parse(snapRow.snapshot_json) as SnapshotPayload;
      } catch {
        payload = null;
      }
      if (!payload || (payload.kind !== 'entry_deleted' && payload.kind !== 'library_deleted')) {
        continue;
      }

      const targetEntryIdSet = new Set<string>();
      if (payload.kind === 'entry_deleted') {
        const eid = String(payload.entry?.id ?? '');
        if (eid) targetEntryIdSet.add(eid);
      } else {
        for (const e of payload.entries) {
          const eid = String(e.id ?? '');
          if (eid) targetEntryIdSet.add(eid);
        }
      }
      if (targetEntryIdSet.size === 0) continue;

      let snapChanged = false;
      const nextDetached: DetachedSourceRecord[] = payload.detachedSources
        ? payload.detachedSources.map((s) => cloneDetachedSourceRecord(s))
        : [];
      const existingById = new Map<string, DetachedSourceRecord>();
      for (const item of nextDetached) {
        existingById.set(item.id, item);
      }

      for (const src of deferredSources) {
        const matchedByField: Record<string, string[]> = {};
        for (const [fk, ids] of Object.entries(src.missingByField)) {
          const hit = ids.filter((id) => targetEntryIdSet.has(id));
          if (hit.length > 0) {
            matchedByField[fk] = hit;
          }
        }
        if (Object.keys(matchedByField).length === 0) continue;

        const incomingRecord: DetachedSourceRecord = {
          id: src.id,
          prevDataJson: src.prevDataJson,
          removedByField: matchedByField,
        };
        const existing = existingById.get(src.id);
        if (existing) {
          mergeDetachedSourceRecord(existing, incomingRecord);
        } else {
          nextDetached.push(incomingRecord);
          existingById.set(incomingRecord.id, incomingRecord);
        }
        snapChanged = true;
      }

      if (snapChanged) {
        const nextPayload: SnapshotPayload = {
          ...payload,
          detachedSources: nextDetached,
        };
        this.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
          JSON.stringify(nextPayload),
          snapRow.id,
        ]);
      }
    }
  }

  /**
   * 当目标条目先于来源条目被撤销恢复时，将来源条目待恢复的关联与 convertedFields 转发挂接到尚未撤销、
   * 且包含该来源条目的 entry_deleted / library_deleted 快照中（deferredSelfRestores）。
   */
  private attachDeferredSelfRestoresToSnapshotsInternal(
    pendingSources: readonly DetachedSourceRecord[]
  ): void {
    if (pendingSources.length === 0) return;

    const pendingSnapRows = this.driver.getAllSync<{ id: string; snapshot_json: string }>(
      `SELECT id, snapshot_json
       FROM ai_snapshots
       WHERE undone = 0
         AND (snapshot_json LIKE '%"entry_deleted"%' OR snapshot_json LIKE '%"library_deleted"%')`
    );
    if (pendingSnapRows.length === 0) return;

    for (const snapRow of pendingSnapRows) {
      let payload: SnapshotPayload | null = null;
      try {
        payload = JSON.parse(snapRow.snapshot_json) as SnapshotPayload;
      } catch {
        payload = null;
      }
      if (!payload || (payload.kind !== 'entry_deleted' && payload.kind !== 'library_deleted')) {
        continue;
      }

      const snapEntryIdSet = new Set<string>();
      if (payload.kind === 'entry_deleted') {
        const eid = String(payload.entry?.id ?? '');
        if (eid) snapEntryIdSet.add(eid);
      } else {
        for (const e of payload.entries) {
          const eid = String(e.id ?? '');
          if (eid) snapEntryIdSet.add(eid);
        }
      }
      if (snapEntryIdSet.size === 0) continue;

      let snapChanged = false;
      const nextSelfRestores: DetachedSourceRecord[] = payload.deferredSelfRestores
        ? payload.deferredSelfRestores.map((s) => cloneDetachedSourceRecord(s))
        : [];
      const existingById = new Map<string, DetachedSourceRecord>();
      for (const item of nextSelfRestores) {
        existingById.set(item.id, item);
      }

      for (const rec of pendingSources) {
        if (!snapEntryIdSet.has(rec.id)) continue;
        const existing = existingById.get(rec.id);
        if (existing) {
          mergeDetachedSourceRecord(existing, rec);
        } else {
          const added = cloneDetachedSourceRecord(rec);
          nextSelfRestores.push(added);
          existingById.set(added.id, added);
        }
        snapChanged = true;
      }

      if (snapChanged) {
        const nextPayload: SnapshotPayload = {
          ...payload,
          deferredSelfRestores: nextSelfRestores,
        };
        this.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
          JSON.stringify(nextPayload),
          snapRow.id,
        ]);
      }
    }
  }

  /**
   * 统一恢复被删条目（或整库条目）的正反向关联与延迟接力（供 entry_deleted 与 library_deleted 共用）
   */
  private finalizeRestoredEntriesRelationsInternal(
    restoredEntryIds: readonly string[],
    detachedSources: readonly DetachedSourceRecord[] | undefined,
    deferredSelfRestores: readonly DetachedSourceRecord[] | undefined
  ): void {
    // 先执行 deferredSelfRestores（恢复已先回来的目标关联、完整排序与非关联原值），再执行 sanitize，
    // 确保若本条目自身仍有尚未恢复的目标，挂接到目标快照的 prevDataJson 保留完整相对顺序。
    if (deferredSelfRestores && deferredSelfRestores.length > 0) {
      const selfTargetIds: string[] = [];
      for (const src of deferredSelfRestores) {
        for (const ids of Object.values(src.removedByField ?? {})) {
          selfTargetIds.push(...ids);
        }
      }
      this.restoreDetachedSourcesInternal(deferredSelfRestores, selfTargetIds, {
        restoreNonRelationFromPrev: true,
        allowDeferredMissingTargets: true,
        forceRestoreConvertedFields: true,
      });
    }

    const deferredSources = this.entries.sanitizeRestoredEntryRelationsInternal(restoredEntryIds);
    if (deferredSelfRestores && deferredSelfRestores.length > 0 && deferredSources.length > 0) {
      const selfById = new Map(deferredSelfRestores.map((s) => [s.id, s]));
      for (const ds of deferredSources) {
        const selfRec = selfById.get(ds.id);
        if (!selfRec) continue;
        const temp: DetachedSourceRecord = {
          id: ds.id,
          prevDataJson: ds.prevDataJson,
          removedByField: ds.missingByField,
        };
        mergeDetachedSourceRecord(temp, {
          id: selfRec.id,
          prevDataJson: selfRec.prevDataJson,
          removedByField: selfRec.removedByField,
        });
        ds.prevDataJson = temp.prevDataJson;
      }
    }
    this.attachDeferredDetachedSourcesToSnapshotsInternal(deferredSources);

    this.restoreDetachedSourcesInternal(detachedSources, restoredEntryIds);
  }

  undoSnapshotInternal(snapshotId: string): void {
    const row = this.driver.getFirstSync<{
      snapshot_json: string;
      undone: number;
    }>('SELECT snapshot_json, undone FROM ai_snapshots WHERE id = ?', [snapshotId]);
    if (!row || row.undone) {
      throw new Error('该快照不存在或已撤销');
    }

    const payload = JSON.parse(row.snapshot_json) as SnapshotPayload;

    if (payload.kind === 'entries_created') {
      this.entries.detachReferencesToEntriesInternal(payload.entryIds);
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
      const restoredEntryId = String(e.id);
      this.entries.insertRawEntry(e);
      this.libraries.invalidateCache();
      this.finalizeRestoredEntriesRelationsInternal(
        [restoredEntryId],
        payload.detachedSources,
        payload.deferredSelfRestores
      );
    } else if (payload.kind === 'library_deleted') {
      const l = payload.library;
      const conflict = this.driver.getFirstSync<{ id: string }>(
        'SELECT id FROM libraries WHERE id = ? OR slug = ?',
        [String(l.id), String(l.slug)]
      );
      if (conflict) {
        throw new Error(`已存在同标识记录本（${String(l.slug)}），无法直接撤销`);
      }
      this.libraries.insertRawLibrary(l);
      const fields = JSON.parse(String(l.fields_json)) as FieldDef[];
      compileLibrarySqlView(this.driver, String(l.id), String(l.slug), fields);
      for (const lv of payload.libraryViews) {
        this.libraries.insertRawLibraryView(lv);
      }
      const restoredEntryIds: string[] = [];
      for (const e of payload.entries) {
        this.entries.insertRawEntry(e);
        restoredEntryIds.push(String(e.id));
      }
      this.libraries.invalidateCache();
      this.finalizeRestoredEntriesRelationsInternal(
        restoredEntryIds,
        payload.detachedSources,
        payload.deferredSelfRestores
      );
      for (const w of payload.widgets) {
        this.widgets.insertRawWidget(w);
      }
      if (payload.detachedChildLibraries) {
        for (const child of payload.detachedChildLibraries) {
          this.driver.runSync(
            'UPDATE libraries SET parent_slug = ?, show_on_home = ? WHERE id = ?',
            [child.parent_slug ?? null, Number(child.show_on_home ?? 0), child.id]
          );
        }
      }
      this.libraries.syncAllLibraryRelations();
    } else if (payload.kind === 'architect_plan') {
      const libsToDelete = this.resolveCreatedLibrariesToDelete(payload.createdLibraries);
      this.assertNoSurvivingRequiredDepsForUndo(libsToDelete, payload.previousLibraries);

      for (const target of libsToDelete) {
        this.entries.detachReferencesToLibraryInternal(target.slug);
        // 同步解除后来挂载在该新建父库下的子库父子关系并恢复首页展示，避免子库成为孤儿库
        this.driver.runSync(
          'UPDATE libraries SET parent_slug = NULL, show_on_home = 1 WHERE parent_slug = ?',
          [target.slug]
        );
        dropLibrarySqlView(this.driver, target.slug);
        const allRawWidgets = this.driver.getAllSync<{
          id: string;
          library_slug: string | null;
          readonly_sql: string;
        }>('SELECT id, library_slug, readonly_sql FROM dashboard_widgets');
        for (const w of allRawWidgets) {
          if (
            w.library_slug === target.slug ||
            sqlReferencesLibraryView(w.readonly_sql, target.slug)
          ) {
            this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [w.id]);
          }
        }
        this.driver.runSync('DELETE FROM libraries WHERE id = ?', [target.id]);
      }

      const pendingDeletedLibsById = this.loadPendingLibraryDeletedSnapshotsByLibIdInternal();
      const preUndoFieldTypeByLibId = new Map<string, Map<string, FieldType>>();
      const relChangedLibIds: string[] = [];

      for (const prev of payload.previousLibraries) {
        const prevLibId = String(prev.id);
        const prevSlug = String(prev.slug ?? '');
        const curRow = this.driver.getFirstSync<{ id: string; fields_json: string }>(
          'SELECT id, fields_json FROM libraries WHERE id = ?',
          [prevLibId]
        );
        let currentRelSig: string | null = null;
        if (curRow) {
          try {
            const curFields = JSON.parse(curRow.fields_json) as FieldDef[];
            currentRelSig = getRelationFieldsSignature(curFields);
            preUndoFieldTypeByLibId.set(prevLibId, new Map(curFields.map((f) => [f.key, f.type])));
          } catch {
            currentRelSig = null;
          }
        }

        if (!curRow) {
          const pendingDelSnap = pendingDeletedLibsById.get(prevLibId);
          if (pendingDelSnap) {
            // 该库已删且存在未撤销的整库删除快照：将结构与视图还原交给该快照，绝不重建空库挡住整库恢复
            try {
              const delFields = JSON.parse(
                String(pendingDelSnap.payload.library.fields_json ?? '[]')
              ) as FieldDef[];
              preUndoFieldTypeByLibId.set(
                prevLibId,
                new Map(delFields.map((f) => [f.key, f.type]))
              );
            } catch {
              // ignore malformed fields_json
            }
            const savedPrevViews = payload.previousLibraryViews.filter(
              (v) => String(v.library_id) === prevLibId
            );
            const updatedDelPayload: Extract<SnapshotPayload, { kind: 'library_deleted' }> = {
              ...pendingDelSnap.payload,
              library: { ...prev },
              libraryViews: savedPrevViews,
            };
            this.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
              JSON.stringify(updatedDelPayload),
              pendingDelSnap.snapId,
            ]);
            continue;
          }

          const slugConflict = this.driver.getFirstSync<{ id: string }>(
            'SELECT id FROM libraries WHERE slug = ?',
            [prevSlug]
          );
          if (slugConflict) {
            throw new Error(`已存在同标识记录本（${prevSlug}），无法直接还原该记录本结构`);
          }
        }

        const prevParentSlug = prev.parent_slug ? String(prev.parent_slug) : null;
        const prevShowOnHome =
          prev.show_on_home === undefined ? (prevParentSlug ? 0 : 1) : Number(prev.show_on_home);
        if (curRow) {
          this.driver.runSync(
            `UPDATE libraries
             SET name = ?, description = ?, icon = ?, color = ?, parent_slug = ?, show_on_home = ?, fields_json = ?, views_json = ?, updated_at = ?
             WHERE id = ?`,
            [
              String(prev.name),
              String(prev.description ?? ''),
              String(prev.icon ?? '📦'),
              String(prev.color ?? 'teal'),
              prevParentSlug,
              prevShowOnHome,
              String(prev.fields_json),
              String(prev.views_json),
              Number(prev.updated_at ?? Date.now()),
              prevLibId,
            ]
          );
        } else {
          this.libraries.insertRawLibrary(prev);
        }

        const fields = JSON.parse(String(prev.fields_json)) as FieldDef[];
        const restoredRelSig = getRelationFieldsSignature(fields);
        if (curRow && currentRelSig !== restoredRelSig) {
          relChangedLibIds.push(prevLibId);
        }

        compileLibrarySqlView(this.driver, prevLibId, prevSlug, fields);
        const savedPrevViews = payload.previousLibraryViews.filter(
          (v) => String(v.library_id) === prevLibId
        );
        if (savedPrevViews.length > 0) {
          this.driver.runSync('DELETE FROM library_views WHERE library_id = ?', [prevLibId]);
          for (const lv of savedPrevViews) {
            this.libraries.insertRawLibraryView(lv);
          }
        } else {
          this.libraries.syncLibraryViewsFromBlueprint(
            prevLibId,
            JSON.parse(String(prev.views_json)) as LibraryLayoutBundle,
            !curRow
          );
        }
      }

      for (const wid of payload.createdWidgetIds) {
        this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [wid]);
      }

      this.libraries.syncAllLibraryRelations();
      this.libraries.invalidateCache();
      for (const libId of relChangedLibIds) {
        this.entries.syncLibraryEntryRelationsInternal(libId);
      }

      if (payload.trimmedSources && payload.trimmedSources.length > 0) {
        const candidateTargetIds: string[] = [];
        for (const src of payload.trimmedSources) {
          if (!src.removedByField) continue;
          for (const ids of Object.values(src.removedByField)) {
            candidateTargetIds.push(...ids);
          }
        }
        this.restoreDetachedSourcesInternal(payload.trimmedSources, candidateTargetIds, {
          restoreNonRelationFromPrev: true,
          allowDeferredMissingTargets: true,
          preUndoFieldTypeByLibId,
        });
      }
    }

    this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE id = ?', [snapshotId]);
  }
}
