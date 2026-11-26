import type { ArchitectPlan } from '@/ai/schemas';
import { createId } from '@/engine/id';
import type { FieldDef, FieldType } from '@/schema/field-defs';
import type { LibraryLayoutBundle } from '@/schema/view-dsl';
import { MAX_AI_SNAPSHOTS } from '../migrations';
import type {
  AiSnapshotItem,
  ArchitectFieldTypeChange,
  ArchitectLibraryDiff,
  SnapshotPayload,
  SnapshotUndoImpact,
} from '../models';
import { sqlReferencesLibraryView, type SyncSqlDriver } from '../types';
import { compileLibrarySqlView, dropLibrarySqlView } from '../view-compiler';
import { importBackupBundleInternal } from './backup';
import type { EntriesStore } from './entries-store';
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
    const previousLibraries: Array<Record<string, unknown>> = [];
    const previousLibraryViews: Array<Record<string, unknown>> = [];
    let snapshotId = '';

    // 先提交表结构与视图变更（批量末尾统一同步一次 library_relations），再校验并保存看板图表
    this.driver.withTransactionSync(() => {
      for (const bp of plan.libraries) {
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

      snapshotId = this.saveSnapshotInternal(plan.summary || '更新记录本与样式', {
        kind: 'architect_plan',
        createdLibrarySlugs,
        previousLibraries,
        previousLibraryViews,
        createdWidgetIds: [],
      });

      for (const bp of plan.libraries) {
        this.libraries.upsertLibraryInternal(bp, { skipRelationSync: true });
      }
      this.libraries.syncAllLibraryRelations();
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
          previousLibraries,
          previousLibraryViews,
          createdWidgetIds,
        } satisfies SnapshotPayload),
        snapshotId,
      ]);
    }

    return snapshotId;
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
        let newLibEntryCount = 0;
        for (const slug of payload.createdLibrarySlugs) {
          const lib = this.libraries.getLibraryBySlug(slug);
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
        this.entries.insertRawEntry(e);
        if (payload.detachedSources) {
          for (const src of payload.detachedSources) {
            const srcExists = this.driver.getFirstSync<{ id: string }>(
              'SELECT id FROM entries WHERE id = ?',
              [src.id]
            );
            if (srcExists) {
              this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
                src.prevDataJson,
                src.id,
              ]);
            }
          }
        }
        this.entries.insertRawRelationsSafe(payload.relations);
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
        for (const e of payload.entries) {
          this.entries.insertRawEntry(e);
        }
        if (payload.detachedSources && payload.detachedSources.length > 0) {
          const restoredFieldsBySource = new Map<string, Set<string>>();
          for (const r of payload.relations) {
            const srcId = String(r.source_entry_id ?? '');
            const fk = String(r.field_key ?? '');
            if (!srcId || !fk) continue;
            let keys = restoredFieldsBySource.get(srcId);
            if (!keys) {
              keys = new Set<string>();
              restoredFieldsBySource.set(srcId, keys);
            }
            keys.add(fk);
          }

          for (const src of payload.detachedSources) {
            const currentRow = this.driver.getFirstSync<{ id: string; data_json: string }>(
              'SELECT id, data_json FROM entries WHERE id = ?',
              [src.id]
            );
            if (!currentRow) continue;
            try {
              const prevData = JSON.parse(src.prevDataJson) as Record<string, unknown>;
              const curData = JSON.parse(currentRow.data_json) as Record<string, unknown>;
              const relKeys = restoredFieldsBySource.get(src.id);
              if (relKeys && relKeys.size > 0) {
                for (const fk of relKeys) {
                  curData[fk] = prevData[fk];
                }
                this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
                  JSON.stringify(curData),
                  src.id,
                ]);
              } else {
                this.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
                  src.prevDataJson,
                  src.id,
                ]);
              }
            } catch {
              // ignore malformed payload
            }
          }
        }
        this.entries.insertRawRelationsSafe(payload.relations);
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
        for (const slug of payload.createdLibrarySlugs) {
          this.entries.detachReferencesToLibraryInternal(slug);
          dropLibrarySqlView(this.driver, slug);
          const allRawWidgets = this.driver.getAllSync<{
            id: string;
            library_slug: string | null;
            readonly_sql: string;
          }>('SELECT id, library_slug, readonly_sql FROM dashboard_widgets');
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
          const prevParentSlug = prev.parent_slug ? String(prev.parent_slug) : null;
          const prevShowOnHome =
            prev.show_on_home === undefined ? (prevParentSlug ? 0 : 1) : Number(prev.show_on_home);
          if (exists) {
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
                String(prev.id),
              ]
            );
          } else {
            this.libraries.insertRawLibrary(prev);
          }
          const fields = JSON.parse(String(prev.fields_json)) as FieldDef[];
          compileLibrarySqlView(this.driver, String(prev.id), String(prev.slug), fields);
          const prevLibId = String(prev.id);
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
              !exists
            );
          }
        }

        for (const wid of payload.createdWidgetIds) {
          this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [wid]);
        }
        this.libraries.syncAllLibraryRelations();
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
