import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildDatabaseCatalogPrompt } from '../src/ai/prompts';
import {
  getAnalystJsonSchema,
  getArchitectJsonSchema,
  getOmniCaptureJsonSchema,
  type ArchitectPlan,
} from '../src/ai/schemas';
import { LATEST_SCHEMA_VERSION, MAX_AI_SNAPSHOTS } from '../src/db/migrations';
import { OmniRepository } from '../src/db/repository';
import {
  sanitizeReadOnlySql,
  sqlReferencesLibraryView,
  type SqlParam,
  type SyncSqlDriver,
} from '../src/db/types';
import { formatLocalDate, formatLocalDateOffset } from '../src/engine/date';

function createNodeSqliteDriver(): SyncSqlDriver {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  let inTx = false;

  return {
    execSync(sql: string) {
      db.exec(sql);
    },
    runSync(sql: string, params: SqlParam[] = []) {
      db.prepare(sql).run(...params);
    },
    getAllSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T[] {
      return db.prepare(sql).all(...params) as unknown as T[];
    },
    getFirstSync<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): T | null {
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
      db.exec('PRAGMA query_only = ON;');
      try {
        return db.prepare(safe).all() as unknown as T[];
      } finally {
        db.exec('PRAGMA query_only = OFF;');
      }
    },
  };
}

function runTests() {
  console.log('1. Testing Zod v4 native z.toJSONSchema exports...');
  const archSchema = getArchitectJsonSchema() as Record<string, unknown>;
  const omniSchema = getOmniCaptureJsonSchema() as Record<string, unknown>;
  const analystSchema = getAnalystJsonSchema() as Record<string, unknown>;
  assert.equal(archSchema.type, 'object');
  assert.equal(omniSchema.type, 'object');
  assert.equal(analystSchema.type, 'object');
  console.log('   ✓ Zod v4 JSON Schemas generated cleanly');

  console.log('2. Testing OmniRepository migrations, seeding, views, Rollups & Formulas...');
  const driver = createNodeSqliteDriver();
  const repo = new OmniRepository(driver);
  const verRow = driver.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  assert.equal(verRow?.user_version, LATEST_SCHEMA_VERSION, 'user_version must be updated');
  repo.seedIfEmpty();

  const libs = repo.listLibraries();
  assert.equal(libs.length, 7, 'Should seed 7 default libraries (6 primary + 1 reading_logs sub-library)');
  assert.equal(
    libs.filter((l) => l.showOnHome).length,
    6,
    '6 primary libraries should be shown on Home by default'
  );

  // Verify reverse rollup + formula + hydrated backlink groups on Sony A7C2 asset
  const assets = repo.listHydratedEntries('my_assets');
  const sony = assets.find((e) => e.titleSummary.includes('Sony A7C2'));
  if (!sony) throw new Error('Sony A7C2 should exist');
  assert.equal(sony.computedData.extra_spend, 5220, 'Reverse rollup extra_spend should sum linked bills (4580 + 640)');
  assert.equal(sony.backlinks.length, 2, 'Sony A7C2 should have 2 backlinked bill entries');
  assert.ok(Number(sony.computedData.daily_cost) > 0, 'Daily holding cost formula should evaluate > 0');
  const sonyBacklinkGroups = repo.listBacklinkGroupsForEntry(sony.id);
  assert.equal(sonyBacklinkGroups.length, 1, 'Sony A7C2 should have 1 backlink group (daily_bills)');
  assert.equal(sonyBacklinkGroups[0].sourceLibrary.slug, 'daily_bills');
  assert.equal(sonyBacklinkGroups[0].relationFieldKey, 'related_asset');
  assert.equal(sonyBacklinkGroups[0].relationFieldLabel, '关联装备资产');
  assert.equal(sonyBacklinkGroups[0].entries.length, 2, 'Group should contain 2 hydrated bill entries');
  assert.equal(sonyBacklinkGroups[0].entries[0].computedData.amount, 640, 'Most recent bill (offset -6d) should be sorted first');
  assert.equal(sonyBacklinkGroups[0].entries[1].computedData.amount, 4580, 'Older lens bill (offset -12d) should be sorted second');
  console.log(
    `   ✓ Sony A7C2 extra_spend=${sony.computedData.extra_spend}, daily_cost=${sony.computedData.daily_cost}/day, backlinkGroups=${sonyBacklinkGroups.length}`
  );

  // Verify 30-day medicine expiry danger highlight
  const meds = repo.listHydratedEntries('med_cabinet');
  const eyeDrops = meds.find((m) => m.titleSummary.includes('玻璃酸钠'));
  if (!eyeDrops) throw new Error('Eye drops should exist');
  assert.equal(eyeDrops.highlight?.tone, 'danger', 'Eye drops expiring in 16 days should trigger danger highlight');
  assert.equal(eyeDrops.computedData.taken_count, 1, 'Eye drops taken_count rollup should be 1');
  console.log(
    `   ✓ Medicine alert highlight=${eyeDrops.highlight?.tone} (${eyeDrops.highlight?.badgeText}), taken_count=${eyeDrops.computedData.taken_count}`
  );

  console.log('3. Testing Dashboard read-only SQLite logical views & security sandbox...');
  const widgets = repo.listDashboardWidgets(null);
  assert.equal(widgets.length, 4);
  for (const w of widgets) {
    const rows = repo.executeReadOnlyQuery(w.readonlySql);
    assert.ok(rows.length > 0, `Widget ${w.id} should return non-empty rows`);
  }
  assert.throws(
    () => repo.executeReadOnlyQuery('DROP TABLE entries'),
    /只读沙盒/,
    'Sandbox must reject DROP TABLE'
  );
  assert.throws(
    () => repo.executeReadOnlyQuery('SELECT * FROM v_daily_bills; DELETE FROM entries'),
    /单条只读/,
    'Sandbox must reject multi-statement SQL'
  );
  // REPLACE() function and ';' inside string literals must be allowed!
  const replaceRows = repo.executeReadOnlyQuery(
    "SELECT REPLACE(category, '数码', '电子') AS cat, 'a;b' AS sep FROM v_daily_bills LIMIT 2"
  );
  assert.equal(replaceRows.length, 2);
  assert.equal(replaceRows[0].sep, 'a;b');
  console.log('   ✓ SQLite view widgets, REPLACE(), quoted semicolons & injection blocking verified');

  console.log('4. Testing image exclusion from search_text & SQL views...');
  const mediaId = repo.createEntry('media_vault', {
    work_title: '千与千寻',
    media_type: '电影',
    rating: 5,
    finished_date: '2026-11-22',
    cover_image: 'data:image/jpeg;base64,ABCDEF123456UNIQUE',
  });
  const mediaRow = driver.getFirstSync<{ search_text: string }>(
    'SELECT search_text FROM entries WHERE id = ?',
    [mediaId]
  );
  assert.ok(
    !mediaRow?.search_text.includes('abcdef123456unique'),
    'Image base64/path must NOT be indexed into search_text'
  );
  const viewCols = driver.getAllSync<{ name: string }>('PRAGMA table_info(v_media_vault)');
  assert.ok(
    !viewCols.some((c) => c.name === 'cover_image'),
    'Image columns must be excluded from SQL logical view v_<slug>'
  );
  console.log('   ✓ Image excluded from search_text and SQL views');

  console.log('5. Testing LIKE escaping (% and _) & lightweight global search...');
  repo.createEntry('daily_bills', {
    title: '100% 果汁折扣券',
    amount: 28,
    category: '餐饮美食',
    pay_account: '微信',
    spent_at: '2026-11-22',
  });
  repo.createEntry('daily_bills', {
    title: '1000 元健身年卡',
    amount: 1000,
    category: '生活日用',
    pay_account: '支付宝',
    spent_at: '2026-11-22',
  });
  const pctHits = repo.searchEntrySummaries('100%');
  assert.equal(pctHits.length, 1, 'Searching 100% must only match literal 100%, not 1000');
  assert.equal(pctHits[0].title, '100% 果汁折扣券');
  const hydratedPct = repo.listHydratedEntries('daily_bills', '100%');
  assert.equal(hydratedPct.length, 1);
  console.log('   ✓ LIKE wildcard escaping & searchEntrySummaries verified');

  console.log('6. Testing word-boundary view matching (v_bill vs v_bills)...');
  assert.equal(sqlReferencesLibraryView('SELECT * FROM v_bill', 'bill'), true);
  assert.equal(sqlReferencesLibraryView('SELECT * FROM v_bills', 'bill'), false);
  assert.equal(sqlReferencesLibraryView('SELECT * FROM v_daily_bills', 'daily_bill'), false);
  assert.equal(sqlReferencesLibraryView('SELECT * FROM v_daily_bills', 'daily_bills'), true);
  repo.upsertLibrary({
    slug: 'daily_bill',
    name: '单条账单测试',
    description: '',
    icon: '🧾',
    color: 'blue',
    fields: [{ key: 'title', label: '名称', type: 'text', required: true }],
    views: { card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] } },
  });
  const widgetsBeforeDel = repo.listAllDashboardWidgets().length;
  repo.deleteLibrary('daily_bill');
  assert.equal(
    repo.listAllDashboardWidgets().length,
    widgetsBeforeDel,
    'Deleting daily_bill must NOT delete widgets referencing v_daily_bills'
  );
  console.log('   ✓ Word-boundary view matching verified');

  console.log('7. Testing Omni-Capture @prev:0 commit & non-destructive incremental undo...');
  const createdIds = repo.commitOmniDrafts(
    [
      {
        librarySlug: 'my_assets',
        reason: '新建装备 Switch 2',
        data: {
          item_name: 'Nintendo Switch 2',
          category: '掌机娱乐',
          buy_price: 2999,
          resale_value: 2400,
          buy_date: '2026-11-20',
          status: '主力服役',
        },
      },
      {
        librarySlug: 'daily_bills',
        reason: '同步记录购买手柄配件账单并关联 Switch 2',
        data: {
          title: 'Switch 2 Pro 手柄',
          amount: 459,
          category: '数码配件',
          pay_account: '招商信用卡',
          spent_at: '2026-11-21',
          related_asset: ['@prev:0'],
        },
      },
    ],
    'AI 快记：购入 Switch 2 与手柄'
  );
  assert.equal(createdIds.length, 2);
  const switchHydrated = repo.getHydratedEntryById(createdIds[0]);
  assert.equal(switchHydrated?.entry.computedData.extra_spend, 459, '@prev:0 relation must link bill to newly created asset');

  // Add another bill AFTER omni draft commit, then undo the omni draft — subsequent bill MUST survive!
  const laterBillId = repo.createEntry('daily_bills', {
    title: '后续手动记账必须保留',
    amount: 55,
    category: '餐饮美食',
    pay_account: '微信',
    spent_at: '2026-11-22',
  });
  const omniSnap = repo.listSnapshots()[0];
  const omniImpact = repo.describeSnapshotUndoImpact(omniSnap.id);
  assert.equal(omniImpact.isFullRestore, false);
  repo.undoSnapshot(omniSnap.id);
  assert.equal(repo.getHydratedEntryById(createdIds[0]), null, 'Undoing draft should delete draft asset');
  assert.ok(repo.getHydratedEntryById(laterBillId), 'Later manual entry MUST survive incremental undo');
  console.log('   ✓ @prev:0 linking & non-destructive draft undo verified');

  console.log('8. Testing deleteEntry undo & snapshot cap (MAX_AI_SNAPSHOTS)...');
  const delSnapId = repo.deleteEntry(laterBillId);
  assert.ok(delSnapId, 'deleteEntry must produce an undoable snapshot');
  assert.equal(repo.getHydratedEntryById(laterBillId), null);
  repo.undoSnapshot(delSnapId!);
  assert.equal(
    repo.getHydratedEntryById(laterBillId)?.entry.titleSummary,
    '后续手动记账必须保留',
    'Undoing deleteEntry must restore the deleted entry'
  );

  // Create > MAX_AI_SNAPSHOTS snapshots to verify pruning
  for (let i = 0; i < MAX_AI_SNAPSHOTS + 5; i++) {
    const tmpId = repo.createEntry('daily_bills', {
      title: `快照上限测试 ${i}`,
      amount: 1,
      category: '其他',
      pay_account: '微信',
      spent_at: '2026-11-22',
    });
    repo.deleteEntry(tmpId);
  }
  const snapCountRow = driver.getFirstSync<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM ai_snapshots');
  assert.equal(
    snapCountRow?.cnt,
    MAX_AI_SNAPSHOTS,
    `ai_snapshots must be pruned to at most ${MAX_AI_SNAPSHOTS}`
  );
  console.log(`   ✓ deleteEntry undo & snapshot pruning (${MAX_AI_SNAPSHOTS}) verified`);

  console.log('9. Testing Architect Plan diff guard & incremental undo...');
  const destructivePlan: ArchitectPlan = {
    summary: '误删 daily_bills 的 amount 字段',
    libraries: [
      {
        slug: 'daily_bills',
        name: '日常账单',
        description: '',
        icon: '💰',
        color: 'teal',
        fields: [{ key: 'title', label: '消费项目', type: 'text', required: true }],
        views: { card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] } },
      },
    ],
    dashboardWidgets: [],
  };
  const diffs = repo.analyzeArchitectPlanDiff(destructivePlan);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].hasDestructiveChanges, true);
  assert.throws(
    () => repo.applyArchitectPlan(destructivePlan),
    /破坏性字段变更/,
    'applyArchitectPlan must guard against destructive field removal by default'
  );

  const safePlan: ArchitectPlan = {
    summary: 'AI 新建《健身训练日志》',
    libraries: [
      {
        slug: 'workout_logs',
        name: '健身训练日志',
        description: '力量与有氧打卡',
        icon: '🏋️',
        color: 'emerald',
        fields: [
          { key: 'movement', label: '训练动作', type: 'text', required: true },
          { key: 'weight_kg', label: '负重', type: 'number', required: true, unit: 'kg' },
          { key: 'reps', label: '次数', type: 'number', required: true, unit: '次' },
          {
            key: 'volume',
            label: '单组容量',
            type: 'formula',
            required: false,
            unit: 'kg',
            formulaExpr: 'weight_kg * reps',
          },
        ],
        views: {
          card: {
            titleFieldKey: 'movement',
            footerMetricKeys: ['weight_kg', 'reps', 'volume'],
            sortDir: 'desc',
            highlightRules: [],
          },
        },
      },
    ],
    dashboardWidgets: [],
  };

  const snapId = repo.applyArchitectPlan(safePlan);
  assert.equal(repo.listLibraries().length, 8, 'workout_logs should be added');
  const wEntryId = repo.createEntry('workout_logs', { movement: '深蹲', weight_kg: 100, reps: 8 });
  assert.equal(repo.getHydratedEntryById(wEntryId)?.entry.computedData.volume, 800);

  // Add an entry to another library AFTER applying the architect plan
  const unrelatedBillId = repo.createEntry('daily_bills', {
    title: '撤销建筑师后仍须存在',
    amount: 12,
    category: '餐饮美食',
    pay_account: '微信',
    spent_at: '2026-11-22',
  });

  // Undo architect plan: workout_logs removed, but unrelatedBillId MUST survive!
  repo.undoSnapshot(snapId);
  assert.equal(repo.listLibraries().length, 7, 'Undo should restore library count back to 7');
  assert.equal(repo.getLibraryBySlug('workout_logs'), null, 'workout_logs should be removed after undo');
  assert.ok(
    repo.getHydratedEntryById(unrelatedBillId),
    'Entries added to other libraries after architect plan MUST survive undo'
  );
  console.log('   ✓ Architect Plan diff guard & non-destructive undo verified');

  console.log('10. Testing local date helper...');
  const localMidnight = new Date(2026, 10, 22, 0, 30, 0);
  assert.equal(formatLocalDate(localMidnight), '2026-11-22');
  assert.equal(formatLocalDateOffset(-1, localMidnight), '2026-11-21');
  console.log('   ✓ Local date helpers verified');

  console.log('11. Testing Master-Detail Sub-Libraries (books <-> reading_logs), multiline quotes & detach-on-delete...');
  const readingLogsLib = repo.getLibraryBySlug('reading_logs');
  assert.ok(readingLogsLib, 'reading_logs sub-library must exist');
  assert.equal(readingLogsLib!.parentLibrarySlug, 'books');
  assert.equal(readingLogsLib!.showOnHome, false);
  assert.equal(repo.listChildLibraries('books').length, 1);

  const catalogPrompt = buildDatabaseCatalogPrompt(repo.getLibraryCatalogItems(true));
  assert.ok(
    catalogPrompt.includes('附属子库 -> 归属主库 `books`'),
    'AI catalog must expose parent-child sub-library relationship'
  );
  assert.ok(
    catalogPrompt.includes('[多行长文本/书摘笔记]'),
    'AI catalog must expose multiline text field hint'
  );

  const books = repo.listHydratedEntries('books');
  const lizhi = books.find((b) => b.titleSummary === '长安的荔枝');
  assert.ok(lizhi, '长安的荔枝 should exist');
  assert.equal(lizhi!.computedData.current_page, 148, 'MAX(end_page) rollup should be 148');
  assert.equal(lizhi!.computedData.total_minutes, 80, 'SUM(duration_min) rollup should be 80');
  assert.equal(lizhi!.computedData.log_count, 2, 'COUNT rollup should be 2');
  assert.equal(lizhi!.computedData.progress_pct, 68.5, 'Reading progress formula should be 68.5%');

  // Verify pure quote log (no page/duration numbers) coexists cleanly with structured metrics
  const pureQuoteLogId = repo.createEntry('reading_logs', {
    book: [lizhi!.id],
    read_date: '2026-11-22',
    note: '纯书摘测试第一行\n第二行详细感悟不破坏单行摘要',
  });
  const pureQuoteHydrated = repo.getHydratedEntryById(pureQuoteLogId);
  assert.equal(
    pureQuoteHydrated?.entry.titleSummary,
    '纯书摘测试第一行',
    'Multiline note titleSummary should extract clean first line'
  );

  const lizhiAfterQuote = repo.getHydratedEntryById(lizhi!.id)!.entry;
  assert.equal(lizhiAfterQuote.computedData.log_count, 3, 'log_count should increment to 3');
  assert.equal(lizhiAfterQuote.computedData.current_page, 148, 'current_page should remain 148');
  assert.equal(lizhiAfterQuote.computedData.total_minutes, 80, 'total_minutes should remain 80');

  const childSections = repo.listChildSectionsForEntry(lizhi!.id, 'books');
  assert.equal(childSections.length, 1);
  assert.equal(childSections[0].entries.length, 3);
  const lizhiFilteredBacklinks = repo.listBacklinkGroupsForEntry(
    lizhi!.id,
    new Set(['reading_logs'])
  );
  assert.equal(
    lizhiFilteredBacklinks.length,
    0,
    'Child sub-library slugs must be excluded from generic backlink groups to avoid duplicate tabs'
  );

  // Verify brand-new book with 0 logs still exposes empty child timeline section for immediate inline logging
  const emptyBookId = repo.createEntry('books', {
    book_title: '太白金星有点烦',
    author: '马伯庸',
    status: '想读',
    total_pages: 260,
  });
  const emptySections = repo.listChildSectionsForEntry(emptyBookId, 'books');
  assert.equal(emptySections.length, 1);
  assert.equal(emptySections[0].entries.length, 0);

  // Verify deleting parent book detaches child reading logs WITHOUT deleting them, and undo restores full link!
  const delBookSnapId = repo.deleteEntry(lizhi!.id);
  assert.ok(delBookSnapId);
  assert.equal(repo.getHydratedEntryById(lizhi!.id), null, 'Book should be deleted');
  const survivingQuote = repo.getHydratedEntryById(pureQuoteLogId);
  assert.ok(survivingQuote, 'Child reading log MUST survive parent book deletion (detach mode)');
  assert.deepEqual(
    survivingQuote!.entry.rawData.book,
    [],
    'Detached child reading log data_json must have clean empty relation array'
  );
  assert.deepEqual(survivingQuote!.entry.forwardLinks.book ?? [], []);

  repo.undoSnapshot(delBookSnapId!);
  const restoredLizhi = repo.getHydratedEntryById(lizhi!.id);
  assert.ok(restoredLizhi, 'Book should be restored after undo');
  assert.equal(restoredLizhi!.entry.computedData.log_count, 3, 'All 3 child logs must re-attach on undo');
  assert.deepEqual(repo.getHydratedEntryById(pureQuoteLogId)!.entry.rawData.book, [lizhi!.id]);

  // Verify deleting parent library detaches hidden sub-library to Home so it never becomes unreachable
  repo.deleteLibrary('books');
  const detachedLogsLib = repo.getLibraryBySlug('reading_logs');
  assert.equal(detachedLogsLib?.parentLibrarySlug, null);
  assert.equal(detachedLogsLib?.showOnHome, true, 'Orphaned sub-library must become visible on Home');
  const libDelSnap = repo.listSnapshots()[0];
  repo.undoSnapshot(libDelSnap.id);
  assert.equal(repo.getLibraryBySlug('reading_logs')?.parentLibrarySlug, 'books');
  assert.equal(repo.getLibraryBySlug('reading_logs')?.showOnHome, false);
  // Verify v2 -> v3 incremental SQLite migration on legacy database without parent_slug/show_on_home
  const legacyDriver = createNodeSqliteDriver();
  legacyDriver.execSync(`
    CREATE TABLE libraries (
      id TEXT PRIMARY KEY NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '📦',
      color TEXT NOT NULL DEFAULT 'teal',
      fields_json TEXT NOT NULL,
      views_json TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO libraries (id, slug, name, description, icon, color, fields_json, views_json, sort_order, created_at, updated_at)
    VALUES ('lib_old', 'old_notes', '旧版笔记', '', '📒', 'teal', '[{"key":"title","label":"标题","type":"text","required":true}]', '{"card":{"titleFieldKey":"title","footerMetricKeys":[],"sortDir":"desc","highlightRules":[]}}', 0, 1000, 1000);
    PRAGMA user_version = 2;
  `);
  const migratedRepo = new OmniRepository(legacyDriver);
  const migratedLib = migratedRepo.getLibraryBySlug('old_notes');
  assert.ok(migratedLib);
  assert.equal(migratedLib!.parentLibrarySlug, null);
  assert.equal(migratedLib!.showOnHome, true);
  assert.equal(
    legacyDriver.getFirstSync<{ user_version: number }>('PRAGMA user_version')?.user_version,
    LATEST_SCHEMA_VERSION
  );
  console.log('   ✓ Sub-library hierarchy, multiline quotes, detach-on-delete, undo & v2->v3 migration verified');

  console.log('12. Testing v4 decoupled library_views & library_relations tables + v2 backup...');
  // Legacy v2 database upgraded all the way to v4 must have backfilled library_views
  const migratedViews = migratedRepo.listLibraryViews('old_notes');
  assert.equal(migratedViews.length, 1, 'Minimal library should only have 1 default card view');
  assert.equal(migratedViews[0].viewType, 'card');

  // Seeded libraries should have tailored on-demand views in library_views table
  const assetViews = repo.listLibraryViews('my_assets');
  assert.ok(assetViews.some((v) => v.viewType === 'card'));
  assert.ok(assetViews.some((v) => v.viewType === 'stats'), 'Assets with widgets must auto-get stats view');
  assert.ok(!assetViews.some((v) => v.viewType === 'gallery'), 'Assets without gallery config should not force gallery');

  const mediaViews = repo.listLibraryViews('media_vault');
  assert.ok(mediaViews.some((v) => v.viewType === 'gallery'), 'Media vault should have gallery view');

  // Custom view CRUD (add, rename, reorder, delete)
  const newCalViewId = repo.addLibraryView('media_vault', 'calendar', '观影日历');
  assert.ok(repo.listLibraryViews('media_vault').some((v) => v.id === newCalViewId && v.name === '观影日历'));
  repo.deleteLibraryView(newCalViewId);
  assert.ok(!repo.listLibraryViews('media_vault').some((v) => v.id === newCalViewId));

  // Table-level library_relations table must mirror relation & parent_child links
  const bookRelations = repo.listLibraryRelations('books');
  assert.ok(
    bookRelations.some((r) => r.sourceLibrarySlug === 'reading_logs' && r.relationKind === 'parent_child'),
    'library_relations must record parent_child relation for books <-> reading_logs'
  );
  const assetRelations = repo.listLibraryRelations('my_assets');
  assert.ok(
    assetRelations.some((r) => r.sourceLibrarySlug === 'daily_bills' && r.relationKind === 'reference'),
    'library_relations must record reference relation for daily_bills -> my_assets'
  );

  // Full backup v2 round-trip must preserve library_views & library_relations
  const backupV2 = repo.exportBackupBundle();
  assert.equal(backupV2.version, 2);
  assert.ok((backupV2.libraryViews?.length ?? 0) >= 7);
  assert.ok((backupV2.libraryRelations?.length ?? 0) >= 2);
  const restoreDriver = createNodeSqliteDriver();
  const restoreRepo = new OmniRepository(restoreDriver);
  restoreRepo.importBackupBundle(backupV2);
  assert.deepEqual(
    restoreRepo.listLibraryViews('my_assets').map((v) => v.viewType),
    repo.listLibraryViews('my_assets').map((v) => v.viewType)
  );
  assert.equal(restoreRepo.listLibraryRelations().length, repo.listLibraryRelations().length);

  // Verify AI Architect plan can authoritatively design/remove/rename/reorder views & undo losslessly
  const booksBeforeAi = repo.getLibraryBySlug('books')!;
  const prevBookViewSignature = booksBeforeAi.viewList.map((v) => `${v.name}:${v.viewType}`);
  const aiViewSnapId = repo.applyArchitectPlan({
    summary: '给书单重排视图为封面墙优先，并移除多余视图',
    libraries: [
      {
        slug: booksBeforeAi.slug,
        name: booksBeforeAi.name,
        description: booksBeforeAi.description,
        icon: booksBeforeAi.icon,
        color: booksBeforeAi.color,
        fields: booksBeforeAi.fields,
        viewList: [
          { name: '书墙', viewType: 'gallery' },
          { name: '书单', viewType: 'card' },
        ],
        views: {
          card: booksBeforeAi.views.card,
          gallery: booksBeforeAi.views.gallery ?? {
            titleFieldKey: booksBeforeAi.views.card.titleFieldKey,
          },
        },
      },
    ],
    dashboardWidgets: [],
  });
  assert.deepEqual(
    repo.listLibraryViews('books').map((v) => `${v.name}:${v.viewType}`),
    ['书墙:gallery', '书单:card'],
    'AI Architect viewList must authoritatively control view order, names, and removals'
  );
  repo.undoSnapshot(aiViewSnapId);
  assert.deepEqual(
    repo.listLibraryViews('books').map((v) => `${v.name}:${v.viewType}`),
    prevBookViewSignature,
    'Undoing AI Architect view plan must restore previous library_views exactly'
  );

  console.log('   ✓ v4 library_views CRUD, AI view design/undo, library_relations table & v2 backup verified');

  console.log('13. Testing single-tx upsertLibrary+views, getEntryTitleMap, listLatestEntryByLibrary & image ref tracking...');
  let notifyCount = 0;
  const unsubNotify = repo.subscribe(() => {
    notifyCount += 1;
  });
  const booksCurrent = repo.getLibraryBySlug('books')!;
  repo.upsertLibrary(
    {
      slug: booksCurrent.slug,
      name: booksCurrent.name,
      description: booksCurrent.description,
      icon: booksCurrent.icon,
      color: booksCurrent.color,
      fields: booksCurrent.fields,
      views: booksCurrent.views,
    },
    [
      { name: '书单列表', viewType: 'card', config: booksCurrent.views.card as unknown as Record<string, unknown> },
      { name: '封面墙', viewType: 'gallery', config: (booksCurrent.views.gallery ?? { titleFieldKey: 'book_title' }) as unknown as Record<string, unknown> },
    ]
  );
  unsubNotify();
  assert.equal(notifyCount, 1, 'Single-tx upsertLibrary with viewInputs must trigger notify exactly once');
  assert.deepEqual(
    repo.listLibraryViews('books').map((v) => `${v.name}:${v.viewType}`),
    ['书单列表:card', '封面墙:gallery']
  );

  const titleMap = repo.getEntryTitleMap([sony.id, lizhi!.id, 'nonexistent_id']);
  assert.equal(titleMap.size, 2);
  assert.equal(titleMap.get(lizhi!.id), '长安的荔枝');

  const latestMap = repo.listLatestEntryByLibrary();
  assert.ok(latestMap.size >= 6, 'Window-function listLatestEntryByLibrary should return latest per populated library');
  assert.ok(latestMap.get(booksCurrent.id)?.title, 'Latest book entry title must be present');

  const imgEntryId = repo.createEntry('media_vault', {
    work_title: '图片引用追踪测试',
    media_type: '电影',
    cover_image: 'images/img_01TESTREFACTIVE.jpg',
  });
  assert.ok(
    repo.collectReferencedImagePaths().has('images/img_01TESTREFACTIVE.jpg'),
    'Active entry image path must be detected as referenced'
  );
  repo.deleteEntry(imgEntryId);
  assert.ok(
    repo.collectReferencedImagePaths().has('images/img_01TESTREFACTIVE.jpg'),
    'Image path inside undoable snapshot must remain protected from orphan GC'
  );
  console.log('   ✓ Single-tx upsertLibrary, getEntryTitleMap, window query & image ref tracking verified');

  console.log('\nALL CORE ENGINE TESTS PASSED!');
}

runTests();
