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
import { importBackupBundleInternal } from './backup';
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
      throw new Error(`方案包含破坏性字段变更，可能导致旧数据无法显示或保存：${details}`);
    }

    const createdLibrarySlugs: string[] = [];
    const createdLibraries: Array<{ id: string; slug: string }> = [];
    const previousLibraries: Array<Record<string, unknown>> = [];
    const previousLibraryViews: Array<Record<string, unknown>> = [];
    const trimmedSources: DetachedSourceRecord[] = [];
    let snapshotId = '';

    // 先提交表结构与视图变更（批量末尾统一同步一次 library_relations），再校验并保存看板图表
    this.driver.withTransactionSync(() => {
      const seenSlugs = new Set<string>();
      for (const bp of plan.libraries) {
        if (seenSlugs.has(bp.slug)) continue;
        seenSlugs.add(bp.slug);
        const existingRaw = this.driver.getFirstSync<Record<string, unknown>>(
          'SELECT * FROM libraries WHERE slug = ?',
          [bp.slug]
        );
        if (existingRaw) {
          previousLibraries.push(existingRaw);
          const prevViews = this.driver.getAllSync<Record<string, unknown>>(
            'SELECT * FROM library_views WHERE library_id = ? ORDER BY sort_order ASC',
            [String(existingRaw.id)]
          );
          previousLibraryViews.push(...prevViews);
        } else {
          createdLibrarySlugs.push(bp.slug);
        }
      }

      const createdSlugSet = new Set(createdLibrarySlugs);
      const recordedCreatedIds = new Set<string>();
      const updatedRelLibIds: string[] = [];

      for (const bp of plan.libraries) {
        const prevLib = this.libraries.getLibraryBySlug(bp.slug);
        const prevRelSig = prevLib ? getRelationFieldsSignature(prevLib.fields) : null;
        const libId = this.libraries.upsertLibraryInternal(bp, { skipRelationSync: true });
        if (createdSlugSet.has(bp.slug)) {
          if (!recordedCreatedIds.has(libId)) {
            recordedCreatedIds.add(libId);
            createdLibraries.push({ id: libId, slug: bp.slug });
          }
        } else if (prevLib) {
          const nextLib = this.libraries.getLibraryById(libId);
          const nextRelSig = nextLib ? getRelationFieldsSignature(nextLib.fields) : null;
          if (prevRelSig !== nextRelSig && !updatedRelLibIds.includes(libId)) {
            updatedRelLibIds.push(libId);
          }
        }
      }

      this.libraries.syncAllLibraryRelations();
      for (const libId of updatedRelLibIds) {
        trimmedSources.push(...this.entries.syncLibraryEntryRelationsInternal(libId));
      }

      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', {
        kind: 'architect_plan',
        createdLibrarySlugs,
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
          createdLibrarySlugs,
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
   * 核对 architect_plan 快照中待删除的新建库身份：
   * 严格只按快照显式记录的精确 library.id 匹配；
   * 升级前的旧快照若缺少 createdLibraries，绝不凭 slug 或时间窗猜测认领可删除的库，避免误删导入或重建的同名库。
   */
  private resolveArchitectCreatedLibrariesToDelete(
    payload: Extract<SnapshotPayload, { kind: 'architect_plan' }>
  ): Array<{ id: string; slug: string }> {
    const matched: Array<{ id: string; slug: string }> = [];
    const seenIds = new Set<string>();

    if (!Array.isArray(payload.createdLibraries)) {
      return matched;
    }

    for (const item of payload.createdLibraries) {
      if (!item?.id || seenIds.has(String(item.id))) continue;
      const row = this.driver.getFirstSync<{ id: string; slug: string }>(
        'SELECT id, slug FROM libraries WHERE id = ?',
        [String(item.id)]
      );
      if (row) {
        seenIds.add(row.id);
        matched.push(row);
      }
    }
    return matched;
  }

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
        const targetLibs = this.resolveArchitectCreatedLibrariesToDelete(payload);
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
          isFullRestore: false,
          affectedEntriesCount: newLibEntryCount,
          warningText,
        };
      }
    }

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

  /**
   * 恢复删除记录、删库或建库方案裁剪解绑的字段值与关联：
   * - 校验当前来源库字段类型、目标库及单选约束（不破坏用户后续编辑）；
   * - 当 restoreNonRelationFromPrev=true（建库方案撤销）且字段已恢复为非 relation 类型（如 text -> relation -> text）且当前值为空时，按 prevDataJson 还原原文并重算标题/搜索文本；
   * - 支持分次撤销对称接力：若来源记录当前已删，则转发至包含该来源的未撤销快照 deferredSelfRestores；
   *   若来源存活而目标记录当前已删且 allowDeferredMissingTargets=true，则转发至包含目标的未撤销快照 detachedSources。
   */
  private restoreDetachedSourcesInternal(
    detachedSources: readonly DetachedSourceRecord[] | undefined,
    restoredTargetEntryIds: readonly string[],
    options?: {
      restoreNonRelationFromPrev?: boolean;
      allowDeferredMissingTargets?: boolean;
    }
  ): Set<string> {
    const handledSourceIds = new Set<string>();
    if (!detachedSources || detachedSources.length === 0) return handledSourceIds;

    // 刷新库缓存以获取刚恢复的目标库与各来源库最新字段定义
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
      handledSourceIds.add(src.id);

      let prevData: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(src.prevDataJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          prevData = parsed as Record<string, unknown>;
        }
      } catch {
        prevData = null;
      }

      const currentRow = this.driver.getFirstSync<{
        id: string;
        library_id: string;
        data_json: string;
      }>('SELECT id, library_id, data_json FROM entries WHERE id = ?', [src.id]);
      if (!currentRow) {
        // 来源条目当前处于已删状态：将其待恢复关联转发至包含该来源的未撤销快照，避免先恢复目标后恢复来源时关联丢失
        const pendingByField: Record<string, string[]> = {};
        if (src.removedByField && Object.keys(src.removedByField).length > 0) {
          for (const [fk, ids] of Object.entries(src.removedByField)) {
            if (!Array.isArray(ids) || ids.length === 0) continue;
            const relevant = options?.allowDeferredMissingTargets
              ? ids.filter((id) => Boolean(id) && !isBatchRefToken(id))
              : ids.filter((id) => restoredTargetIdSet.has(id));
            if (relevant.length > 0) {
              pendingByField[fk] = relevant;
            }
          }
        } else if (prevData && restoredTargetIdSet.size > 0) {
          for (const [fk, rawVal] of Object.entries(prevData)) {
            const matched = normalizeRelationValueList(rawVal).filter((id) =>
              restoredTargetIdSet.has(id)
            );
            if (matched.length > 0) {
              pendingByField[fk] = matched;
            }
          }
        }
        if (Object.keys(pendingByField).length > 0) {
          deferredMissingSources.push({
            id: src.id,
            prevDataJson: src.prevDataJson,
            removedByField: pendingByField,
          });
        }
        continue;
      }

      const srcLib = byId.get(currentRow.library_id);
      if (!srcLib) continue;
      const fieldByKey = new Map(srcLib.fields.map((f) => [f.key, f]));

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

      // 收集待恢复的字段 -> 目标 ID 映射（新快照用 removedByField，旧快照按本次恢复的目标 ID 从 prevDataJson 精准提取）
      const candidatesByField: Record<string, string[]> = {};
      if (src.removedByField && Object.keys(src.removedByField).length > 0) {
        for (const [fk, ids] of Object.entries(src.removedByField)) {
          if (Array.isArray(ids) && ids.length > 0) {
            candidatesByField[fk] = ids;
          }
        }
      } else if (prevData && restoredTargetIdSet.size > 0) {
        for (const [fk, rawVal] of Object.entries(prevData)) {
          const fDef = fieldByKey.get(fk);
          if (!fDef || fDef.type !== 'relation') continue;
          const prevTokens = normalizeRelationValueList(rawVal);
          const matched = prevTokens.filter((id) => restoredTargetIdSet.has(id));
          if (matched.length > 0) {
            candidatesByField[fk] = matched;
          }
        }
      }

      let dataChanged = false;
      let nonRelationChanged = false;
      const missingTargetsByField: Record<string, string[]> = {};

      for (const [fk, candidateIds] of Object.entries(candidatesByField)) {
        const fDef = fieldByKey.get(fk);
        if (!fDef) continue;

        if (fDef.type !== 'relation') {
          // 建库方案撤销（例如 text -> relation -> text）：仅当当前字段仍为空时按 prevDataJson 还原原值
          if (
            options?.restoreNonRelationFromPrev &&
            prevData &&
            Object.prototype.hasOwnProperty.call(prevData, fk) &&
            isEmptyRestorableValue(curData[fk])
          ) {
            curData[fk] = prevData[fk];
            dataChanged = true;
            nonRelationChanged = true;
          }
          continue;
        }

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
          // 单选字段若用户删除后已改选了其他有效目标，保留用户的最新选择，不破坏单选约束
          if (existingTokens.length > 0) continue;
          curData[fk] = [validToRestore[0]];
          dataChanged = true;
          continue;
        }

        // 多选字段严格保留用户后来编辑的现有顺序，并按 prevOrder 将待恢复 ID 插回对应锚点位置
        const prevOrder = prevData ? normalizeRelationValueList(prevData[fk]) : [];
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
      // 无论 data_json 是否修改，统一以当前有序 curData 同步该来源记录的 entry_relations，杜绝顺序错位、漏边或幽灵边
      this.entries.syncEntryRelationsNonStrictInternal(src.id, srcLib.id, srcLib.fields, curData);
    }

    if (deferredMissingSources.length > 0) {
      this.attachDeferredSelfRestoresToSnapshotsInternal(deferredMissingSources);
    }
    if (deferredMissingTargets.length > 0) {
      this.attachDeferredDetachedSourcesToSnapshotsInternal(deferredMissingTargets);
    }

    return handledSourceIds;
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
   * 挂接到尚未撤销且包含这些目标条目的 entry_deleted / library_deleted 快照中，
   * 使当前活记录立即可编辑，待后续恢复目标记录或目标记录本时自动无损还原关联。
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
      if (
        !payload ||
        !('kind' in payload) ||
        (payload.kind !== 'entry_deleted' && payload.kind !== 'library_deleted')
      ) {
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
        ? payload.detachedSources.map((s) => ({
            ...s,
            removedByField: s.removedByField ? { ...s.removedByField } : undefined,
          }))
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

        const existing = existingById.get(src.id);
        if (existing) {
          const mergedRemoved: Record<string, string[]> = { ...(existing.removedByField ?? {}) };
          for (const [fk, ids] of Object.entries(matchedByField)) {
            const cur = mergedRemoved[fk] ?? [];
            mergedRemoved[fk] = Array.from(new Set([...cur, ...ids]));
          }
          existing.removedByField = mergedRemoved;
        } else {
          const added: DetachedSourceRecord = {
            id: src.id,
            prevDataJson: src.prevDataJson,
            removedByField: matchedByField,
          };
          nextDetached.push(added);
          existingById.set(added.id, added);
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
   * 当目标条目先于来源条目被撤销恢复时，将来源条目待恢复的关联记录转发挂接到尚未撤销、
   * 且包含该来源条目的 entry_deleted / library_deleted 快照中（deferredSelfRestores），
   * 待来源条目后续恢复时自动补回正向与反向关联。
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
      if (
        !payload ||
        !('kind' in payload) ||
        (payload.kind !== 'entry_deleted' && payload.kind !== 'library_deleted')
      ) {
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
        ? payload.deferredSelfRestores.map((s) => ({
            ...s,
            removedByField: s.removedByField ? { ...s.removedByField } : undefined,
          }))
        : [];
      const existingById = new Map<string, DetachedSourceRecord>();
      for (const item of nextSelfRestores) {
        existingById.set(item.id, item);
      }

      for (const rec of pendingSources) {
        if (!snapEntryIdSet.has(rec.id)) continue;
        const existing = existingById.get(rec.id);
        if (existing) {
          const mergedRemoved: Record<string, string[]> = { ...(existing.removedByField ?? {}) };
          for (const [fk, ids] of Object.entries(rec.removedByField ?? {})) {
            const cur = mergedRemoved[fk] ?? [];
            mergedRemoved[fk] = Array.from(new Set([...cur, ...ids]));
          }
          existing.removedByField = mergedRemoved;
        } else {
          const added: DetachedSourceRecord = {
            id: rec.id,
            prevDataJson: rec.prevDataJson,
            removedByField: rec.removedByField ? { ...rec.removedByField } : undefined,
          };
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

  undoSnapshotInternal(snapshotId: string): void {
    const row = this.driver.getFirstSync<{
      snapshot_json: string;
      undone: number;
      created_at: number;
    }>('SELECT snapshot_json, undone, created_at FROM ai_snapshots WHERE id = ?', [snapshotId]);
    if (!row || row.undone) {
      throw new Error('该快照不存在或已撤销');
    }

    const payload = JSON.parse(row.snapshot_json) as SnapshotPayload;

    if ('kind' in payload) {
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
        // 兼容旧版删记录快照（有效关联仅保存在 payload.relations 中而 data_json 为空）
        const outgoingRels = payload.relations.filter(
          (r) => String(r.source_entry_id) === restoredEntryId
        );
        if (outgoingRels.length > 0) {
          this.entries.reconcileRelationRowsIntoEntriesInternal(outgoingRels);
        }
        const deferredSources = this.entries.sanitizeRestoredEntryRelationsInternal([
          restoredEntryId,
        ]);
        if (outgoingRels.length > 0) {
          deferredSources.push(
            ...this.entries.collectDeferredMissingFromRelationRowsInternal(outgoingRels)
          );
        }
        this.attachDeferredDetachedSourcesToSnapshotsInternal(deferredSources);
        if (payload.deferredSelfRestores && payload.deferredSelfRestores.length > 0) {
          const selfTargetIds: string[] = [];
          for (const src of payload.deferredSelfRestores) {
            for (const ids of Object.values(src.removedByField ?? {})) {
              selfTargetIds.push(...ids);
            }
          }
          this.restoreDetachedSourcesInternal(payload.deferredSelfRestores, selfTargetIds, {
            allowDeferredMissingTargets: true,
          });
        }
        const handledEntrySources = this.restoreDetachedSourcesInternal(
          payload.detachedSources,
          [restoredEntryId]
        );
        const incomingRels = payload.relations.filter(
          (r) =>
            String(r.target_entry_id) === restoredEntryId &&
            String(r.source_entry_id) !== restoredEntryId &&
            !handledEntrySources.has(String(r.source_entry_id))
        );
        if (incomingRels.length > 0) {
          const reconciledIds = this.entries.reconcileRelationRowsIntoEntriesInternal(
            incomingRels,
            { syncRelations: true }
          );
          for (const sid of reconciledIds) handledEntrySources.add(sid);
        }
        this.entries.reindexSurvivingReferencesToEntriesInternal(
          [restoredEntryId],
          handledEntrySources
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
        if (payload.libraryViews && payload.libraryViews.length > 0) {
          for (const lv of payload.libraryViews) {
            this.libraries.insertRawLibraryView(lv);
          }
        } else {
          this.libraries.syncLibraryViewsFromBlueprint(
            String(l.id),
            JSON.parse(String(l.views_json)) as LibraryLayoutBundle,
            true
          );
        }
        const restoredEntryIds: string[] = [];
        for (const e of payload.entries) {
          this.entries.insertRawEntry(e);
          restoredEntryIds.push(String(e.id));
        }
        const restoredEntryIdSet = new Set(restoredEntryIds);
        this.libraries.invalidateCache();
        const outgoingLibRels = payload.relations.filter((r) =>
          restoredEntryIdSet.has(String(r.source_entry_id))
        );
        if (outgoingLibRels.length > 0) {
          this.entries.reconcileRelationRowsIntoEntriesInternal(outgoingLibRels);
        }
        const deferredLibSources =
          this.entries.sanitizeRestoredEntryRelationsInternal(restoredEntryIds);
        if (outgoingLibRels.length > 0) {
          deferredLibSources.push(
            ...this.entries.collectDeferredMissingFromRelationRowsInternal(outgoingLibRels)
          );
        }
        this.attachDeferredDetachedSourcesToSnapshotsInternal(deferredLibSources);
        if (payload.deferredSelfRestores && payload.deferredSelfRestores.length > 0) {
          const selfTargetIds: string[] = [];
          for (const src of payload.deferredSelfRestores) {
            for (const ids of Object.values(src.removedByField ?? {})) {
              selfTargetIds.push(...ids);
            }
          }
          this.restoreDetachedSourcesInternal(payload.deferredSelfRestores, selfTargetIds, {
            allowDeferredMissingTargets: true,
          });
        }
        const handledLibSources = this.restoreDetachedSourcesInternal(
          payload.detachedSources,
          restoredEntryIds
        );
        const incomingLibRels = payload.relations.filter(
          (r) =>
            restoredEntryIdSet.has(String(r.target_entry_id)) &&
            !restoredEntryIdSet.has(String(r.source_entry_id)) &&
            !handledLibSources.has(String(r.source_entry_id))
        );
        if (incomingLibRels.length > 0) {
          const reconciledIds = this.entries.reconcileRelationRowsIntoEntriesInternal(
            incomingLibRels,
            { syncRelations: true }
          );
          for (const sid of reconciledIds) handledLibSources.add(sid);
        }
        this.entries.reindexSurvivingReferencesToEntriesInternal(
          restoredEntryIds,
          handledLibSources
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
        const libsToDelete = this.resolveArchitectCreatedLibrariesToDelete(payload);
        this.assertNoSurvivingRequiredDepsForUndo(libsToDelete, payload.previousLibraries);
        for (const target of libsToDelete) {
          this.entries.detachReferencesToLibraryInternal(target.slug, { clearDangling: false });
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

        const relChangedLibIds: string[] = [];
        for (const prev of payload.previousLibraries) {
          const prevLibId = String(prev.id);
          const curRow = this.driver.getFirstSync<{ id: string; fields_json: string }>(
            'SELECT id, fields_json FROM libraries WHERE id = ?',
            [prevLibId]
          );
          let currentRelSig: string | null = null;
          if (curRow) {
            try {
              currentRelSig = getRelationFieldsSignature(
                JSON.parse(curRow.fields_json) as FieldDef[]
              );
            } catch {
              currentRelSig = null;
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

          compileLibrarySqlView(this.driver, prevLibId, String(prev.slug), fields);
          const savedPrevViews = (payload.previousLibraryViews ?? []).filter(
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
          });
        }
      }
    } else {
      importBackupBundleInternal(
        this.driver,
        this.libraries,
        this.entries,
        this.widgets,
        payload,
        { clearSnapshots: false }
      );
      // 历史全量快照恢复到过去状态后，将晚于该快照的增量记录一并标为已撤销，避免跨时间线误操作
      this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE created_at >= ?', [
        row.created_at,
      ]);
    }

    this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE id = ?', [snapshotId]);
  }
}
