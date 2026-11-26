import type { ArchitectPlan } from '@/ai/schemas';
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
import { getRelationFieldsSignature, type EntriesStore } from './entries-store';
import type { LibrariesStore } from './libraries-store';
import type { WidgetsStore } from './widgets-store';

function isCompatibleFieldTypeChange(fromType: FieldType, toType: FieldType): boolean {
  if (fromType === toType) return true;
  const numericTypes = new Set<FieldType>(['number', 'currency', 'rating']);
  if (numericTypes.has(fromType) && numericTypes.has(toType)) return true;
  const stringTypes = new Set<FieldType>(['text', 'select', 'date']);
  if (stringTypes.has(fromType) && stringTypes.has(toType)) return true;
  return false;
}

/**
 * 合并撤销恢复的多选关联 ID：严格保持用户现有选择（existingTokens）的相对顺序不变，
 * 并依据删除前顺序（prevOrder）将待恢复 ID 插回其前驱/后继锚点之间。
 */
function mergeRestoredRelationOrder(
  existingTokens: readonly string[],
  validToRestore: readonly string[],
  prevOrder: readonly string[]
): string[] {
  const result = Array.from(new Set(existingTokens));
  const prevIndexById = new Map<string, number>();
  prevOrder.forEach((id, idx) => {
    if (!prevIndexById.has(id)) {
      prevIndexById.set(id, idx);
    }
  });

  const toInsert = Array.from(new Set(validToRestore))
    .filter((id) => !result.includes(id))
    .sort((a, b) => {
      const ia = prevIndexById.get(a);
      const ib = prevIndexById.get(b);
      if (ia === undefined && ib === undefined) return 0;
      if (ia === undefined) return 1;
      if (ib === undefined) return -1;
      return ia - ib;
    });

  for (const id of toInsert) {
    const prevIdx = prevIndexById.get(id);
    if (prevIdx === undefined) {
      result.push(id);
      continue;
    }

    const predPositions: number[] = [];
    for (let j = 0; j < prevIdx; j++) {
      const pos = result.indexOf(prevOrder[j]);
      if (pos !== -1) predPositions.push(pos);
    }

    const succPositions: number[] = [];
    for (let j = prevIdx + 1; j < prevOrder.length; j++) {
      const pos = result.indexOf(prevOrder[j]);
      if (pos !== -1) succPositions.push(pos);
    }

    let insertAt = result.length;
    if (predPositions.length > 0 && succPositions.length === 0) {
      insertAt = Math.max(...predPositions) + 1;
    } else if (predPositions.length === 0 && succPositions.length > 0) {
      insertAt = Math.min(...succPositions);
    } else if (predPositions.length > 0 && succPositions.length > 0) {
      const maxPred = Math.max(...predPositions);
      const minSucc = Math.min(...succPositions);
      if (maxPred < minSucc) {
        insertAt = maxPred + 1;
      } else {
        for (let j = prevIdx - 1; j >= 0; j--) {
          const pos = result.indexOf(prevOrder[j]);
          if (pos !== -1) {
            insertAt = pos + 1;
            break;
          }
        }
      }
    }

    result.splice(insertAt, 0, id);
  }

  return result;
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

      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', {
        kind: 'architect_plan',
        createdLibrarySlugs,
        createdLibraries,
        previousLibraries,
        previousLibraryViews,
        createdWidgetIds: [],
      });

      this.libraries.syncAllLibraryRelations();
      for (const libId of updatedRelLibIds) {
        this.entries.syncLibraryEntryRelationsInternal(libId);
      }
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
        } satisfies SnapshotPayload),
        snapshotId,
      ]);
    }

    return snapshotId;
  }

  /**
   * 核对 architect_plan 快照中待删除的新建库身份：
   * - 新快照严格按创建时的 library.id 匹配，避免误删后来复用同 slug 新建的记录本；
   * - 兼容未保存 createdLibraries 的历史快照，按 slug 回退匹配。
   */
  private resolveArchitectCreatedLibrariesToDelete(
    payload: Extract<SnapshotPayload, { kind: 'architect_plan' }>
  ): Array<{ id: string; slug: string }> {
    const matched: Array<{ id: string; slug: string }> = [];
    const seenIds = new Set<string>();

    if (Array.isArray(payload.createdLibraries)) {
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

    for (const slug of payload.createdLibrarySlugs) {
      const row = this.driver.getFirstSync<{ id: string; slug: string }>(
        'SELECT id, slug FROM libraries WHERE slug = ?',
        [slug]
      );
      if (row && !seenIds.has(row.id)) {
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
   * 恢复删除记录或删库时解绑的反向关联：
   * - 校验当前来源库字段是否仍为 relation、目标库是否匹配以及单选是否已有后续新选择（不破坏用户后续编辑）；
   * - 兼容旧版快照（未记录 removedByField），按本次恢复的目标条目 ID 从 prevDataJson 精准提取，绝不整条覆写 prevDataJson；
   * - 按 prevDataJson 保留原有相对顺序，并用同一份有序 ID 列表同步重建 entry_relations，保证 data_json 与关联表严格一致。
   */
  private restoreDetachedSourcesInternal(
    detachedSources: readonly DetachedSourceRecord[] | undefined,
    restoredTargetEntryIds: readonly string[]
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

    for (const src of detachedSources) {
      handledSourceIds.add(src.id);
      const currentRow = this.driver.getFirstSync<{
        id: string;
        library_id: string;
        data_json: string;
      }>('SELECT id, library_id, data_json FROM entries WHERE id = ?', [src.id]);
      if (!currentRow) continue;

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

      let prevData: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(src.prevDataJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          prevData = parsed as Record<string, unknown>;
        }
      } catch {
        prevData = null;
      }

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
      for (const [fk, candidateIds] of Object.entries(candidatesByField)) {
        const fDef = fieldByKey.get(fk);
        // 字段已被删除或类型不再是 relation，绝不覆盖用户改后的值
        if (!fDef || fDef.type !== 'relation') continue;

        const expectedTargetSlug = fDef.relationConfig?.targetLibrarySlug;
        const validToRestore = Array.from(new Set(candidateIds)).filter((id) => {
          const actualSlug = restoredTargetSlugById.get(id);
          if (!actualSlug) return false;
          if (expectedTargetSlug && actualSlug !== expectedTargetSlug) return false;
          return true;
        });
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

      if (dataChanged) {
        this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
          JSON.stringify(curData),
          src.id,
        ]);
      }
      // 无论 data_json 是否修改，统一以当前有序 curData 同步该来源记录的 entry_relations，杜绝顺序错位、漏边或幽灵边
      this.entries.syncEntryRelationsNonStrictInternal(src.id, srcLib.id, srcLib.fields, curData);
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

  undoSnapshotInternal(snapshotId: string): void {
    const row = this.driver.getFirstSync<{ snapshot_json: string; undone: number }>(
      'SELECT snapshot_json, undone FROM ai_snapshots WHERE id = ?',
      [snapshotId]
    );
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
        this.entries.sanitizeRestoredEntryRelationsInternal([restoredEntryId]);
        const handledEntrySources = this.restoreDetachedSourcesInternal(
          payload.detachedSources,
          [restoredEntryId]
        );
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
        this.entries.sanitizeRestoredEntryRelationsInternal(restoredEntryIds);
        const handledLibSources = this.restoreDetachedSourcesInternal(
          payload.detachedSources,
          restoredEntryIds
        );
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
      }
    } else {
      importBackupBundleInternal(
        this.driver,
        this.libraries,
        this.entries,
        this.widgets,
        payload
      );
    }

    this.driver.runSync('UPDATE ai_snapshots SET undone = 1 WHERE id = ?', [snapshotId]);
  }
}
