import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import {
  buildInitialSchemaDraft,
  buildSchemaSavePayload,
} from '../src/components/schema-editor/config';
import { OmniRepository } from '../src/db/repository';
import { sanitizeReadOnlySql, type SqlParam, type SyncSqlDriver } from '../src/db/types';
import {
  findDanglingDraftRelations,
  makeDraftRefToken,
  normalizeCaptureDrafts,
  removeCaptureDraftById,
  updateDraftRelationTokens,
} from '../src/engine/capture-drafts';
import {
  filterAndSortLibraryEntries,
  getLibrarySortOptions,
} from '../src/engine/library-view-rules';

function createInstrumentedSqliteDriver(): {
  driver: SyncSqlDriver;
  queries: string[];
  clearQueries: () => void;
} {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  let inTx = false;
  const queries: string[] = [];

  const driver: SyncSqlDriver = {
    execSync(sql: string) {
      queries.push(sql);
      db.exec(sql);
    },
    runSync(sql: string, params: SqlParam[] = []) {
      queries.push(sql);
      db.prepare(sql).run(...params);
    },
    getAllSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
      queries.push(sql);
      return db.prepare(sql).all(...params) as unknown as T[];
    },
    getFirstSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | null {
      queries.push(sql);
      const row = db.prepare(sql).get(...params) as unknown as T | undefined;
      return row ?? null;
    },
    withTransactionSync<T>(fn: () => T): T {
      const outer = inTx;
      if (!outer) {
        db.exec('BEGIN TRANSACTION;');
        inTx = true;
      }
      try {
        const res = fn();
        if (!outer) {
          db.exec('COMMIT;');
          inTx = false;
        }
        return res;
      } catch (err) {
        if (!outer) {
          db.exec('ROLLBACK;');
          inTx = false;
        }
        throw err;
      }
    },
    queryReadOnlySync<T = Record<string, unknown>>(sql: string): T[] {
      const safe = sanitizeReadOnlySql(sql);
      queries.push(safe);
      db.exec('PRAGMA query_only = ON;');
      try {
        return db.prepare(safe).all() as unknown as T[];
      } finally {
        db.exec('PRAGMA query_only = OFF;');
      }
    },
  };

  return {
    driver,
    queries,
    clearQueries: () => {
      queries.length = 0;
    },
  };
}

function createSeededRepo() {
  const ctx = createInstrumentedSqliteDriver();
  const repo = new OmniRepository(ctx.driver);
  repo.seedIfEmpty();
  return { repo, ...ctx };
}

describe('1. Quick-capture draft stable IDs, shared validation & strict relation writes', () => {
  it('prevents misbinding to Book B after deleting Book A draft and flags dangling relation', () => {
    const { repo } = createSeededRepo();
    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));
    const booksCountBefore = repo.listHydratedEntries('books').length;
    const logsCountBefore = repo.listHydratedEntries('reading_logs').length;

    const managed = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'books',
          reason: '新建书 A',
          data: { book_title: '测试书 A', author: '作者 A', status: '在读', total_pages: 300 },
        },
        {
          librarySlug: 'books',
          reason: '新建书 B',
          data: { book_title: '测试书 B', author: '作者 B', status: '想读', total_pages: 260 },
        },
        {
          librarySlug: 'reading_logs',
          reason: '记录书 A 的阅读进度',
          data: {
            book: ['@prev:0'],
            read_date: '2026-11-25',
            end_page: 42,
            duration_min: 35,
            note: '序章读完',
          },
        },
      ],
      libMap
    );

    const [bookA, bookB, readingLog] = managed;
    assert.deepEqual(readingLog.data.book, [makeDraftRefToken(bookA.draftId)]);
    assert.equal(findDanglingDraftRelations(managed, libMap).length, 0);

    // 删除书 A 草稿：书 B 顶替下标 0，但阅读记录绝不能错绑到书 B
    const { nextDrafts, removedLabel } = removeCaptureDraftById(managed, bookA.draftId, libMap);
    assert.equal(removedLabel, '测试书 A');
    assert.equal(nextDrafts.length, 2);

    const issues = findDanglingDraftRelations(nextDrafts, libMap);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].draftId, readingLog.draftId);
    assert.equal(issues[0].fieldKey, 'book');
    assert.deepEqual(issues[0].missingDraftIds, [bookA.draftId]);
    assert.deepEqual(issues[0].reasons, ['missing_draft']);

    // 直接落盘应抛出明确异常且原子回滚，不写入书 B 也不错绑阅读记录
    assert.throws(
      () => repo.commitOmniDrafts(nextDrafts, '尝试提交失效关联'),
      /已被删除|重新选择/
    );
    assert.equal(repo.listHydratedEntries('books').length, booksCountBefore);
    assert.equal(repo.listHydratedEntries('reading_logs').length, logsCountBefore);

    // 用户显式改选为书 B 后可正常提交并精准绑定到书 B
    const fixedDrafts = updateDraftRelationTokens(nextDrafts, readingLog.draftId, 'book', [
      makeDraftRefToken(bookB.draftId),
    ]);
    assert.equal(findDanglingDraftRelations(fixedDrafts, libMap).length, 0);

    const createdIds = repo.commitOmniDrafts(fixedDrafts, '改选书 B 后保存');
    assert.equal(createdIds.length, 2);
    const savedLog = repo.getHydratedEntryById(createdIds[1]);
    assert.equal(savedLog?.entry.forwardLinks.book?.[0]?.id, createdIds[0]);
    assert.equal(savedLog?.entry.forwardLinks.book?.[0]?.title, '测试书 B');
  });

  it('rejects cross-library batch references and malformed @prev:x tokens in both preview and commit', () => {
    const { repo } = createSeededRepo();
    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));
    const billsCountBefore = repo.listHydratedEntries('daily_bills').length;
    const logsCountBefore = repo.listHydratedEntries('reading_logs').length;

    // 1. 阅读记录引用同批账单草稿：预览必须检出 library_mismatch，提交必须回滚
    const crossBatch = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'daily_bills',
          reason: '买书账单',
          data: {
            title: '购书支出',
            amount: 45,
            category: '文化娱乐',
            pay_account: '微信',
            spent_at: '2026-11-25',
          },
        },
        {
          librarySlug: 'reading_logs',
          reason: '误引用账单草稿',
          data: {
            book: ['@prev:0'],
            read_date: '2026-11-25',
            end_page: 20,
            duration_min: 15,
          },
        },
      ],
      libMap
    );
    const crossIssues = findDanglingDraftRelations(crossBatch, libMap);
    assert.equal(crossIssues.length, 1);
    assert.deepEqual(crossIssues[0].reasons, ['library_mismatch']);
    assert.throws(() => repo.commitOmniDrafts(crossBatch), /不匹配的记录本草稿/);
    assert.equal(repo.listHydratedEntries('daily_bills').length, billsCountBefore);
    assert.equal(repo.listHydratedEntries('reading_logs').length, logsCountBefore);

    // 2. 非法格式 @prev:x 与 @draft:：预览必须检出 malformed，提交必须回滚且不落盘脏值
    const malformedBatch = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'reading_logs',
          reason: '非法引用测试',
          data: {
            book: ['@prev:x'],
            read_date: '2026-11-25',
            end_page: 10,
            duration_min: 10,
          },
        },
      ],
      libMap
    );
    const malformedIssues = findDanglingDraftRelations(malformedBatch, libMap);
    assert.equal(malformedIssues.length, 1);
    assert.deepEqual(malformedIssues[0].reasons, ['malformed']);
    assert.throws(() => repo.commitOmniDrafts(malformedBatch), /无效的草稿引用/);
    assert.equal(repo.listHydratedEntries('reading_logs').length, logsCountBefore);

    // 3. 直接写入跨库已有记录 ID：仓储层强校验并回滚，绝不留下 data_json 与 entry_relations 不一致
    const billId = repo.listHydratedEntries('daily_bills')[0].id;
    assert.throws(
      () =>
        repo.createEntry('reading_logs', {
          book: [billId],
          read_date: '2026-11-25',
          end_page: 1,
          duration_min: 5,
        }),
      /只能关联/
    );
    assert.equal(repo.listHydratedEntries('reading_logs').length, logsCountBefore);
  });

  it('clears uncommitted entryCount cache when batch commit rolls back', () => {
    const { repo, driver } = createSeededRepo();
    const initialBooksCount = repo.getLibraryBySlug('books')?.entryCount ?? 0;
    assert.ok(initialBooksCount > 0);

    // 第 1 条草稿新增书本成功，第 2 条草稿缺少必填 read_date 触发回滚
    assert.throws(() =>
      repo.commitOmniDrafts([
        {
          librarySlug: 'books',
          reason: '新增一本测试书',
          data: { book_title: '回滚测试书', author: '作者', status: '在读', total_pages: 120 },
        },
        {
          librarySlug: 'reading_logs',
          reason: '缺少必填日期导致失败',
          data: {
            book: ['@prev:0'],
            end_page: 10,
          },
        },
      ])
    );

    const dbCount = driver.getFirstSync<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM entries e JOIN libraries l ON l.id = e.library_id WHERE l.slug = 'books'"
    )?.cnt;
    assert.equal(dbCount, initialBooksCount);
    assert.equal(
      repo.getLibraryBySlug('books')?.entryCount,
      initialBooksCount,
      'Libraries cache must be invalidated on rollback so entryCount matches SQLite'
    );
  });

  it('enforces required multi-select relations in both draft validation and repository writes', () => {
    const { repo } = createSeededRepo();
    repo.upsertLibrary({
      slug: 'book_clubs',
      name: '共读活动',
      description: '',
      icon: '🎯',
      color: 'teal',
      fields: [
        { key: 'title', label: '主题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '共读书单',
          type: 'relation',
          required: true,
          relationConfig: { targetLibrarySlug: 'books', allowMultiple: true },
        },
      ],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });

    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));
    const emptyDraft = normalizeCaptureDrafts(
      [{ librarySlug: 'book_clubs', reason: '活动', data: { title: '周末沙龙', books_ref: [] } }],
      libMap
    );
    const issues = findDanglingDraftRelations(emptyDraft, libMap);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].reasons, ['missing_required']);

    assert.throws(
      () => repo.createEntry('book_clubs', { title: '周末沙龙', books_ref: [] }),
      /请至少选择一项共读书单/
    );

    const existingBookId = repo.listHydratedEntries('books')[0].id;
    const createdId = repo.createEntry('book_clubs', {
      title: '周末沙龙',
      books_ref: [existingBookId],
    });
    assert.ok(createdId);
  });

  it('supports searching and paginating relation candidates beyond 20 items', () => {
    const { repo } = createSeededRepo();
    for (let i = 1; i <= 25; i += 1) {
      repo.createEntry('books', {
        book_title: `候选书籍-${String(i).padStart(2, '0')}`,
        author: '作者',
        status: '想读',
      });
    }
    const page1 = repo.listRelationCandidates('books', undefined, 21);
    assert.equal(page1.length, 21, 'Fetching limit+1 allows detecting hasMore past 20 items');

    const searchHit = repo.listRelationCandidates('books', '候选书籍-01', 20);
    assert.equal(searchHit.length, 1);
    assert.equal(searchHit[0].title, '候选书籍-01');
  });
});

describe('2. Schema editor config read/write helpers', () => {
  it('preserves expiry_date ASC sort, highlightRules, and calendar tagFieldKey when only renaming med_cabinet', () => {
    const { repo } = createSeededRepo();
    const libs = repo.listLibraries();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    const origCardView = medLib.viewList.find((v) => v.viewType === 'card');
    const origCalView = medLib.viewList.find((v) => v.viewType === 'calendar');
    assert.ok(origCardView);
    assert.ok(origCalView);

    const draft = buildInitialSchemaDraft(libs, medLib);
    draft.name = '家用常备药箱';

    const payload = buildSchemaSavePayload(draft, medLib);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('med_cabinet');
    assert.ok(saved);
    assert.equal(saved.name, '家用常备药箱');
    assert.equal(saved.views.card.sortFieldKey, 'expiry_date');
    assert.equal(saved.views.card.sortDir, 'asc');
    assert.equal(saved.views.card.highlightRules.length, 2);
    assert.equal(saved.views.calendar?.dateFieldKey, 'expiry_date');
    assert.equal(saved.views.calendar?.metricFieldKey, 'stock_count');
    assert.equal(saved.views.calendar?.tagFieldKey, 'purpose');
    assert.equal(saved.viewList.find((v) => v.viewType === 'card')?.id, origCardView.id);
    assert.equal(saved.viewList.find((v) => v.viewType === 'calendar')?.id, origCalView.id);
  });

  it('does not overwrite existing calendar metric when appending a card footer metric', () => {
    const { repo } = createSeededRepo();
    const libs = repo.listLibraries();
    const readingLogs = repo.getLibraryBySlug('reading_logs');
    assert.ok(readingLogs);
    assert.equal(readingLogs.views.calendar?.metricFieldKey, 'duration_min');

    const draft = buildInitialSchemaDraft(libs, readingLogs);
    // 给列表卡片追加一个底部字段
    draft.footerMetricKeys = [...draft.footerMetricKeys, 'read_date'];

    const payload = buildSchemaSavePayload(draft, readingLogs);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('reading_logs');
    assert.ok(saved);
    assert.equal(
      saved.views.calendar?.metricFieldKey,
      'duration_min',
      'Appending a card footer metric must NOT overwrite existing calendar metricFieldKey'
    );
    assert.equal(
      saved.viewList.find((v) => v.viewType === 'calendar')?.config.metricFieldKey,
      'duration_min'
    );
  });

  it('preserves inherited sortDir on secondary card views when renaming library', () => {
    const { repo } = createSeededRepo();
    // 给药箱加一张省略 sortFieldKey / sortDir、继承默认有效期升序的次卡片视图
    const secondCardId = repo.addLibraryView('med_cabinet', 'card', '精简清单', {
      titleFieldKey: 'med_name',
    });
    assert.ok(secondCardId);

    const libs = repo.listLibraries();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    const draft = buildInitialSchemaDraft(libs, medLib);
    draft.name = '常备药箱（已改名）';
    const payload = buildSchemaSavePayload(draft, medLib);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('med_cabinet');
    assert.ok(saved);
    const savedSecondCard = saved.viewList.find((v) => v.id === secondCardId);
    assert.ok(savedSecondCard);
    assert.equal(
      'sortDir' in savedSecondCard.config,
      false,
      'Secondary inheriting card view must not materialize sortDir: desc'
    );
    assert.equal('sortFieldKey' in savedSecondCard.config, false);

    // 验证该次卡片视图依然继承 expiry_date asc 排序
    const sortOptions = getLibrarySortOptions(saved, savedSecondCard.config);
    assert.equal(sortOptions[0].id, 'view_default');
    assert.equal(sortOptions[0].label, '按有效期至');
    assert.equal(sortOptions[0].direction, 'asc');
  });

  it('applies defaults only to newly added views and prunes deleted field references', () => {
    const { repo } = createSeededRepo();
    const libs = repo.listLibraries();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    const draft = buildInitialSchemaDraft(libs, medLib);
    draft.viewDrafts = [...draft.viewDrafts, { name: '药盒画廊', viewType: 'gallery' }];
    draft.fields = draft.fields.filter((f) => f.key !== 'expiry_date');

    const payload = buildSchemaSavePayload(draft, medLib);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('med_cabinet');
    assert.ok(saved);
    assert.equal(saved.views.card.sortFieldKey, undefined);
    assert.equal(saved.views.card.sortDir, 'asc');
    assert.equal(saved.views.card.highlightRules.length, 1);
    assert.equal(saved.views.card.highlightRules[0].fieldKey, 'stock_count');
    assert.equal(saved.views.gallery?.titleFieldKey, 'med_name');
    assert.equal(saved.views.gallery?.badgeFieldKey, 'purpose');
  });
});

describe('3. Scoped repository notifications for widget operations', () => {
  it('does not invalidate libraries cache or fire data listeners on widget pin/reorder/delete', () => {
    const { repo, queries, clearQueries } = createSeededRepo();
    repo.listLibraries();
    const widgets = repo.listAllDashboardWidgets();
    assert.ok(widgets.length >= 2);

    let dataNotifyCount = 0;
    let widgetNotifyCount = 0;
    const unsubData = repo.subscribe(() => {
      dataNotifyCount += 1;
    });
    const unsubWidgets = repo.subscribeWidgets(() => {
      widgetNotifyCount += 1;
    });

    clearQueries();
    repo.setWidgetPinnedOverview(widgets[0].id, !widgets[0].pinnedOverview);
    assert.equal(dataNotifyCount, 0);
    assert.equal(widgetNotifyCount, 1);
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false
    );

    clearQueries();
    repo.listLibraries();
    assert.equal(queries.length, 0);

    clearQueries();
    repo.moveDashboardWidget(
      widgets[0].id,
      'down',
      widgets.map((w) => w.id)
    );
    assert.equal(dataNotifyCount, 0);
    assert.equal(widgetNotifyCount, 2);
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false
    );

    clearQueries();
    repo.deleteDashboardWidget(widgets[widgets.length - 1].id);
    assert.equal(dataNotifyCount, 0);
    assert.equal(widgetNotifyCount, 3);
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false
    );

    repo.saveDashboardWidget(
      {
        id: 'wdg_test_med_1',
        title: '药箱库存数',
        chartType: 'kpi_number',
        readonlySql: 'SELECT COUNT(*) AS cnt FROM v_med_cabinet',
        yKey: 'cnt',
        accentTone: 'rose',
      },
      'med_cabinet'
    );
    assert.equal(dataNotifyCount, 1);
    assert.equal(widgetNotifyCount, 4);

    repo.saveDashboardWidget(
      {
        id: 'wdg_test_med_2',
        title: '药箱总库存量',
        chartType: 'kpi_number',
        readonlySql: 'SELECT SUM(stock_count) AS total FROM v_med_cabinet',
        yKey: 'total',
        accentTone: 'rose',
      },
      'med_cabinet'
    );
    assert.equal(dataNotifyCount, 1);
    assert.equal(widgetNotifyCount, 5);

    unsubData();
    unsubWidgets();
  });
});

describe('4. Library filter and sort rules', () => {
  it('deduplicates sort options by (field, direction) and keeps view_default vs updated_desc distinct', () => {
    const { repo, driver } = createSeededRepo();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    // 药箱默认按 expiry_date asc：必须同时保留 date_desc（expiry_date desc）
    const medSortOptions = getLibrarySortOptions(medLib);
    assert.equal(medSortOptions[0].id, 'view_default');
    assert.equal(medSortOptions[0].label, '按有效期至');
    assert.equal(medSortOptions[0].direction, 'asc');
    assert.equal(medSortOptions[1].id, 'updated_desc');
    assert.equal(medSortOptions[1].label, '最新更新');
    assert.ok(
      medSortOptions.some((o) => o.id === 'date_desc' && o.direction === 'desc'),
      'Opposite direction (expiry_date desc) must remain available when default is asc'
    );

    // 账单默认按 spent_at desc：同字段同方向应去重，不再重复出现 date_desc
    const billsLib = repo.getLibraryBySlug('daily_bills');
    assert.ok(billsLib);
    const billsSortOptions = getLibrarySortOptions(billsLib);
    assert.equal(billsSortOptions[0].id, 'view_default');
    assert.equal(billsSortOptions[0].direction, 'desc');
    assert.equal(
      billsSortOptions.some((o) => o.id === 'date_desc'),
      false
    );

    const rawEntries = repo.listHydratedEntries('med_cabinet');
    assert.ok(rawEntries.length >= 2);
    const latestExpiryEntry = rawEntries[rawEntries.length - 1];
    const earliestExpiryEntry = rawEntries[0];
    driver.runSync('UPDATE entries SET updated_at = ? WHERE id = ?', [
      Date.now() + 60_000,
      latestExpiryEntry.id,
    ]);
    const refreshed = repo.listHydratedEntries('med_cabinet');

    const byDefault = filterAndSortLibraryEntries({
      entries: refreshed,
      library: medLib,
      selectedFilter: null,
      sortMode: 'view_default',
    });
    assert.equal(byDefault.entries[0].id, earliestExpiryEntry.id);

    const byDateDesc = filterAndSortLibraryEntries({
      entries: refreshed,
      library: medLib,
      selectedFilter: null,
      sortMode: 'date_desc',
    });
    assert.equal(byDateDesc.entries[0].id, latestExpiryEntry.id);

    const byUpdated = filterAndSortLibraryEntries({
      entries: refreshed,
      library: medLib,
      selectedFilter: null,
      sortMode: 'updated_desc',
    });
    assert.equal(byUpdated.activeSort.label, '最新更新');
    assert.equal(byUpdated.entries[0].id, latestExpiryEntry.id);
  });

  it('ignores stale filter selection when switching to a card view with a different filter field', () => {
    const { repo } = createSeededRepo();
    const assetsLib = repo.getLibraryBySlug('my_assets');
    assert.ok(assetsLib);
    const rawAssets = repo.listHydratedEntries('my_assets');
    assert.ok(rawAssets.length >= 2);

    // 卡片 1 按 status 筛选「吃灰待出」
    const view1Res = filterAndSortLibraryEntries({
      entries: rawAssets,
      library: assetsLib,
      cardConfig: { rightBadgeFieldKey: 'status' },
      selectedFilter: { fieldKey: 'status', value: '吃灰待出' },
      sortMode: 'view_default',
    });
    assert.equal(view1Res.primaryFilterField?.key, 'status');
    assert.equal(view1Res.activeFilterValue, '吃灰待出');
    assert.ok(view1Res.entries.length > 0 && view1Res.entries.length < rawAssets.length);

    // 切到按 category 筛选的卡片 2：旧 status 筛选值必须自动失效，完整保留全部资产记录
    const view2Res = filterAndSortLibraryEntries({
      entries: rawAssets,
      library: assetsLib,
      cardConfig: { rightBadgeFieldKey: 'category' },
      selectedFilter: { fieldKey: 'status', value: '吃灰待出' },
      sortMode: 'view_default',
    });
    assert.equal(view2Res.primaryFilterField?.key, 'category');
    assert.equal(view2Res.activeFilterValue, '');
    assert.equal(view2Res.entries.length, rawAssets.length);
  });

  it('uses updatedAt DESC when library has no card sortFieldKey and places empty metrics last', () => {
    const { repo, driver } = createSeededRepo();
    repo.upsertLibrary({
      slug: 'notes_plain',
      name: '随记清单',
      description: '',
      icon: '📝',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        { key: 'score', label: '分值', type: 'number', required: false },
      ],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: ['score'],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });

    const idOld = repo.createEntry('notes_plain', { title: '旧记录', score: -5 });
    const idEmpty = repo.createEntry('notes_plain', { title: '空分值记录' });
    const idHigh = repo.createEntry('notes_plain', { title: '高分记录', score: 12 });
    driver.runSync('UPDATE entries SET created_at = 1000, updated_at = 9000 WHERE id = ?', [idOld]);
    driver.runSync('UPDATE entries SET created_at = 2000, updated_at = 2000 WHERE id = ?', [idEmpty]);
    driver.runSync('UPDATE entries SET created_at = 3000, updated_at = 3000 WHERE id = ?', [idHigh]);

    const lib = repo.getLibraryBySlug('notes_plain');
    assert.ok(lib);
    const raw = repo.listHydratedEntries('notes_plain');

    const defaultRes = filterAndSortLibraryEntries({
      entries: raw,
      library: lib,
      selectedFilter: null,
      sortMode: 'view_default',
    });
    assert.equal(defaultRes.activeSort.id, 'updated_desc');
    assert.equal(defaultRes.activeSort.label, '最新更新');
    assert.equal(defaultRes.activeSort.isDefault, true);
    assert.equal(defaultRes.entries[0].id, idOld);

    const metricRes = filterAndSortLibraryEntries({
      entries: raw,
      library: lib,
      selectedFilter: null,
      sortMode: 'metric_desc',
    });
    assert.deepEqual(
      metricRes.entries.map((e) => e.id),
      [idHigh, idOld, idEmpty]
    );
  });
});
