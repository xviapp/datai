import type { ArchitectPlan } from '@/ai/schemas';
import type { CommitDraftEntryItem } from '@/engine/capture-drafts';
import {
  getDefaultViewLabel,
  type DashboardWidget,
  type LibraryBlueprint,
  type LibraryViewType,
} from '@/schema/view-dsl';
import { runCoreMigrations } from './migrations';
import type {
  AiSnapshotItem,
  ArchitectLibraryDiff,
  BacklinkGroupSection,
  ChildLibrarySection,
  EntrySearchHit,
  FullBackupBundle,
  HydratedEntry,
  LibraryCatalogItem,
  LibraryRecord,
  LibraryRelationRecord,
  LibraryViewInput,
  LibraryViewRecord,
  SavedDashboardWidget,
  SnapshotUndoImpact,
} from './models';
import { buildDefaultSeedBundle } from './seed-templates';
import { exportBackupBundleFromDriver, importBackupBundleInternal } from './stores/backup';
import { EntriesStore, getRelationFieldsSignature } from './stores/entries-store';
import { LibrariesStore } from './stores/libraries-store';
import { SnapshotsStore } from './stores/snapshots-store';
import { WidgetsStore } from './stores/widgets-store';
import { sqlReferencesLibraryView, type SyncSqlDriver } from './types';
import { dropLibrarySqlView } from './view-compiler';

// 保持类型再导出以兼容现有引用
export type {
  AiSnapshotItem,
  ArchitectFieldTypeChange,
  ArchitectLibraryDiff,
  BacklinkGroupSection,
  ChildLibrarySection,
  EntrySearchHit,
  FullBackupBundle,
  HydratedEntry,
  LibraryCatalogItem,
  LibraryRecord,
  LibraryRelationRecord,
  LibraryViewInput,
  LibraryViewRecord,
  LinkedEntryRef,
  SavedDashboardWidget,
  SnapshotUndoImpact,
} from './models';

type ChangeListener = () => void;
export type RepositoryChangeScope = 'data' | 'widgets' | 'all';

/**
 * 本地单机数据库仓储门面（Facade）：
 * 统一协调事务边界、变更订阅通知与底层领域 Store（库/视图、条目/水合、统计图表、快照撤销与离线备份）。
 */
export class OmniRepository {
  private driver: SyncSqlDriver;
  private listeners = new Set<ChangeListener>();
  private widgetListeners = new Set<ChangeListener>();
  private librariesStore: LibrariesStore;
  private entriesStore: EntriesStore;
  private widgetsStore: WidgetsStore;
  private snapshotsStore: SnapshotsStore;

  constructor(driver: SyncSqlDriver) {
    this.driver = driver;
    this.librariesStore = new LibrariesStore(driver);
    this.entriesStore = new EntriesStore(driver, this.librariesStore);
    this.widgetsStore = new WidgetsStore(driver, this.librariesStore);
    this.snapshotsStore = new SnapshotsStore(
      driver,
      this.librariesStore,
      this.entriesStore,
      this.widgetsStore
    );

    runCoreMigrations(this.driver);
    this.driver.withTransactionSync(() => {
      this.librariesStore.ensureViewsCompiled();
    });
  }

  /**
   * 订阅核心数据变更（记录本结构、视图、条目、快照恢复等）；纯图表置顶/排序不会触发此订阅。
   */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 订阅统计图表变更（新增、总览置顶、排序、删除以及全量恢复/删库等会影响图表列表的操作）。
   */
  subscribeWidgets(listener: ChangeListener): () => void {
    this.widgetListeners.add(listener);
    return () => {
      this.widgetListeners.delete(listener);
    };
  }

  private runWriteTransaction<T>(fn: () => T): T {
    try {
      return this.driver.withTransactionSync(fn);
    } catch (err) {
      // 事务回滚时必须清空事务内可能已重建的库缓存（例如批量写入中前序草稿写入后读取了未提交的 entry_count）
      this.librariesStore.invalidateCache();
      throw err;
    }
  }

  private notify(scope: RepositoryChangeScope = 'all'): void {
    if (scope === 'data' || scope === 'all') {
      this.librariesStore.invalidateCache();
      for (const fn of this.listeners) {
        fn();
      }
    }
    if (scope === 'widgets' || scope === 'all') {
      for (const fn of this.widgetListeners) {
        fn();
      }
    }
  }

  seedIfEmpty(): void {
    const existing = this.driver.getFirstSync<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM libraries'
    );
    if (existing && existing.cnt > 0) {
      return;
    }

    const seed = buildDefaultSeedBundle();
    this.runWriteTransaction(() => {
      const refToEntryId = new Map<string, string>();

      for (let idx = 0; idx < seed.libraries.length; idx++) {
        this.librariesStore.upsertLibraryInternal(seed.libraries[idx], {
          sortOrder: idx,
          skipRelationSync: true,
        });
      }
      this.librariesStore.syncAllLibraryRelations();

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
                    ? (refToEntryId.get(token.slice(5)) ?? '')
                    : String(token)
                )
                .filter(Boolean);
            }
          }
          const createdId = this.entriesStore.createEntryInternal(
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
        this.widgetsStore.saveDashboardWidgetInternal(w, null, idx);
      });
    });

    this.notify();
  }

  // ==================== 库、视图与表间关系 ====================

  listLibraries(): LibraryRecord[] {
    return this.librariesStore.listLibraries();
  }

  getLibraryBySlug(slug: string): LibraryRecord | null {
    return this.librariesStore.getLibraryBySlug(slug);
  }

  listLibraryViews(librarySlug: string): LibraryViewRecord[] {
    return this.librariesStore.listLibraryViews(librarySlug);
  }

  listLibraryRelations(librarySlug?: string): LibraryRelationRecord[] {
    return this.librariesStore.listLibraryRelations(librarySlug);
  }

  listChildLibraries(parentSlug: string): LibraryRecord[] {
    return this.librariesStore.listChildLibraries(parentSlug);
  }

  /**
   * 原子创建或更新库结构；支持在同一事务内同步写入显式 viewInputs，并在 relation 字段发生演进时自动补建 entry_relations 索引
   */
  upsertLibrary(bp: LibraryBlueprint, viewInputs?: LibraryViewInput[]): string {
    const id = this.runWriteTransaction(() => {
      const prevLib = this.librariesStore.getLibraryBySlug(bp.slug);
      const prevRelSig = prevLib ? getRelationFieldsSignature(prevLib.fields) : null;
      const libId = this.librariesStore.upsertLibraryInternal(bp, { viewInputs });
      const nextLib = this.librariesStore.getLibraryById(libId);
      const nextRelSig = nextLib ? getRelationFieldsSignature(nextLib.fields) : null;
      if (prevLib && prevRelSig !== nextRelSig) {
        this.entriesStore.syncLibraryEntryRelationsInternal(libId);
      }
      return libId;
    });
    this.notify('data');
    return id;
  }

  saveLibraryViews(librarySlug: string, nextViews: LibraryViewInput[]): void {
    this.runWriteTransaction(() => {
      this.librariesStore.saveLibraryViewsInternal(librarySlug, nextViews);
    });
    this.notify('data');
  }

  addLibraryView(
    librarySlug: string,
    viewType: LibraryViewType,
    name?: string,
    config?: Record<string, unknown>
  ): string {
    const lib = this.getLibraryBySlug(librarySlug);
    if (!lib) throw new Error(`记录本不存在: ${librarySlug}`);
    const nextList: LibraryViewInput[] = [
      ...lib.viewList.map((v) => ({
        id: v.id,
        name: v.name,
        viewType: v.viewType,
        config: v.config,
      })),
      {
        name: name?.trim() || getDefaultViewLabel(viewType),
        viewType,
        config: config ?? this.librariesStore.buildDefaultConfigForViewType(lib, viewType),
      },
    ];
    this.saveLibraryViews(librarySlug, nextList);
    const updated = this.listLibraryViews(librarySlug);
    return updated[updated.length - 1]?.id ?? '';
  }

  deleteLibraryView(viewId: string): void {
    const row = this.driver.getFirstSync<{ library_id: string }>(
      'SELECT library_id FROM library_views WHERE id = ?',
      [viewId]
    );
    if (!row) return;
    const lib = this.librariesStore.getLibraryById(row.library_id);
    if (!lib) return;
    if (lib.viewList.length <= 1) {
      throw new Error('至少需要保留 1 个视图');
    }
    const remaining: LibraryViewInput[] = lib.viewList
      .filter((v) => v.id !== viewId)
      .map((v) => ({
        id: v.id,
        name: v.name,
        viewType: v.viewType,
        config: v.config,
      }));
    this.saveLibraryViews(lib.slug, remaining);
  }

  deleteLibrary(slug: string): void {
    const rawLib = this.driver.getFirstSync<Record<string, unknown>>(
      'SELECT * FROM libraries WHERE slug = ?',
      [slug]
    );

    if (rawLib) {
      const libName = String(rawLib.name ?? slug);
      const blockingDeps: string[] = [];
      for (const otherLib of this.librariesStore.listLibraries()) {
        if (otherLib.slug === slug) continue;
        for (const f of otherLib.fields) {
          if (
            f.type === 'relation' &&
            f.required &&
            f.relationConfig?.targetLibrarySlug === slug
          ) {
            blockingDeps.push(`「${otherLib.name}」的「${f.label}」`);
          }
        }
      }
      if (blockingDeps.length > 0) {
        throw new Error(
          `无法删除「${libName}」：${blockingDeps.join('、')}将其设为必填关联字段，请先修改或取消必填后再删除`
        );
      }
    }

    this.runWriteTransaction(() => {
      if (rawLib) {
        const libId = String(rawLib.id);
        const libName = String(rawLib.name ?? slug);
        const libViews = this.driver.getAllSync<Record<string, unknown>>(
          'SELECT * FROM library_views WHERE library_id = ? ORDER BY sort_order ASC',
          [libId]
        );
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
        const detachedChildLibraries = this.driver.getAllSync<{
          id: string;
          parent_slug: string | null;
          show_on_home: number;
        }>('SELECT id, parent_slug, show_on_home FROM libraries WHERE parent_slug = ?', [slug]);

        const allRawWidgets = this.driver.getAllSync<Record<string, unknown>>(
          'SELECT * FROM dashboard_widgets'
        );
        const matchedWidgets = allRawWidgets.filter(
          (w) =>
            w.library_slug === slug ||
            sqlReferencesLibraryView(String(w.readonly_sql ?? ''), slug)
        );

        const detachedSources = this.entriesStore.detachReferencesToLibraryInternal(slug, {
          clearDangling: true,
        });

        this.snapshotsStore.saveSnapshotInternal(`删除记录本「${libName}」`, {
          kind: 'library_deleted',
          library: rawLib,
          libraryViews: libViews,
          entries: libEntries,
          relations: libRelations,
          widgets: matchedWidgets,
          detachedChildLibraries,
          detachedSources,
        });

        for (const w of matchedWidgets) {
          this.driver.runSync('DELETE FROM dashboard_widgets WHERE id = ?', [String(w.id)]);
        }

        if (detachedChildLibraries.length > 0) {
          this.driver.runSync(
            'UPDATE libraries SET parent_slug = NULL, show_on_home = 1 WHERE parent_slug = ?',
            [slug]
          );
        }
      }

      dropLibrarySqlView(this.driver, slug);
      this.driver.runSync('DELETE FROM libraries WHERE slug = ?', [slug]);
      this.librariesStore.syncAllLibraryRelations();
    });
    this.notify();
  }

  // ==================== 条目、关联与搜索 ====================

  createEntry(librarySlug: string, inputData: Record<string, unknown>): string {
    const id = this.runWriteTransaction(() =>
      this.entriesStore.createEntryInternal(librarySlug, inputData)
    );
    this.notify('data');
    return id;
  }

  updateEntry(entryId: string, inputData: Record<string, unknown>): void {
    this.runWriteTransaction(() => {
      this.entriesStore.updateEntryInternal(entryId, inputData);
    });
    this.notify('data');
  }

  deleteEntry(entryId: string): string | null {
    let snapshotId: string | null = null;
    this.runWriteTransaction(() => {
      const deleted = this.entriesStore.deleteEntryWithDetachInternal(entryId);
      if (!deleted) return;
      const title = String(deleted.entryRow.title_summary ?? '记录');
      snapshotId = this.snapshotsStore.saveSnapshotInternal(`删除记录「${title}」`, {
        kind: 'entry_deleted',
        entry: deleted.entryRow,
        relations: deleted.relRows,
        detachedSources: deleted.detachedSources,
      });
    });
    this.notify('data');
    return snapshotId;
  }

  commitOmniDrafts(drafts: readonly CommitDraftEntryItem[], snapshotNote?: string): string[] {
    let createdIds: string[] = [];
    this.runWriteTransaction(() => {
      createdIds = this.entriesStore.commitOmniDraftsInternal(drafts);
      if (snapshotNote && createdIds.length > 0) {
        this.snapshotsStore.saveSnapshotInternal(snapshotNote, {
          kind: 'entries_created',
          entryIds: [...createdIds],
        });
      }
    });
    this.notify('data');
    return createdIds;
  }

  getEntryTitleMap(entryIds: string[]): Map<string, string> {
    return this.entriesStore.getEntryTitleMap(entryIds);
  }

  getEntrySummaryMap(entryIds: string[]): Map<string, { title: string; librarySlug: string }> {
    return this.entriesStore.getEntrySummaryMap(entryIds);
  }

  searchEntrySummaries(query: string, limit = 30): EntrySearchHit[] {
    return this.entriesStore.searchEntrySummaries(query, limit);
  }

  listRecentEntrySummaries(limit = 6): EntrySearchHit[] {
    return this.entriesStore.listRecentEntrySummaries(limit);
  }

  listLatestEntryByLibrary(): Map<string, { title: string; updatedAt: number }> {
    return this.entriesStore.listLatestEntryByLibrary();
  }

  listHydratedEntries(librarySlug: string, searchQuery?: string): HydratedEntry[] {
    return this.entriesStore.listHydratedEntries(librarySlug, searchQuery);
  }

  getHydratedEntryById(entryId: string): { entry: HydratedEntry; library: LibraryRecord } | null {
    return this.entriesStore.getHydratedEntryById(entryId);
  }

  listChildSectionsForEntry(entryId: string, parentLibrarySlug: string): ChildLibrarySection[] {
    return this.entriesStore.listChildSectionsForEntry(entryId, parentLibrarySlug);
  }

  listBacklinkGroupsForEntry(
    entryId: string,
    excludeLibrarySlugs?: Set<string>
  ): BacklinkGroupSection[] {
    return this.entriesStore.listBacklinkGroupsForEntry(entryId, excludeLibrarySlugs);
  }

  listRelationCandidates(
    targetLibrarySlug: string,
    searchQuery?: string,
    limit = 200
  ): Array<{ id: string; title: string }> {
    return this.entriesStore.listRelationCandidates(targetLibrarySlug, searchQuery, limit);
  }

  collectReferencedImagePaths(): Set<string> {
    return this.entriesStore.collectReferencedImagePaths();
  }

  // ==================== 统计看板组件与只读查询 ====================

  listDashboardWidgets(librarySlug?: string | null): DashboardWidget[] {
    return this.widgetsStore.listDashboardWidgets(librarySlug);
  }

  listAllDashboardWidgets(): SavedDashboardWidget[] {
    return this.widgetsStore.listAllDashboardWidgets();
  }

  listWidgetsForLibrary(slug: string): SavedDashboardWidget[] {
    return this.widgetsStore.listWidgetsForLibrary(slug);
  }

  saveDashboardWidget(w: DashboardWidget, librarySlug: string | null = null): void {
    this.driver.queryReadOnlySync(w.readonlySql);
    let viewsChanged = false;
    this.runWriteTransaction(() => {
      const saved = this.widgetsStore.saveDashboardWidgetInternal(w, librarySlug);
      viewsChanged = saved.viewsChanged;
    });
    this.notify(viewsChanged ? 'all' : 'widgets');
  }

  setWidgetPinnedOverview(widgetId: string, pinned: boolean): void {
    this.widgetsStore.setWidgetPinnedOverviewInternal(widgetId, pinned);
    this.notify('widgets');
  }

  moveDashboardWidget(widgetId: string, direction: 'up' | 'down', scopeIds: string[]): void {
    if (this.widgetsStore.moveDashboardWidgetInternal(widgetId, direction, scopeIds)) {
      this.notify('widgets');
    }
  }

  deleteDashboardWidget(widgetId: string): void {
    this.widgetsStore.deleteDashboardWidgetInternal(widgetId);
    this.notify('widgets');
  }

  executeReadOnlyQuery(sql: string): Array<Record<string, unknown>> {
    return this.driver.queryReadOnlySync(sql);
  }

  // ==================== Architect 演进、增量撤销与全量备份 ====================

  analyzeArchitectPlanDiff(plan: ArchitectPlan): ArchitectLibraryDiff[] {
    return this.snapshotsStore.analyzeArchitectPlanDiff(plan);
  }

  applyArchitectPlan(
    plan: ArchitectPlan,
    options?: { allowDestructiveFieldChanges?: boolean }
  ): string {
    try {
      const snapshotId = this.snapshotsStore.applyArchitectPlanInternal(plan, options);
      this.notify();
      return snapshotId;
    } catch (err) {
      this.librariesStore.invalidateCache();
      throw err;
    }
  }

  listSnapshots(): AiSnapshotItem[] {
    return this.snapshotsStore.listSnapshots();
  }

  describeSnapshotUndoImpact(snapshotId: string): SnapshotUndoImpact {
    return this.snapshotsStore.describeSnapshotUndoImpact(snapshotId);
  }

  undoSnapshot(snapshotId: string): void {
    this.runWriteTransaction(() => {
      this.snapshotsStore.undoSnapshotInternal(snapshotId);
    });
    this.notify();
  }

  exportBackupBundle(): FullBackupBundle {
    return exportBackupBundleFromDriver(this.driver);
  }

  importBackupBundle(bundle: FullBackupBundle, shouldNotify = true): void {
    this.runWriteTransaction(() => {
      importBackupBundleInternal(
        this.driver,
        this.librariesStore,
        this.entriesStore,
        this.widgetsStore,
        bundle
      );
    });

    if (shouldNotify) {
      this.notify();
    } else {
      this.librariesStore.invalidateCache();
    }
  }

  /**
   * 导出结构化库目录（纯数据，不含 Prompt 拼接，供 AI 层按需组装上下文）
   */
  getLibraryCatalogItems(includeEntryCandidates = false): LibraryCatalogItem[] {
    const libs = this.listLibraries();
    return libs.map((l) => {
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
        parentLibrarySlug: l.parentLibrarySlug,
        fields: l.fields,
        recentEntries,
      };
    });
  }
}
