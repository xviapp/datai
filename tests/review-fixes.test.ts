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

describe('1. Quick-capture draft stable IDs & relation binding', () => {
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

  it('keeps valid binding when deleting an unrelated middle draft and blocks cross-library relation', () => {
    const { repo } = createSeededRepo();
    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));

    const managed = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'books',
          reason: '新建书 A',
          data: { book_title: '长安的荔枝', author: '马伯庸', status: '在读', total_pages: 210 },
        },
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
          reason: '读书流水',
          data: {
            book: '@prev:0',
            read_date: '2026-11-25',
            end_page: 20,
            duration_min: 15,
          },
        },
      ],
      libMap
    );

    // 删除中间无关的账单草稿，书 A 与阅读记录的关联依然有效
    const { nextDrafts } = removeCaptureDraftById(managed, managed[1].draftId, libMap);
    assert.equal(findDanglingDraftRelations(nextDrafts, libMap).length, 0);
    const [bookId, logId] = repo.commitOmniDrafts(nextDrafts);
    const hydratedLog = repo.getHydratedEntryById(logId);
    assert.equal(hydratedLog?.entry.forwardLinks.book?.[0]?.id, bookId);

    // 验证跨库关联防御：reading_logs.book 只能关联 books，不能挂到 daily_bills 条目
    const billId = repo.listHydratedEntries('daily_bills')[0].id;
    const crossLogId = repo.createEntry('reading_logs', {
      book: [billId],
      read_date: '2026-11-25',
      end_page: 1,
      duration_min: 5,
    });
    const crossLog = repo.getHydratedEntryById(crossLogId);
    assert.equal(crossLog?.entry.forwardLinks.book ?? undefined, undefined);
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
    assert.equal(medLib.views.card.sortFieldKey, 'expiry_date');
    assert.equal(medLib.views.card.sortDir, 'asc');
    assert.equal(medLib.views.calendar?.tagFieldKey, 'purpose');

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

  it('applies defaults only to newly added views and prunes deleted field references', () => {
    const { repo } = createSeededRepo();
    const libs = repo.listLibraries();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    const draft = buildInitialSchemaDraft(libs, medLib);
    // 新增画廊视图，同时删掉 expiry_date 字段
    draft.viewDrafts = [...draft.viewDrafts, { name: '药盒画廊', viewType: 'gallery' }];
    draft.fields = draft.fields.filter((f) => f.key !== 'expiry_date');

    const payload = buildSchemaSavePayload(draft, medLib);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('med_cabinet');
    assert.ok(saved);
    assert.equal(saved.views.card.sortFieldKey, undefined);
    assert.equal(saved.views.card.sortDir, 'asc');
    // expiry_date 对应高亮规则被安全清理，stock_count 规则保留
    assert.equal(saved.views.card.highlightRules.length, 1);
    assert.equal(saved.views.card.highlightRules[0].fieldKey, 'stock_count');
    // 新增的 gallery 视图获得合理默认配置
    assert.equal(saved.views.gallery?.titleFieldKey, 'med_name');
    assert.equal(saved.views.gallery?.badgeFieldKey, 'purpose');
  });
});

describe('3. Scoped repository notifications for widget operations', () => {
  it('does not invalidate libraries cache or fire data listeners on widget pin/reorder/delete', () => {
    const { repo, queries, clearQueries } = createSeededRepo();
    // 预热缓存
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
    assert.equal(dataNotifyCount, 0, 'Toggling overview pin must not notify data listeners');
    assert.equal(widgetNotifyCount, 1, 'Toggling overview pin must notify widget listeners');
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false,
      'Toggling overview pin must not query libraries or library_views'
    );

    // 紧接着读取 listLibraries 应继续命中热缓存
    clearQueries();
    repo.listLibraries();
    assert.equal(queries.length, 0, 'Libraries cache should remain warm after widget pin toggle');

    clearQueries();
    repo.moveDashboardWidget(
      widgets[0].id,
      'down',
      widgets.map((w) => w.id)
    );
    assert.equal(dataNotifyCount, 0, 'Reordering widgets must not notify data listeners');
    assert.equal(widgetNotifyCount, 2, 'Reordering widgets must notify widget listeners');
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false
    );

    clearQueries();
    repo.deleteDashboardWidget(widgets[widgets.length - 1].id);
    assert.equal(dataNotifyCount, 0, 'Deleting widget must not notify data listeners');
    assert.equal(widgetNotifyCount, 3, 'Deleting widget must notify widget listeners');
    assert.equal(
      queries.some((q) => q.includes('FROM libraries') || q.includes('FROM library_views')),
      false
    );

    // 保存图表到尚未开启 stats 视图的库时，因新增了 library_views 行，需要同时触发两类通知
    const medBefore = repo.getLibraryBySlug('med_cabinet');
    const hadStatsBefore = medBefore?.viewList.some((v) => v.viewType === 'stats') ?? false;
    assert.equal(hadStatsBefore, false);

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
    assert.equal(dataNotifyCount, 1, 'Creating a new stats view must notify data listeners');
    assert.equal(widgetNotifyCount, 4);

    // 再次保存图表到已有 stats 视图的库时，不应再触发 data listener
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
    assert.equal(
      dataNotifyCount,
      1,
      'Saving widget to library that already has stats view must not notify data listeners'
    );
    assert.equal(widgetNotifyCount, 5);

    unsubData();
    unsubWidgets();
  });
});

describe('4. Library filter and sort rules', () => {
  it('separates view default sort from explicit updatedAt sort and keeps labels consistent', () => {
    const { repo, driver } = createSeededRepo();
    const medLib = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medLib);

    const sortOptions = getLibrarySortOptions(medLib);
    assert.equal(sortOptions[0].id, 'view_default');
    assert.equal(sortOptions[0].label, '按有效期至');
    assert.equal(sortOptions[0].direction, 'asc');
    assert.equal(sortOptions[1].id, 'updated_desc');
    assert.equal(sortOptions[1].label, '最新更新');
    // 不应重复出现两个「按有效期至」选项
    assert.equal(
      sortOptions.filter((o) => o.label === '按有效期至').length,
      1
    );

    const rawEntries = repo.listHydratedEntries('med_cabinet');
    assert.ok(rawEntries.length >= 2);
    // 让有效期最晚的记录拥有最新的 updated_at
    const latestExpiryEntry = rawEntries[rawEntries.length - 1];
    const earliestExpiryEntry = rawEntries[0];
    assert.ok(
      String(earliestExpiryEntry.computedData.expiry_date) <
        String(latestExpiryEntry.computedData.expiry_date)
    );
    driver.runSync('UPDATE entries SET updated_at = ? WHERE id = ?', [
      Date.now() + 60_000,
      latestExpiryEntry.id,
    ]);
    const refreshed = repo.listHydratedEntries('med_cabinet');

    // 默认视图排序：按钮显示「按有效期至(asc)」，实际首条是有效期最早的
    const byDefault = filterAndSortLibraryEntries({
      entries: refreshed,
      library: medLib,
      selectedFilterValue: '',
      sortMode: 'view_default',
    });
    assert.equal(byDefault.activeSort.label, '按有效期至');
    assert.equal(byDefault.entries[0].id, earliestExpiryEntry.id);

    // 切换到「最新更新」：显式按 updatedAt 降序，首条必须是刚更新的记录
    const byUpdated = filterAndSortLibraryEntries({
      entries: refreshed,
      library: medLib,
      selectedFilterValue: '',
      sortMode: 'updated_desc',
    });
    assert.equal(byUpdated.activeSort.label, '最新更新');
    assert.equal(byUpdated.entries[0].id, latestExpiryEntry.id);
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
    // 人为把最早创建的 idOld 设为最近更新
    driver.runSync('UPDATE entries SET created_at = 1000, updated_at = 9000 WHERE id = ?', [idOld]);
    driver.runSync('UPDATE entries SET created_at = 2000, updated_at = 2000 WHERE id = ?', [idEmpty]);
    driver.runSync('UPDATE entries SET created_at = 3000, updated_at = 3000 WHERE id = ?', [idHigh]);

    const lib = repo.getLibraryBySlug('notes_plain');
    assert.ok(lib);
    const raw = repo.listHydratedEntries('notes_plain');

    // 未配置 sortFieldKey 时，默认即「最新更新」且确实按 updatedAt 降序
    const defaultRes = filterAndSortLibraryEntries({
      entries: raw,
      library: lib,
      selectedFilterValue: '',
      sortMode: 'view_default',
    });
    assert.equal(defaultRes.activeSort.id, 'updated_desc');
    assert.equal(defaultRes.activeSort.label, '最新更新');
    assert.equal(defaultRes.activeSort.isDefault, true);
    assert.equal(defaultRes.entries[0].id, idOld);

    // 按数值降序时，负数(-5)应排在空值前面，空值置底
    const metricRes = filterAndSortLibraryEntries({
      entries: raw,
      library: lib,
      selectedFilterValue: '',
      sortMode: 'metric_desc',
    });
    assert.deepEqual(
      metricRes.entries.map((e) => e.id),
      [idHigh, idOld, idEmpty]
    );
  });
});
