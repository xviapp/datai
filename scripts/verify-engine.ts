import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { OmniRepository } from '../src/db/repository';
import { sanitizeReadOnlySql, type SqlParam, type SyncSqlDriver } from '../src/db/types';
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

  console.log('2. Testing OmniRepository seeding, logical SQL views, Rollups & Formulas...');
  const repo = new OmniRepository(createNodeSqliteDriver());
  repo.seedIfEmpty();

  const libs = repo.listLibraries();
  assert.equal(libs.length, 5, 'Should seed 5 default personal libraries');

  // Verify reverse rollup + formula on Sony A7C2 asset
  const assets = repo.listHydratedEntries('my_assets');
  const sony = assets.find((e) => e.titleSummary.includes('Sony A7C2'));
  if (!sony) throw new Error('Sony A7C2 should exist');
  // Linked bills: 4580 + 640 = 5220
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
  console.log('   ✓ All 4 pre-built SQLite view widgets executed & SQL injection blocked');

  console.log('4. Testing Omni-Capture cross-library atomic @prev:0 draft commit...');
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
        reason: '同步记录购买プロ手柄配件账单并关联 Switch 2',
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
  console.log('   ✓ Cross-library @prev:0 linking verified');

  console.log('5. Testing Architect Plan application & 1-click Snapshot Undo...');
  const plan: ArchitectPlan = {
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

  const snapId = repo.applyArchitectPlan(plan);
  assert.equal(repo.listLibraries().length, 6, 'workout_logs should be added');
  const wEntryId = repo.createEntry('workout_logs', { movement: '深蹲', weight_kg: 100, reps: 8 });
  assert.equal(repo.getHydratedEntryById(wEntryId)?.entry.computedData.volume, 800);

  // Undo!
  repo.undoSnapshot(snapId);
  assert.equal(repo.listLibraries().length, 5, 'Undo should restore library count back to 5');
  assert.equal(repo.getLibraryBySlug('workout_logs'), null, 'workout_logs should be removed after undo');
  console.log('   ✓ Architect Plan + Snapshot 1-click Undo verified');

  console.log('\nALL CORE ENGINE TESTS PASSED!');
}

runTests();
