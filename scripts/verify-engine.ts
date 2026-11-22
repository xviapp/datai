import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LATEST_SCHEMA_VERSION, MAX_AI_SNAPSHOTS } from '../src/db/migrations';
import { OmniRepository } from '../src/db/repository';
import {
  sanitizeReadOnlySql,
  sqlReferencesLibraryView,
  type SqlParam,
  type SyncSqlDriver,
} from '../src/db/types';
import { formatLocalDate, formatLocalDateOffset } from '../src/engine/date';
import {
  getAnalystJsonSchema,
  getArchitectJsonSchema,
  getOmniCaptureJsonSchema,
  type ArchitectPlan,
} from '../src/schema/view-dsl';

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
  assert.equal(libs.length, 5, 'Should seed 5 default personal libraries');

  // Verify reverse rollup + formula on Sony A7C2 asset
  const assets = repo.listHydratedEntries('my_assets');
  const sony = assets.find((e) => e.titleSummary.includes('Sony A7C2'));
  if (!sony) throw new Error('Sony A7C2 should exist');
  assert.equal(sony.computedData.extra_spend, 5220, 'Reverse rollup extra_spend should sum linked bills (4580 + 640)');
  assert.equal(sony.backlinks.length, 2, 'Sony A7C2 should have 2 backlinked bill entries');
  assert.ok(Number(sony.computedData.daily_cost) > 0, 'Daily holding cost formula should evaluate > 0');
  console.log(
    `   ✓ Sony A7C2 extra_spend=${sony.computedData.extra_spend}, daily_cost=${sony.computedData.daily_cost}/day, backlinks=${sony.backlinks.length}`
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
  assert.equal(repo.listLibraries().length, 6, 'workout_logs should be added');
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
  assert.equal(repo.listLibraries().length, 5, 'Undo should restore library count back to 5');
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

  console.log('\nALL CORE ENGINE TESTS PASSED!');
}

runTests();
