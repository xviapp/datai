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
  collectReferencedExistingEntryIds,
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

  it('normalizes leading-whitespace " @prev:0" before assigning stable IDs and matches comma-separated multi-select in preview & commit', () => {
    const { repo } = createSeededRepo();
    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));
    const booksCountBefore = repo.listHydratedEntries('books').length;

    // 1. 带前导空格的 " @prev:0" 必须在初始化阶段转换为稳定 draftId，删除书 A 后不可错绑书 B
    const spaced = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'books',
          reason: '书 A',
          data: { book_title: '空格测试书 A', author: '作者 A', status: '在读' },
        },
        {
          librarySlug: 'books',
          reason: '书 B',
          data: { book_title: '空格测试书 B', author: '作者 B', status: '想读' },
        },
        {
          librarySlug: 'reading_logs',
          reason: '引用书 A（带前导空格）',
          data: { book: [' @prev:0'], read_date: '2026-11-26', note: '第一天' },
        },
      ],
      libMap
    );
    assert.deepEqual(spaced[2].data.book, [makeDraftRefToken(spaced[0].draftId)]);

    const { nextDrafts } = removeCaptureDraftById(spaced, spaced[0].draftId, libMap);
    const issues = findDanglingDraftRelations(nextDrafts, libMap);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].reasons, ['missing_draft']);
    assert.throws(() => repo.commitOmniDrafts(nextDrafts), /已被删除|重新选择/);
    assert.equal(repo.listHydratedEntries('books').length, booksCountBefore);

    // 2. 逗号分隔的多选关联 ID：预览校验与入库提交共用拆分规则
    const meds = repo.listHydratedEntries('med_cabinet');
    assert.ok(meds.length >= 2);
    const commaDrafts = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'health_logs',
          reason: '同时服用两种药',
          data: {
            log_title: '联合用药测试',
            log_date: '2026-11-26',
            medicines: `${meds[0].id}, ${meds[1].id}`,
          },
        },
      ],
      libMap
    );
    const refIds = collectReferencedExistingEntryIds(commaDrafts, libMap);
    assert.deepEqual(refIds, [meds[0].id, meds[1].id]);
    const summaryMap = repo.getEntrySummaryMap(refIds);
    const existingLibById = new Map<string, string>();
    for (const [id, info] of summaryMap.entries()) {
      existingLibById.set(id, info.librarySlug);
    }
    assert.equal(
      findDanglingDraftRelations(commaDrafts, libMap, { existingEntryLibraryById: existingLibById })
        .length,
      0
    );
    const [healthLogId] = repo.commitOmniDrafts(commaDrafts);
    const savedHealthLog = repo.getHydratedEntryById(healthLogId);
    assert.equal(savedHealthLog?.entry.forwardLinks.medicines?.length, 2);
  });

  it('rejects multiple targets on single-select relation fields in both preview and repository writes', () => {
    const { repo } = createSeededRepo();
    const libMap = new Map(repo.listLibraries().map((l) => [l.slug, l]));
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const logsBefore = repo.listHydratedEntries('reading_logs').length;

    const twoBookDrafts = normalizeCaptureDrafts(
      [
        {
          librarySlug: 'reading_logs',
          reason: '误填两本书',
          data: {
            book: [books[0].id, books[1].id],
            read_date: '2026-11-26',
            note: '测试单选校验',
          },
        },
      ],
      libMap
    );
    const previewIssues = findDanglingDraftRelations(twoBookDrafts, libMap);
    assert.equal(previewIssues.length, 1);
    assert.ok(previewIssues[0].reasons.includes('too_many_targets'));

    assert.throws(() => repo.commitOmniDrafts(twoBookDrafts), /仅支持关联 1 条记录/);
    assert.throws(
      () =>
        repo.createEntry('reading_logs', {
          book: [books[0].id, books[1].id],
          read_date: '2026-11-26',
        }),
      /仅支持关联 1 条记录/
    );
    assert.equal(repo.listHydratedEntries('reading_logs').length, logsBefore);
  });

  it('detaches surviving references on deleteLibrary and entries_created undo so surviving entries stay editable', () => {
    const { repo } = createSeededRepo();

    // 1. 删除「阅读书架」后，存活的「阅读记录」仍可正常编辑保存，且撤销删库可恢复关联并保留新编辑内容
    const origLog = repo
      .listHydratedEntries('reading_logs')
      .find((e) => (e.forwardLinks.book?.length ?? 0) > 0);
    assert.ok(origLog);
    const origBookId = origLog.forwardLinks.book[0].id;

    repo.deleteLibrary('books');
    const afterDeleteLog = repo.getHydratedEntryById(origLog.id);
    assert.ok(afterDeleteLog);
    assert.deepEqual(afterDeleteLog.entry.rawData.book, []);

    repo.updateEntry(origLog.id, {
      ...afterDeleteLog.entry.rawData,
      note: '删库后成功修改的书摘',
    });
    assert.equal(
      repo.getHydratedEntryById(origLog.id)?.entry.rawData.note,
      '删库后成功修改的书摘'
    );

    const deleteLibSnap = repo
      .listSnapshots()
      .find((s) => !s.undone && s.actionSummary.includes('阅读书架'));
    assert.ok(deleteLibSnap);
    repo.undoSnapshot(deleteLibSnap.id);

    const afterUndoDeleteLog = repo.getHydratedEntryById(origLog.id);
    assert.equal(afterUndoDeleteLog?.entry.rawData.note, '删库后成功修改的书摘');
    assert.equal(afterUndoDeleteLog?.entry.forwardLinks.book?.[0]?.id, origBookId);

    // 2. 撤销快记创建的书籍后，后来关联它的阅读记录引用被同步解绑且可继续编辑
    const [createdBookId] = repo.commitOmniDrafts(
      [
        {
          librarySlug: 'books',
          reason: '快记新建书',
          data: { book_title: '将被撤销的书', author: '作者', status: '在读' },
        },
      ],
      '快记：新建待撤销书'
    );
    const linkedLogId = repo.createEntry('reading_logs', {
      book: [createdBookId],
      read_date: '2026-11-26',
      note: '关联到快记新书',
    });
    const captureSnap = repo
      .listSnapshots()
      .find((s) => !s.undone && s.actionSummary.includes('待撤销书'));
    assert.ok(captureSnap);
    repo.undoSnapshot(captureSnap.id);

    const detachedLog = repo.getHydratedEntryById(linkedLogId);
    assert.ok(detachedLog);
    assert.deepEqual(detachedLog.entry.rawData.book, []);
    repo.updateEntry(linkedLogId, {
      ...detachedLog.entry.rawData,
      note: '撤销快记后仍可顺利编辑',
    });
    assert.equal(
      repo.getHydratedEntryById(linkedLogId)?.entry.rawData.note,
      '撤销快记后仍可顺利编辑'
    );
  });

  it('preserves original book links when undoing an Architect plan that retargeted to an empty new library', () => {
    const { repo } = createSeededRepo();
    const origLog = repo
      .listHydratedEntries('reading_logs')
      .find((e) => (e.forwardLinks.book?.length ?? 0) > 0);
    assert.ok(origLog);
    const origBookId = origLog.forwardLinks.book[0].id;
    const origLogsLib = repo.getLibraryBySlug('reading_logs');
    assert.ok(origLogsLib);

    const planSnapId = repo.applyArchitectPlan({
      summary: '新建空书架 v2 并把阅读记录改指新库',
      libraries: [
        {
          slug: 'books_v2',
          name: '新书架',
          description: '',
          icon: '📘',
          color: 'blue',
          fields: [{ key: 'title', label: '书名', type: 'text', required: true }],
          views: {
            card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
          },
        },
        {
          slug: 'reading_logs',
          name: origLogsLib.name,
          description: origLogsLib.description,
          icon: origLogsLib.icon,
          color: origLogsLib.color,
          parentLibrarySlug: 'books_v2',
          showOnHome: false,
          fields: origLogsLib.fields.map((f) =>
            f.key === 'book'
              ? { ...f, relationConfig: { targetLibrarySlug: 'books_v2', allowMultiple: false } }
              : f
          ),
          views: origLogsLib.views,
        },
      ],
      dashboardWidgets: [],
    });

    repo.undoSnapshot(planSnapId);

    const restoredLog = repo.getHydratedEntryById(origLog.id);
    assert.ok(restoredLog);
    assert.deepEqual(
      restoredLog.entry.rawData.book,
      [origBookId],
      'Undoing empty books_v2 plan must NOT wipe original books IDs in reading_logs'
    );
    repo.updateEntry(origLog.id, { ...restoredLog.entry.rawData, note: '撤销建库后更新书摘' });
    assert.equal(repo.getHydratedEntryById(origLog.id)?.entry.forwardLinks.book?.[0]?.id, origBookId);
  });

  it('restores only removed relation IDs on library delete undo without overwriting post-delete edits, and detaches unindexed IDs on capture undo', () => {
    const { repo } = createSeededRepo();
    const existingBook = repo.listHydratedEntries('books')[0];
    assert.ok(existingBook);

    // 1. 文本字段存目标书 ID 后转为关联字段（无 entry_relations 边），删库 -> 改标题 -> 撤销删库，标题不应被覆盖
    repo.upsertLibrary({
      slug: 'notes_converted',
      name: '转关联测试笔记',
      description: '',
      icon: '🗒️',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        { key: 'ref_book', label: '关联书籍', type: 'text', required: false },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });
    const noteId = repo.createEntry('notes_converted', {
      title: '旧标题',
      ref_book: existingBook.id,
    });
    repo.upsertLibrary({
      slug: 'notes_converted',
      name: '转关联测试笔记',
      description: '',
      icon: '🗒️',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'ref_book',
          label: '关联书籍',
          type: 'relation',
          required: false,
          relationConfig: { targetLibrarySlug: 'books', allowMultiple: false },
        },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });

    repo.deleteLibrary('books');
    const afterDelNote = repo.getHydratedEntryById(noteId);
    assert.ok(afterDelNote);
    assert.deepEqual(afterDelNote.entry.rawData.ref_book, []);
    repo.updateEntry(noteId, { ...afterDelNote.entry.rawData, title: '删库后新标题' });

    const delBooksSnap = repo
      .listSnapshots()
      .find((s) => !s.undone && s.actionSummary.includes('阅读书架'));
    assert.ok(delBooksSnap);
    repo.undoSnapshot(delBooksSnap.id);

    const afterUndoNote = repo.getHydratedEntryById(noteId);
    assert.equal(afterUndoNote?.entry.titleSummary, '删库后新标题');
    assert.equal(
      afterUndoNote?.entry.rawData.title,
      '删库后新标题',
      'Undo deleteLibrary must NOT overwrite post-delete title edit in data_json'
    );
    assert.deepEqual(afterUndoNote?.entry.rawData.ref_book, [existingBook.id]);

    // 2. 撤销快记新书时，也应清理文本转关联后未写入 entry_relations 的引用
    const [capBookId] = repo.commitOmniDrafts(
      [
        {
          librarySlug: 'books',
          reason: '快记书',
          data: { book_title: '未建边撤销测试书', author: '作者', status: '在读' },
        },
      ],
      '快记：未建边撤销测试书'
    );
    repo.upsertLibrary({
      slug: 'notes_unindexed',
      name: '未建边笔记',
      description: '',
      icon: '📌',
      color: 'amber',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        { key: 'ref_book', label: '关联书籍', type: 'text', required: false },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });
    const unindexedNoteId = repo.createEntry('notes_unindexed', {
      title: '初始标题',
      ref_book: capBookId,
    });
    repo.upsertLibrary({
      slug: 'notes_unindexed',
      name: '未建边笔记',
      description: '',
      icon: '📌',
      color: 'amber',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'ref_book',
          label: '关联书籍',
          type: 'relation',
          required: false,
          relationConfig: { targetLibrarySlug: 'books', allowMultiple: false },
        },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });
    const capSnap = repo
      .listSnapshots()
      .find((s) => !s.undone && s.actionSummary.includes('未建边撤销测试书'));
    assert.ok(capSnap);
    repo.undoSnapshot(capSnap.id);

    const afterCapUndo = repo.getHydratedEntryById(unindexedNoteId);
    assert.ok(afterCapUndo);
    assert.deepEqual(afterCapUndo.entry.rawData.ref_book, []);
    repo.updateEntry(unindexedNoteId, { ...afterCapUndo.entry.rawData, title: '改标题成功' });
    assert.equal(repo.getHydratedEntryById(unindexedNoteId)?.entry.rawData.title, '改标题成功');
  });

  it('blocks deleting a library referenced by a required relation field and rolls back deleteLibrary if detach UPDATE fails', () => {
    const { repo, driver } = createSeededRepo();
    const logsLib = repo.getLibraryBySlug('reading_logs');
    assert.ok(logsLib);

    // 1. 将 reading_logs.book 改为必填后，删除 books 必须被明确拦截
    repo.upsertLibrary({
      slug: logsLib.slug,
      name: logsLib.name,
      description: logsLib.description,
      icon: logsLib.icon,
      color: logsLib.color,
      parentLibrarySlug: logsLib.parentLibrarySlug ?? undefined,
      showOnHome: logsLib.showOnHome,
      fields: logsLib.fields.map((f) => (f.key === 'book' ? { ...f, required: true } : f)),
      views: logsLib.views,
    });
    assert.throws(() => repo.deleteLibrary('books'), /阅读记录.*所属书籍/);
    assert.ok(repo.getLibraryBySlug('books'), 'books must still exist when blocked by required relation');

    // 取消必填后，测试数据库在解绑 UPDATE 时报错必须回滚整个 deleteLibrary
    repo.upsertLibrary({
      slug: logsLib.slug,
      name: logsLib.name,
      description: logsLib.description,
      icon: logsLib.icon,
      color: logsLib.color,
      parentLibrarySlug: logsLib.parentLibrarySlug ?? undefined,
      showOnHome: logsLib.showOnHome,
      fields: logsLib.fields.map((f) => (f.key === 'book' ? { ...f, required: false } : f)),
      views: logsLib.views,
    });
    driver.execSync(`
      CREATE TRIGGER block_detach_update
      BEFORE UPDATE ON entries
      BEGIN
        SELECT RAISE(ABORT, 'simulated detach update failure');
      END;
    `);
    assert.throws(() => repo.deleteLibrary('books'), /simulated detach update failure/);
    assert.ok(
      repo.getLibraryBySlug('books'),
      'deleteLibrary must roll back when detach UPDATE fails instead of swallowing DB error'
    );
    driver.execSync('DROP TRIGGER block_detach_update;');
  });

  it('preserves multi_select array options containing English commas', () => {
    const { repo } = createSeededRepo();
    repo.upsertLibrary({
      slug: 'travel_log',
      name: '旅行记录',
      description: '',
      icon: '✈️',
      color: 'blue',
      fields: [
        { key: 'title', label: '行程', type: 'text', required: true },
        {
          key: 'cities',
          label: '城市',
          type: 'multi_select',
          required: false,
          options: [{ value: 'Washington, D.C.' }, { value: 'New York' }],
        },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });
    const entryId = repo.createEntry('travel_log', {
      title: '美东行',
      cities: ['Washington, D.C.', 'New York'],
    });
    const loaded = repo.getHydratedEntryById(entryId);
    assert.deepEqual(loaded?.entry.rawData.cities, ['Washington, D.C.', 'New York']);
  });

  it('respects later single-select rebinding and field-type changes on undo, and preserves multi-select order & index consistency', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const [bookA, bookB] = books;

    // 1. 单选改绑保护：删书 A -> 将阅读记录改绑到书 B -> 撤销删书 A -> 必须保持 [bookB] 且可继续编辑
    const logId = repo.createEntry('reading_logs', {
      book: [bookA.id],
      read_date: '2026-11-26',
      note: '原书摘',
    });
    const delBookASnap = repo.deleteEntry(bookA.id);
    assert.ok(delBookASnap);
    repo.updateEntry(logId, {
      book: [bookB.id],
      read_date: '2026-11-26',
      note: '改绑书 B',
    });
    repo.undoSnapshot(delBookASnap);

    const afterUndoLog = repo.getHydratedEntryById(logId);
    assert.deepEqual(afterUndoLog?.entry.rawData.book, [bookB.id]);
    assert.deepEqual(
      afterUndoLog?.entry.forwardLinks.book?.map((x) => x.id),
      [bookB.id]
    );
    repo.updateEntry(logId, {
      ...(afterUndoLog?.entry.rawData ?? {}),
      note: '撤销后继续改书摘',
    });
    assert.equal(repo.getHydratedEntryById(logId)?.entry.rawData.note, '撤销后继续改书摘');

    // 2. 字段改为 text 后撤销删除，不得把用户文本改写成数组
    const delBookBSnap = repo.deleteEntry(bookB.id);
    assert.ok(delBookBSnap);
    const logsLib = repo.getLibraryBySlug('reading_logs');
    assert.ok(logsLib);
    repo.upsertLibrary({
      slug: logsLib.slug,
      name: logsLib.name,
      description: logsLib.description,
      icon: logsLib.icon,
      color: logsLib.color,
      parentLibrarySlug: logsLib.parentLibrarySlug ?? undefined,
      showOnHome: logsLib.showOnHome,
      fields: logsLib.fields.map((f) =>
        f.key === 'book' ? { key: 'book', label: '所属书籍', type: 'text', required: false } : f
      ),
      views: logsLib.views,
    });
    repo.updateEntry(logId, {
      book: '手写书名文本',
      read_date: '2026-11-26',
      note: '已转文本',
    });
    repo.undoSnapshot(delBookBSnap);
    assert.equal(repo.getHydratedEntryById(logId)?.entry.rawData.book, '手写书名文本');

    // 3. 多选顺序与关联表严格一致：[medA, medB] 删 medA 后立即撤销，data_json 与 forwardLinks 均为 [medA, medB]
    const meds = repo.listHydratedEntries('med_cabinet');
    assert.ok(meds.length >= 2);
    const [medA, medB] = meds;
    const healthId = repo.createEntry('health_logs', {
      log_title: '双药顺序测试',
      log_date: '2026-11-26',
      medicines: [medA.id, medB.id],
    });
    const delMedASnap = repo.deleteEntry(medA.id);
    assert.ok(delMedASnap);
    repo.undoSnapshot(delMedASnap);

    const restoredHealth = repo.getHydratedEntryById(healthId);
    assert.deepEqual(restoredHealth?.entry.rawData.medicines, [medA.id, medB.id]);
    assert.deepEqual(
      restoredHealth?.entry.forwardLinks.medicines?.map((x) => x.id),
      [medA.id, medB.id]
    );
  });

  it('safely restores legacy snapshots (without removedByField) without overwriting post-delete title edits and rebuilds relation index', () => {
    const { repo, driver } = createSeededRepo();
    const book = repo.listHydratedEntries('books')[0];
    assert.ok(book);

    repo.upsertLibrary({
      slug: 'legacy_notes',
      name: '旧快照兼容笔记',
      description: '',
      icon: '📜',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'ref_book',
          label: '关联书',
          type: 'relation',
          required: false,
          relationConfig: { targetLibrarySlug: 'books', allowMultiple: false },
        },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });
    const noteId = repo.createEntry('legacy_notes', { title: '旧标题', ref_book: [book.id] });
    // 模拟 9080eb3 文本转关联后尚无 entry_relations 边的状态
    driver.runSync('DELETE FROM entry_relations WHERE source_entry_id = ?', [noteId]);

    repo.deleteLibrary('books');
    // 将快照改写为旧格式（去掉 detachedSources[].removedByField）
    const snapRow = driver.getFirstSync<{ id: string; snapshot_json: string }>(
      "SELECT id, snapshot_json FROM ai_snapshots WHERE action_summary LIKE '%阅读书架%' ORDER BY created_at DESC LIMIT 1"
    );
    assert.ok(snapRow);
    const parsedSnap = JSON.parse(snapRow.snapshot_json) as {
      detachedSources?: Array<{ id: string; prevDataJson: string; removedByField?: unknown }>;
    };
    if (parsedSnap.detachedSources) {
      for (const s of parsedSnap.detachedSources) {
        delete s.removedByField;
      }
    }
    driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(parsedSnap),
      snapRow.id,
    ]);

    const afterDel = repo.getHydratedEntryById(noteId);
    assert.ok(afterDel);
    repo.updateEntry(noteId, { ...afterDel.entry.rawData, title: '删库后新标题' });

    repo.undoSnapshot(snapRow.id);

    const restored = repo.getHydratedEntryById(noteId);
    assert.equal(restored?.entry.titleSummary, '删库后新标题');
    assert.equal(restored?.entry.rawData.title, '删库后新标题');
    assert.deepEqual(restored?.entry.rawData.ref_book, [book.id]);
    assert.deepEqual(
      restored?.entry.forwardLinks.ref_book?.map((x) => x.id),
      [book.id],
      'Restored relation must also be indexed in entry_relations'
    );
  });

  it('blocks undoing an Architect plan if a surviving library still has a required relation to a created library', () => {
    const { repo } = createSeededRepo();
    const planSnapId = repo.applyArchitectPlan({
      summary: '新建项目库',
      libraries: [
        {
          slug: 'projects',
          name: '项目',
          description: '',
          icon: '🗂️',
          color: 'blue',
          fields: [{ key: 'title', label: '项目名', type: 'text', required: true }],
          views: {
            card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
          },
        },
      ],
      dashboardWidgets: [],
    });

    // 随后单独创建「任务」并必填关联到「项目」
    repo.upsertLibrary({
      slug: 'tasks',
      name: '任务',
      description: '',
      icon: '✅',
      color: 'emerald',
      fields: [
        { key: 'title', label: '任务名', type: 'text', required: true },
        {
          key: 'project',
          label: '所属项目',
          type: 'relation',
          required: true,
          relationConfig: { targetLibrarySlug: 'projects', allowMultiple: false },
        },
      ],
      views: {
        card: { titleFieldKey: 'title', footerMetricKeys: [], sortDir: 'desc', highlightRules: [] },
      },
    });

    assert.throws(() => repo.undoSnapshot(planSnapId), /任务.*所属项目/);
    assert.ok(repo.getLibraryBySlug('projects'), 'projects must not be deleted while tasks requires it');
  });

  it('cleans historical dangling references when manually deleting an empty library and avoids scanning unrelated libraries on single entry delete', () => {
    const { repo, driver, queries, clearQueries } = createSeededRepo();

    // 1. 删除空库时清理历史失效引用：即使旧数据 data_json 中残留已删除书的 ID，手动删空书架也能清理并保持笔记可编辑
    const books = repo.listHydratedEntries('books');
    const logId = repo.createEntry('reading_logs', {
      book: [books[0].id],
      read_date: '2026-11-26',
      note: '待测笔记',
    });
    const delLogSnap = repo.deleteEntry(logId);
    assert.ok(delLogSnap);
    for (const b of books) {
      repo.deleteEntry(b.id);
    }
    assert.equal(repo.listHydratedEntries('books').length, 0);
    repo.undoSnapshot(delLogSnap);
    // 新版恢复时已自动剥离已删书 ID 以便立刻编辑；再额外模拟旧版本升级遗留的失效 ID 验证手动删空库兜底清理
    assert.deepEqual(repo.getHydratedEntryById(logId)?.entry.rawData.book, []);
    const liveData = repo.getHydratedEntryById(logId)!.entry.rawData;
    driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
      JSON.stringify({ ...liveData, book: [books[0].id] }),
      logId,
    ]);

    repo.deleteLibrary('books');
    const afterDelEmptyBooks = repo.getHydratedEntryById(logId);
    assert.ok(afterDelEmptyBooks);
    assert.deepEqual(afterDelEmptyBooks.entry.rawData.book, []);
    repo.updateEntry(logId, { ...afterDelEmptyBooks.entry.rawData, note: '删空库后修改成功' });
    assert.equal(repo.getHydratedEntryById(logId)?.entry.rawData.note, '删空库后修改成功');

    // 2. 删除单条资产记录时，不得读取无关库（如 reading_logs）的 entries
    const logsLibId = repo.getLibraryBySlug('reading_logs')?.id;
    assert.ok(logsLibId);
    const assetId = repo.listHydratedEntries('my_assets')[0].id;
    // 记录 SQL 参数需要靠检查全表扫描语句：验证 deleteEntry 不执行无条件 SELECT id, data_json FROM entries WHERE library_id = ?
    clearQueries();
    repo.deleteEntry(assetId);
    assert.equal(
      queries.some((q) => q.trim() === 'SELECT id, data_json FROM entries WHERE library_id = ?'),
      false,
      'Deleting a single entry must not full-scan unrelated libraries'
    );
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

  it('does not resurrect deleted fields in effective gallery or calendar views', () => {
    const { repo } = createSeededRepo();

    // 1. 删除 reading_logs 的 duration_min 后，日历有效配置不再指向 duration_min
    const readingLogs = repo.getLibraryBySlug('reading_logs');
    assert.ok(readingLogs);
    assert.equal(readingLogs.views.calendar?.metricFieldKey, 'duration_min');
    const logDraft = buildInitialSchemaDraft(repo.listLibraries(), readingLogs);
    logDraft.fields = logDraft.fields.filter((f) => f.key !== 'duration_min');
    const logPayload = buildSchemaSavePayload(logDraft, readingLogs);
    repo.upsertLibrary(logPayload.blueprint, logPayload.viewInputs);

    const savedLogs = repo.getLibraryBySlug('reading_logs');
    assert.ok(savedLogs);
    assert.equal(savedLogs.views.calendar?.metricFieldKey, undefined);
    assert.equal(
      savedLogs.viewList.find((v) => v.viewType === 'calendar')?.config.metricFieldKey,
      undefined
    );

    // 2. 替换 books 的 cover_image 字段后，画廊有效配置不再指向旧的 cover_image
    const books = repo.getLibraryBySlug('books');
    assert.ok(books);
    assert.equal(books.views.gallery?.coverImageFieldKey, 'cover_image');
    const bookDraft = buildInitialSchemaDraft(repo.listLibraries(), books);
    bookDraft.fields = [
      ...bookDraft.fields.filter((f) => f.key !== 'cover_image'),
      { key: 'book_cover_v2', label: '新封面', type: 'image', required: false },
    ];
    const bookPayload = buildSchemaSavePayload(bookDraft, books);
    repo.upsertLibrary(bookPayload.blueprint, bookPayload.viewInputs);

    const savedBooks = repo.getLibraryBySlug('books');
    assert.ok(savedBooks);
    assert.equal(savedBooks.views.gallery?.coverImageFieldKey, undefined);
    assert.equal(
      savedBooks.viewList.find((v) => v.viewType === 'gallery')?.config.coverImageFieldKey,
      undefined
    );
  });

  it('saves library rename cleanly after adding a minimal card view and deleting the original primary card view', () => {
    const { repo } = createSeededRepo();
    const medBefore = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medBefore);
    const origPrimaryCard = medBefore.viewList.find((v) => v.viewType === 'card');
    assert.ok(origPrimaryCard);

    // 添加仅含标题和底部指标的极简卡片，再删掉原主卡片
    repo.addLibraryView('med_cabinet', 'card', '极简卡片', {
      titleFieldKey: 'med_name',
      footerMetricKeys: ['stock_count'],
    });
    repo.deleteLibraryView(origPrimaryCard.id);

    const medAfterDel = repo.getLibraryBySlug('med_cabinet');
    assert.ok(medAfterDel);
    assert.ok(Array.isArray(medAfterDel.views.card.highlightRules));

    const draft = buildInitialSchemaDraft(repo.listLibraries(), medAfterDel);
    draft.name = '家庭药箱（删主卡片后改名）';
    const payload = buildSchemaSavePayload(draft, medAfterDel);
    repo.upsertLibrary(payload.blueprint, payload.viewInputs);

    const saved = repo.getLibraryBySlug('med_cabinet');
    assert.ok(saved);
    assert.equal(saved.name, '家庭药箱（删主卡片后改名）');
    assert.ok(Array.isArray(saved.views.card.highlightRules));
  });

  it('preserves inherited calendar metric and gallery cover/subtitle when view row has partial overrides and user only renames library', () => {
    const { repo, driver } = createSeededRepo();

    // 1. 阅读记录日历行仅显式配置 dateFieldKey，其余（metricFieldKey: duration_min）从库 views_json.calendar 继承
    const readingLogs = repo.getLibraryBySlug('reading_logs');
    assert.ok(readingLogs);
    const calView = readingLogs.viewList.find((v) => v.viewType === 'calendar');
    assert.ok(calView);
    driver.runSync('UPDATE library_views SET config_json = ? WHERE id = ?', [
      JSON.stringify({ dateFieldKey: 'read_date' }),
      calView.id,
    ]);
    const reloadedRepo1 = new OmniRepository(driver);
    const partialLogLib = reloadedRepo1.getLibraryBySlug('reading_logs');
    assert.ok(partialLogLib);
    assert.equal(partialLogLib.views.calendar?.metricFieldKey, 'duration_min');
    assert.deepEqual(
      partialLogLib.viewList.find((v) => v.id === calView.id)?.config,
      { dateFieldKey: 'read_date' }
    );

    const logDraft = buildInitialSchemaDraft(reloadedRepo1.listLibraries(), partialLogLib);
    logDraft.name = '阅读记录（已改名）';
    const logPayload = buildSchemaSavePayload(logDraft, partialLogLib);
    reloadedRepo1.upsertLibrary(logPayload.blueprint, logPayload.viewInputs);

    const savedLogs = reloadedRepo1.getLibraryBySlug('reading_logs');
    assert.ok(savedLogs);
    assert.equal(savedLogs.name, '阅读记录（已改名）');
    assert.equal(
      savedLogs.views.calendar?.metricFieldKey,
      'duration_min',
      'Renaming library must preserve inherited calendar metricFieldKey'
    );

    // 2. 书架画廊行仅显式配置 titleFieldKey，封面和副标题从库 views_json.gallery 继承
    const books = reloadedRepo1.getLibraryBySlug('books');
    assert.ok(books);
    const galView = books.viewList.find((v) => v.viewType === 'gallery');
    assert.ok(galView);
    driver.runSync('UPDATE library_views SET config_json = ? WHERE id = ?', [
      JSON.stringify({ titleFieldKey: 'book_title' }),
      galView.id,
    ]);
    const reloadedRepo2 = new OmniRepository(driver);
    const partialBooksLib = reloadedRepo2.getLibraryBySlug('books');
    assert.ok(partialBooksLib);
    assert.equal(partialBooksLib.views.gallery?.coverImageFieldKey, 'cover_image');
    assert.equal(partialBooksLib.views.gallery?.subtitleFieldKey, 'author');

    const booksDraft = buildInitialSchemaDraft(reloadedRepo2.listLibraries(), partialBooksLib);
    booksDraft.name = '我的书架';
    const booksPayload = buildSchemaSavePayload(booksDraft, partialBooksLib);
    reloadedRepo2.upsertLibrary(booksPayload.blueprint, booksPayload.viewInputs);

    const savedBooks = reloadedRepo2.getLibraryBySlug('books');
    assert.ok(savedBooks);
    assert.equal(savedBooks.name, '我的书架');
    assert.equal(savedBooks.views.gallery?.coverImageFieldKey, 'cover_image');
    assert.equal(savedBooks.views.gallery?.subtitleFieldKey, 'author');
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

describe('5. Round-6 review fixes: snapshot identity, backup reconciliation, restore & schema evolution', () => {
  it('verifies library identity by ID when undoing an old Architect plan so a recreated same-slug library survives', () => {
    const { repo } = createSeededRepo();
    const oldPlanSnapId = repo.applyArchitectPlan({
      summary: '创建 custom_8',
      libraries: [
        {
          slug: 'custom_8',
          name: '旧自定义库',
          description: '',
          icon: '📦',
          color: 'teal',
          fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
          views: {
            card: {
              titleFieldKey: 'title',
              footerMetricKeys: [],
              sortDir: 'desc',
              highlightRules: [],
            },
          },
        },
      ],
      dashboardWidgets: [],
    });

    const oldLib = repo.getLibraryBySlug('custom_8');
    assert.ok(oldLib);
    repo.deleteLibrary('custom_8');
    assert.equal(repo.getLibraryBySlug('custom_8'), null);

    // 之后以相同 slug 重新创建新库并写入一条记录
    const newLibId = repo.upsertLibrary({
      slug: 'custom_8',
      name: '新自定义库',
      description: '',
      icon: '✨',
      color: 'blue',
      fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    assert.notEqual(newLibId, oldLib.id);
    const keptEntryId = repo.createEntry('custom_8', { title: '新库珍贵记录' });

    // 预览影响也不应把后来新建的库算作受影响记录
    const impact = repo.describeSnapshotUndoImpact(oldPlanSnapId);
    assert.equal(impact.affectedEntriesCount, 0);

    // 撤销旧建库方案，新库与记录都应完好保留
    repo.undoSnapshot(oldPlanSnapId);
    const survivingLib = repo.getLibraryBySlug('custom_8');
    assert.ok(survivingLib);
    assert.equal(survivingLib.id, newLibId);
    assert.equal(survivingLib.name, '新自定义库');
    const survivingEntry = repo.getHydratedEntryById(keptEntryId);
    assert.equal(survivingEntry?.entry.rawData.title, '新库珍贵记录');
  });

  it('reconciles valid entry_relations from legacy backups whose data_json relation array was emptied', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    const logs = repo.listHydratedEntries('reading_logs');
    assert.ok(books.length > 0 && logs.length > 0);
    const targetLog = logs[0];
    const expectedBookIds = targetLog.forwardLinks.book?.map((r) => r.id) ?? [];
    assert.ok(expectedBookIds.length > 0);

    // 构造类似 9080eb3 导出的真实备份：entry_relations 保留有效关联，但 entries.data_json.book 为空数组
    const legacyBundle = repo.exportBackupBundle();
    legacyBundle.entries = legacyBundle.entries.map((entryRow) => {
      if (String(entryRow.id) !== targetLog.id) return entryRow;
      const parsed = JSON.parse(String(entryRow.data_json)) as Record<string, unknown>;
      parsed.book = [];
      return { ...entryRow, data_json: JSON.stringify(parsed) };
    });

    // 在全新数据库中导入该旧版备份
    const freshCtx = createInstrumentedSqliteDriver();
    const freshRepo = new OmniRepository(freshCtx.driver);
    freshRepo.importBackupBundle(legacyBundle);

    const hydrated = freshRepo.getHydratedEntryById(targetLog.id);
    assert.ok(hydrated);
    assert.deepEqual(hydrated.entry.rawData.book, expectedBookIds);
    assert.deepEqual(
      hydrated.entry.forwardLinks.book?.map((r) => r.id),
      expectedBookIds
    );

    // 再次导出备份时，entries 与 relations 都应保持该有效关联
    const reExported = freshRepo.exportBackupBundle();
    assert.ok(
      reExported.relations.some(
        (r) =>
          String(r.source_entry_id) === targetLog.id &&
          String(r.target_entry_id) === expectedBookIds[0] &&
          String(r.field_key) === 'book'
      ),
      'Re-exported backup must preserve reconciled valid relations'
    );
  });

  it('sanitizes restored entry relations against current schema and reindexes surviving references to newly restored targets', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const bookA = books[0];
    const bookB = books[1];

    // 场景 A：删笔记 -> 把关联目标从 books 改为 my_assets -> 恢复笔记
    const noteAId = repo.createEntry('reading_logs', {
      book: [bookA.id],
      read_date: '2026-11-26',
      note: '场景A笔记',
    });
    const delNoteASnap = repo.deleteEntry(noteAId);
    assert.ok(delNoteASnap);

    const logsLib = repo.getLibraryBySlug('reading_logs')!;
    repo.upsertLibrary({
      slug: logsLib.slug,
      name: logsLib.name,
      description: logsLib.description,
      icon: logsLib.icon,
      color: logsLib.color,
      parentLibrarySlug: logsLib.parentLibrarySlug ?? undefined,
      showOnHome: logsLib.showOnHome,
      fields: logsLib.fields.map((f) =>
        f.key === 'book'
          ? {
              ...f,
              relationConfig: { targetLibrarySlug: 'my_assets', allowMultiple: false },
            }
          : f
      ),
      views: logsLib.views,
    });

    repo.undoSnapshot(delNoteASnap);
    const restoredNoteA = repo.getHydratedEntryById(noteAId);
    assert.ok(restoredNoteA);
    assert.deepEqual(restoredNoteA.entry.rawData.book, []);
    assert.equal(restoredNoteA.entry.forwardLinks.book?.length ?? 0, 0);
    // 修改笔记正文必须能够正常保存，不再报目标库不匹配
    repo.updateEntry(noteAId, { ...restoredNoteA.entry.rawData, note: '场景A改后笔记' });
    assert.equal(repo.getHydratedEntryById(noteAId)?.entry.rawData.note, '场景A改后笔记');

    // 切回 books 准备场景 B
    const logsLibAfterA = repo.getLibraryBySlug('reading_logs')!;
    repo.upsertLibrary({
      slug: logsLibAfterA.slug,
      name: logsLibAfterA.name,
      description: logsLibAfterA.description,
      icon: logsLibAfterA.icon,
      color: logsLibAfterA.color,
      parentLibrarySlug: logsLibAfterA.parentLibrarySlug ?? undefined,
      showOnHome: logsLibAfterA.showOnHome,
      fields: logsLibAfterA.fields.map((f) =>
        f.key === 'book'
          ? {
              ...f,
              relationConfig: { targetLibrarySlug: 'books', allowMultiple: false },
            }
          : f
      ),
      views: logsLibAfterA.views,
    });

    // 场景 B：先删笔记、再删书，然后按相同顺序先恢复笔记、再恢复书
    const noteBId = repo.createEntry('reading_logs', {
      book: [bookB.id],
      read_date: '2026-11-26',
      note: '场景B笔记',
    });
    const delNoteBSnap = repo.deleteEntry(noteBId);
    const delBookBSnap = repo.deleteEntry(bookB.id);
    assert.ok(delNoteBSnap && delBookBSnap);

    repo.undoSnapshot(delNoteBSnap);
    repo.undoSnapshot(delBookBSnap);

    const restoredNoteB = repo.getHydratedEntryById(noteBId);
    const restoredBookB = repo.getHydratedEntryById(bookB.id);
    assert.ok(restoredNoteB && restoredBookB);
    assert.deepEqual(restoredNoteB.entry.rawData.book, [bookB.id]);
    assert.deepEqual(
      restoredNoteB.entry.forwardLinks.book?.map((r) => r.id),
      [bookB.id]
    );
    assert.ok(
      restoredBookB.entry.backlinks.some((r) => r.id === noteBId),
      'Restored book must show backlink from already-restored note'
    );
  });

  it('normalizes existing multi-value relation data when switching a relation field from multi-select to single-select', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);

    repo.upsertLibrary({
      slug: 'multi_to_single_notes',
      name: '读书清单笔记',
      description: '',
      icon: '🗒️',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '关联书籍',
          type: 'relation',
          required: false,
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

    const noteId = repo.createEntry('multi_to_single_notes', {
      title: '双书笔记',
      books_ref: [books[0].id, books[1].id],
    });
    assert.equal(repo.getHydratedEntryById(noteId)?.entry.forwardLinks.books_ref?.length, 2);

    // 将关联字段从多选改为单选
    const lib = repo.getLibraryBySlug('multi_to_single_notes')!;
    repo.upsertLibrary({
      slug: lib.slug,
      name: lib.name,
      description: lib.description,
      icon: lib.icon,
      color: lib.color,
      fields: lib.fields.map((f) =>
        f.key === 'books_ref'
          ? { ...f, relationConfig: { targetLibrarySlug: 'books', allowMultiple: false } }
          : f
      ),
      views: lib.views,
    });

    const afterSwitch = repo.getHydratedEntryById(noteId);
    assert.ok(afterSwitch);
    assert.deepEqual(afterSwitch.entry.rawData.books_ref, [books[0].id]);
    assert.deepEqual(
      afterSwitch.entry.forwardLinks.books_ref?.map((r) => r.id),
      [books[0].id]
    );

    // 仅修改标题必须能够正常保存，不得再报「仅支持关联 1 条记录」
    repo.updateEntry(noteId, { ...afterSwitch.entry.rawData, title: '单选后修改标题' });
    assert.equal(repo.getHydratedEntryById(noteId)?.entry.rawData.title, '单选后修改标题');
  });

  it('preserves user-reordered multi-select sequence when undoing deletion of an earlier item', () => {
    const { repo } = createSeededRepo();
    const bookA = repo.createEntry('books', { book_title: '排序书A', status: '想读' });
    const bookB = repo.createEntry('books', { book_title: '排序书B', status: '想读' });
    const bookC = repo.createEntry('books', { book_title: '排序书C', status: '想读' });

    repo.upsertLibrary({
      slug: 'ordered_multi_notes',
      name: '有序多选笔记',
      description: '',
      icon: '🔖',
      color: 'amber',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '关联书目',
          type: 'relation',
          required: false,
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

    const noteId = repo.createEntry('ordered_multi_notes', {
      title: '三书顺序测试',
      books_ref: [bookA, bookB, bookC],
    });

    const delASnap = repo.deleteEntry(bookA);
    assert.ok(delASnap);

    // 删除 A 后用户将剩余项重排为 [C, B]
    repo.updateEntry(noteId, {
      title: '三书顺序测试',
      books_ref: [bookC, bookB],
    });
    assert.deepEqual(repo.getHydratedEntryById(noteId)?.entry.rawData.books_ref, [bookC, bookB]);

    // 撤销删除 A 后，应恢复 A 且保持 C 在 B 前面 -> [A, C, B]
    repo.undoSnapshot(delASnap);
    const restored = repo.getHydratedEntryById(noteId);
    assert.ok(restored);
    assert.deepEqual(restored.entry.rawData.books_ref, [bookA, bookC, bookB]);
    assert.deepEqual(
      restored.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookA, bookC, bookB]
    );
  });

  it('detaches child libraries created later when undoing an Architect plan that created their parent library', () => {
    const { repo } = createSeededRepo();
    const parentSnapId = repo.applyArchitectPlan({
      summary: '创建父库项目',
      libraries: [
        {
          slug: 'parent_projects_r6',
          name: '父项目库',
          description: '',
          icon: '📁',
          color: 'blue',
          fields: [{ key: 'title', label: '名称', type: 'text', required: true }],
          views: {
            card: {
              titleFieldKey: 'title',
              footerMetricKeys: [],
              sortDir: 'desc',
              highlightRules: [],
            },
          },
        },
      ],
      dashboardWidgets: [],
    });

    // 之后在该父库下创建子库（默认首页隐藏）
    repo.upsertLibrary({
      slug: 'child_tasks_r6',
      name: '子任务库',
      description: '',
      icon: '✅',
      color: 'emerald',
      parentLibrarySlug: 'parent_projects_r6',
      showOnHome: false,
      fields: [{ key: 'title', label: '任务名', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    const childBefore = repo.getLibraryBySlug('child_tasks_r6');
    assert.equal(childBefore?.parentLibrarySlug, 'parent_projects_r6');
    assert.equal(childBefore?.showOnHome, false);

    // 撤销父库建库方案后，子库应自动解除父级归属并在首页重新可见
    repo.undoSnapshot(parentSnapId);
    assert.equal(repo.getLibraryBySlug('parent_projects_r6'), null);
    const childAfter = repo.getLibraryBySlug('child_tasks_r6');
    assert.ok(childAfter);
    assert.equal(childAfter.parentLibrarySlug, null);
    assert.equal(childAfter.showOnHome, true);
  });

  it('avoids rewriting entry_relations when an Architect plan or its undo does not change relation fields', () => {
    const { repo, queries, clearQueries } = createSeededRepo();
    const logsLib = repo.getLibraryBySlug('reading_logs')!;
    const beforeLogs = repo.listHydratedEntries('reading_logs');
    assert.ok(beforeLogs.length > 0);
    const originalBookIds = beforeLogs.map((e) => e.forwardLinks.book?.map((r) => r.id) ?? []);

    clearQueries();
    const renameSnapId = repo.applyArchitectPlan({
      summary: '仅重命名阅读记录',
      libraries: [
        {
          slug: logsLib.slug,
          name: '阅读打卡日志',
          description: logsLib.description,
          icon: logsLib.icon,
          color: logsLib.color,
          parentLibrarySlug: logsLib.parentLibrarySlug ?? undefined,
          showOnHome: logsLib.showOnHome,
          fields: logsLib.fields,
          views: logsLib.views,
        },
      ],
      dashboardWidgets: [],
    });

    const relWritesOnApply = queries.filter((q) =>
      /DELETE FROM entry_relations|INSERT.*INTO entry_relations/i.test(q)
    );
    assert.deepEqual(
      relWritesOnApply,
      [],
      'Renaming a library via Architect plan must not rewrite entry_relations'
    );

    clearQueries();
    repo.undoSnapshot(renameSnapId);
    const relWritesOnUndo = queries.filter((q) =>
      /DELETE FROM entry_relations|INSERT.*INTO entry_relations/i.test(q)
    );
    assert.deepEqual(
      relWritesOnUndo,
      [],
      'Undoing a pure rename Architect plan must not rewrite entry_relations'
    );

    const afterLogs = repo.listHydratedEntries('reading_logs');
    assert.equal(repo.getLibraryBySlug('reading_logs')?.name, logsLib.name);
    assert.deepEqual(
      afterLogs.map((e) => e.forwardLinks.book?.map((r) => r.id) ?? []),
      originalBookIds
    );
  });
});

describe('6. Round-7 review fixes: legacy snapshot identity, plan trim undo, legacy delete undo & linear merge', () => {
  it('verifies legacy pre-upgrade architect_plan snapshot identity both on upgrade backfill and at runtime undo', () => {
    // 场景 A：用 8eaa8a4 格式创建库与快照（无 createdLibraries），升级重启后删原库、建同 slug 新库并录记录，撤销旧快照不误删新库
    const ctxA = createSeededRepo();
    const oldPlanSnapA = ctxA.repo.applyArchitectPlan({
      summary: '旧版创建 legacy_custom_8',
      libraries: [
        {
          slug: 'legacy_custom_8',
          name: '旧库A',
          description: '',
          icon: '📦',
          color: 'teal',
          fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
          views: {
            card: {
              titleFieldKey: 'title',
              footerMetricKeys: [],
              sortDir: 'desc',
              highlightRules: [],
            },
          },
        },
      ],
      dashboardWidgets: [],
    });
    const oldSnapRowA = ctxA.driver.getFirstSync<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM ai_snapshots WHERE id = ?',
      [oldPlanSnapA]
    );
    assert.ok(oldSnapRowA);
    const parsedOldA = JSON.parse(oldSnapRowA.snapshot_json) as Record<string, unknown>;
    delete parsedOldA.createdLibraries;
    ctxA.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(parsedOldA),
      oldPlanSnapA,
    ]);

    // 模拟升级：使用同一 SQLite driver 重新初始化 OmniRepository
    const upgradedRepoA = new OmniRepository(ctxA.driver);
    upgradedRepoA.deleteLibrary('legacy_custom_8');
    const newLibIdA = upgradedRepoA.upsertLibrary({
      slug: 'legacy_custom_8',
      name: '新库A',
      description: '',
      icon: '✨',
      color: 'blue',
      fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    const keptEntryA = upgradedRepoA.createEntry('legacy_custom_8', { title: '升级后新记录A' });

    assert.equal(upgradedRepoA.describeSnapshotUndoImpact(oldPlanSnapA).affectedEntriesCount, 0);
    upgradedRepoA.undoSnapshot(oldPlanSnapA);
    assert.equal(upgradedRepoA.getLibraryBySlug('legacy_custom_8')?.id, newLibIdA);
    assert.equal(
      upgradedRepoA.getHydratedEntryById(keptEntryA)?.entry.rawData.title,
      '升级后新记录A'
    );

    // 场景 B：即使在运行期直接遇到无 createdLibraries 的旧快照（未经过升级回填，且原库已被删并重建），撤销时仍应核实身份不误删新库
    const ctxB = createSeededRepo();
    const oldPlanSnapB = ctxB.repo.applyArchitectPlan({
      summary: '旧版创建 legacy_custom_9',
      libraries: [
        {
          slug: 'legacy_custom_9',
          name: '旧库B',
          description: '',
          icon: '📦',
          color: 'teal',
          fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
          views: {
            card: {
              titleFieldKey: 'title',
              footerMetricKeys: [],
              sortDir: 'desc',
              highlightRules: [],
            },
          },
        },
      ],
      dashboardWidgets: [],
    });
    ctxB.repo.deleteLibrary('legacy_custom_9');
    const newLibIdB = ctxB.repo.upsertLibrary({
      slug: 'legacy_custom_9',
      name: '新库B',
      description: '',
      icon: '✨',
      color: 'blue',
      fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    const keptEntryB = ctxB.repo.createEntry('legacy_custom_9', { title: '新记录B' });

    // 删除 createdLibraries 模拟未回填的旧快照
    const oldSnapRowB = ctxB.driver.getFirstSync<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM ai_snapshots WHERE id = ?',
      [oldPlanSnapB]
    );
    const parsedOldB = JSON.parse(oldSnapRowB!.snapshot_json) as Record<string, unknown>;
    delete parsedOldB.createdLibraries;
    ctxB.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(parsedOldB),
      oldPlanSnapB,
    ]);

    assert.equal(ctxB.repo.describeSnapshotUndoImpact(oldPlanSnapB).affectedEntriesCount, 0);
    ctxB.repo.undoSnapshot(oldPlanSnapB);
    assert.equal(ctxB.repo.getLibraryBySlug('legacy_custom_9')?.id, newLibIdB);
    assert.equal(ctxB.repo.getHydratedEntryById(keptEntryB)?.entry.rawData.title, '新记录B');
  });

  it('restores trimmed multi-select relation items and order when undoing an Architect plan that narrowed to single-select', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const [bookA, bookB] = books;

    repo.upsertLibrary({
      slug: 'booklists_r7',
      name: '书单',
      description: '',
      icon: '📚',
      color: 'teal',
      fields: [
        { key: 'title', label: '书单名', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '收录书籍',
          type: 'relation',
          required: false,
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

    const listId = repo.createEntry('booklists_r7', {
      title: '年度书单',
      books_ref: [bookA.id, bookB.id],
    });

    const listLib = repo.getLibraryBySlug('booklists_r7')!;
    const narrowSnapId = repo.applyArchitectPlan({
      summary: '将书单书籍改为单选',
      libraries: [
        {
          slug: listLib.slug,
          name: listLib.name,
          description: listLib.description,
          icon: listLib.icon,
          color: listLib.color,
          fields: listLib.fields.map((f) =>
            f.key === 'books_ref'
              ? { ...f, relationConfig: { targetLibrarySlug: 'books', allowMultiple: false } }
              : f
          ),
          views: listLib.views,
        },
      ],
      dashboardWidgets: [],
    });

    // 改为单选后应只剩 bookA 且可编辑标题
    const afterNarrow = repo.getHydratedEntryById(listId)!;
    assert.deepEqual(afterNarrow.entry.rawData.books_ref, [bookA.id]);
    repo.updateEntry(listId, { ...afterNarrow.entry.rawData, title: '年度书单（已编辑）' });

    // 立即撤销方案：不仅字段恢复多选，第二本书与反向关联也必须完整找回，且不覆盖期间修改的标题
    repo.undoSnapshot(narrowSnapId);
    const restoredList = repo.getHydratedEntryById(listId)!;
    assert.equal(restoredList.entry.rawData.title, '年度书单（已编辑）');
    assert.deepEqual(restoredList.entry.rawData.books_ref, [bookA.id, bookB.id]);
    assert.deepEqual(
      restoredList.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookA.id, bookB.id]
    );
    assert.ok(
      repo.getHydratedEntryById(bookB.id)?.entry.backlinks.some((r) => r.id === listId),
      'Book B backlinks must be restored after undoing single-select conversion'
    );
  });

  it('recovers valid relations stored only in payload.relations when undoing a legacy 9080eb3 entry_deleted snapshot', () => {
    const { repo, driver } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    const book = books[0];
    const logId = repo.createEntry('reading_logs', {
      book: [book.id],
      read_date: '2026-11-26',
      note: '旧版删记录快照测试',
    });
    const delSnapId = repo.deleteEntry(logId);
    assert.ok(delSnapId);

    // 模拟 9080eb3 生成的删记录快照：payload.entry.data_json.book 为 []，有效关联仅存在于 payload.relations 中
    const snapRow = driver.getFirstSync<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM ai_snapshots WHERE id = ?',
      [delSnapId]
    );
    assert.ok(snapRow);
    const payload = JSON.parse(snapRow.snapshot_json) as {
      entry: { data_json: string };
      relations: Array<Record<string, unknown>>;
    };
    const entryData = JSON.parse(payload.entry.data_json) as Record<string, unknown>;
    entryData.book = [];
    payload.entry.data_json = JSON.stringify(entryData);
    assert.ok(payload.relations.length > 0);
    driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(payload),
      delSnapId,
    ]);

    repo.undoSnapshot(delSnapId);
    const restoredLog = repo.getHydratedEntryById(logId);
    const restoredBook = repo.getHydratedEntryById(book.id);
    assert.ok(restoredLog && restoredBook);
    assert.deepEqual(restoredLog.entry.rawData.book, [book.id]);
    assert.deepEqual(
      restoredLog.entry.forwardLinks.book?.map((r) => r.id),
      [book.id]
    );
    assert.ok(restoredBook.entry.backlinks.some((r) => r.id === logId));
  });

  it('keeps optional relations editable after cross-library single-select conversion and partial delete/restore, while restoring links when target returns', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const [bookA, bookB] = books;

    // 场景 A：多选书籍改为单选资产（无有效资产时必须清空旧书 ID，不得残留第一本书阻断保存）
    repo.upsertLibrary({
      slug: 'convert_target_notes',
      name: '转换测试笔记',
      description: '',
      icon: '📝',
      color: 'teal',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'ref_items',
          label: '关联项',
          type: 'relation',
          required: false,
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
    const convNoteId = repo.createEntry('convert_target_notes', {
      title: '原双书笔记',
      ref_items: [bookA.id, bookB.id],
    });
    const convLib = repo.getLibraryBySlug('convert_target_notes')!;
    const convSnap = repo.applyArchitectPlan({
      summary: '多选书籍改单选资产',
      libraries: [
        {
          slug: convLib.slug,
          name: convLib.name,
          description: convLib.description,
          icon: convLib.icon,
          color: convLib.color,
          fields: convLib.fields.map((f) =>
            f.key === 'ref_items'
              ? {
                  ...f,
                  relationConfig: { targetLibrarySlug: 'my_assets', allowMultiple: false },
                }
              : f
          ),
          views: convLib.views,
        },
      ],
      dashboardWidgets: [],
    });
    const afterConv = repo.getHydratedEntryById(convNoteId)!;
    assert.deepEqual(afterConv.entry.rawData.ref_items, []);
    repo.updateEntry(convNoteId, { ...afterConv.entry.rawData, title: '改标题成功' });
    assert.equal(repo.getHydratedEntryById(convNoteId)?.entry.rawData.title, '改标题成功');

    // 撤销方案时，原双书关联无损还原，且保留新标题
    repo.undoSnapshot(convSnap);
    const afterUndoConv = repo.getHydratedEntryById(convNoteId)!;
    assert.equal(afterUndoConv.entry.rawData.title, '改标题成功');
    assert.deepEqual(afterUndoConv.entry.rawData.ref_items, [bookA.id, bookB.id]);

    // 场景 B：先删笔记、再删书架，只恢复笔记 -> 笔记立即可编辑改标题 -> 再恢复书架 -> 关联自动无损恢复且保留新标题
    const logId = repo.createEntry('reading_logs', {
      book: [bookA.id],
      read_date: '2026-11-26',
      note: '原书摘标题',
    });
    const delLogSnap = repo.deleteEntry(logId);
    assert.ok(delLogSnap);
    repo.deleteLibrary('books');
    const delBooksSnap = repo.listSnapshots().find((s) => s.actionSummary.includes('阅读书架'));
    assert.ok(delBooksSnap);

    // 只恢复笔记：已删书 ID 移入书架快照等待恢复，当前笔记 data_json.book 清空且立即可改标题保存
    repo.undoSnapshot(delLogSnap);
    const logAfterPartialRestore = repo.getHydratedEntryById(logId)!;
    assert.deepEqual(logAfterPartialRestore.entry.rawData.book, []);
    repo.updateEntry(logId, {
      ...logAfterPartialRestore.entry.rawData,
      note: '仅恢复笔记后修改的标题',
    });
    assert.equal(
      repo.getHydratedEntryById(logId)?.entry.rawData.note,
      '仅恢复笔记后修改的标题'
    );

    // 随后恢复书架：笔记自动恢复关联到 bookA，并保留期间编辑的新标题
    repo.undoSnapshot(delBooksSnap.id);
    const logAfterBothRestored = repo.getHydratedEntryById(logId)!;
    assert.equal(logAfterBothRestored.entry.rawData.note, '仅恢复笔记后修改的标题');
    assert.deepEqual(logAfterBothRestored.entry.rawData.book, [bookA.id]);
    assert.deepEqual(
      logAfterBothRestored.entry.forwardLinks.book?.map((r) => r.id),
      [bookA.id]
    );
  });

  it('reindexes surviving references for untargeted relation fields (without targetLibrarySlug) when restoring targets', () => {
    const { repo, driver } = createSeededRepo();
    const book = repo.listHydratedEntries('books')[0];

    repo.upsertLibrary({
      slug: 'any_ref_notes',
      name: '自由关联笔记',
      description: '',
      icon: '🔗',
      color: 'blue',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'any_target',
          label: '任意关联',
          type: 'relation',
          required: false,
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

    const noteId = repo.createEntry('any_ref_notes', {
      title: '自由引用书',
      any_target: [book.id],
    });
    assert.deepEqual(
      repo.getHydratedEntryById(noteId)?.entry.forwardLinks.any_target?.map((r) => r.id),
      [book.id]
    );

    // 路径 1：先删来源、再删目标，同序恢复两者
    const delNoteSnap = repo.deleteEntry(noteId)!;
    const delBookSnap = repo.deleteEntry(book.id)!;
    repo.undoSnapshot(delNoteSnap);
    repo.undoSnapshot(delBookSnap);

    const restored1 = repo.getHydratedEntryById(noteId)!;
    assert.deepEqual(restored1.entry.rawData.any_target, [book.id]);
    assert.deepEqual(
      restored1.entry.forwardLinks.any_target?.map((r) => r.id),
      [book.id]
    );
    assert.ok(repo.getHydratedEntryById(book.id)?.entry.backlinks.some((r) => r.id === noteId));

    // 路径 2：验证无 detachedSources 时，reindexSurvivingReferencesToEntriesInternal 同样能为未指定目标库的字段补建索引
    const delBookSnap2 = repo.deleteEntry(book.id)!;
    // 模拟历史快照无 detachedSources 但存活记录 data_json 保留目标 ID
    const snap2Row = driver.getFirstSync<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM ai_snapshots WHERE id = ?',
      [delBookSnap2]
    )!;
    const snap2Payload = JSON.parse(snap2Row.snapshot_json) as Record<string, unknown>;
    snap2Payload.detachedSources = [];
    snap2Payload.relations = [];
    driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(snap2Payload),
      delBookSnap2,
    ]);
    driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
      JSON.stringify({ title: '自由引用书', any_target: [book.id] }),
      noteId,
    ]);

    repo.undoSnapshot(delBookSnap2);
    assert.deepEqual(
      repo.getHydratedEntryById(noteId)?.entry.forwardLinks.any_target?.map((r) => r.id),
      [book.id]
    );
  });

  it('uses entry_relations.sort_order when merging missing multi-select items during legacy backup import', () => {
    const { repo } = createSeededRepo();
    const bookA = repo.createEntry('books', { book_title: '导入序A', status: '想读' });
    const bookB = repo.createEntry('books', { book_title: '导入序B', status: '想读' });
    const bookC = repo.createEntry('books', { book_title: '导入序C', status: '想读' });

    repo.upsertLibrary({
      slug: 'import_order_notes',
      name: '导入顺序测试',
      description: '',
      icon: '📑',
      color: 'amber',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '书目',
          type: 'relation',
          required: false,
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

    const noteOnlyFirstId = repo.createEntry('import_order_notes', {
      title: 'B为关联表唯一首位项',
      books_ref: [bookB, bookC, bookA],
    });
    const noteFullRelsId = repo.createEntry('import_order_notes', {
      title: '完整关联表缺首位B',
      books_ref: [bookB, bookC, bookA],
    });

    const bundle = repo.exportBackupBundle();
    // 构造真实旧备份：字段里只剩 [C, A]，而关联表里 B 排在 sort_order = 0
    bundle.entries = bundle.entries.map((e) => {
      if (String(e.id) === noteOnlyFirstId || String(e.id) === noteFullRelsId) {
        const parsed = JSON.parse(String(e.data_json)) as Record<string, unknown>;
        parsed.books_ref = [bookC, bookA];
        return { ...e, data_json: JSON.stringify(parsed) };
      }
      return e;
    });
    bundle.relations = bundle.relations.filter((r) => {
      if (String(r.source_entry_id) === noteOnlyFirstId) {
        // 仅保留 B (sort_order = 0)
        return String(r.target_entry_id) === bookB;
      }
      return true;
    });

    const freshCtx = createInstrumentedSqliteDriver();
    const freshRepo = new OmniRepository(freshCtx.driver);
    freshRepo.importBackupBundle(bundle);

    const hydratedOnlyFirst = freshRepo.getHydratedEntryById(noteOnlyFirstId)!;
    assert.deepEqual(hydratedOnlyFirst.entry.rawData.books_ref, [bookB, bookC, bookA]);
    assert.deepEqual(
      hydratedOnlyFirst.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookB, bookC, bookA]
    );

    const hydratedFull = freshRepo.getHydratedEntryById(noteFullRelsId)!;
    assert.deepEqual(hydratedFull.entry.rawData.books_ref, [bookB, bookC, bookA]);
    assert.deepEqual(
      hydratedFull.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookB, bookC, bookA]
    );
  });

  it('restores 1,600 ordered multi-select relations on library delete undo in linear time without blocking', () => {
    const { repo, driver } = createSeededRepo();
    repo.upsertLibrary({
      slug: 'bulk_books_r7',
      name: '千书库',
      description: '',
      icon: '📚',
      color: 'teal',
      fields: [{ key: 'title', label: '书名', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    repo.upsertLibrary({
      slug: 'bulk_shelf_r7',
      name: '大书单',
      description: '',
      icon: '🗂️',
      color: 'blue',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '关联书目',
          type: 'relation',
          required: false,
          relationConfig: { targetLibrarySlug: 'bulk_books_r7', allowMultiple: true },
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

    const bulkLib = repo.getLibraryBySlug('bulk_books_r7')!;
    const count = 1600;
    const bookIds: string[] = [];
    const now = Date.now();
    driver.withTransactionSync(() => {
      for (let i = 0; i < count; i++) {
        const id = `ent_bulk_${String(i).padStart(4, '0')}`;
        bookIds.push(id);
        driver.runSync(
          `INSERT INTO entries (id, library_id, title_summary, search_text, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, bulkLib.id, `书${i}`, `书${i}`, JSON.stringify({ title: `书${i}` }), now + i, now + i]
        );
      }
    });

    const shelfId = repo.createEntry('bulk_shelf_r7', {
      title: '1600本书单',
      books_ref: bookIds,
    });

    repo.deleteLibrary('bulk_books_r7');
    const delSnap = repo.listSnapshots().find((s) => s.actionSummary.includes('千书库'));
    assert.ok(delSnap);
    assert.deepEqual(repo.getHydratedEntryById(shelfId)?.entry.rawData.books_ref, []);

    const startMs = performance.now();
    repo.undoSnapshot(delSnap.id);
    const elapsedMs = performance.now() - startMs;

    const restoredShelf = repo.getHydratedEntryById(shelfId)!;
    assert.deepEqual(restoredShelf.entry.rawData.books_ref, bookIds);
    assert.deepEqual(
      restoredShelf.entry.forwardLinks.books_ref?.map((r) => r.id),
      bookIds
    );
    assert.ok(
      elapsedMs < 1000,
      `Restoring 1,600 ordered relations should complete well under 1s, took ${elapsedMs.toFixed(1)}ms`
    );
  });
});

describe('7. Round-8 review fixes: backup snapshot isolation, non-relation restore, symmetric partial undo & zero-scan startup', () => {
  it('isolates undo history on full backup import and never lets legacy snapshots without library IDs delete imported libraries', () => {
    // 场景 A：新版本中全量导入备份必须清空导入前的撤销历史
    const ctx1 = createSeededRepo();
    ctx1.repo.applyArchitectPlan({
      summary: '导入前新建 custom_backup_iso',
      libraries: [
        {
          slug: 'custom_backup_iso',
          name: '导入前库',
          description: '',
          icon: '📦',
          color: 'teal',
          fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
          views: {
            card: {
              titleFieldKey: 'title',
              footerMetricKeys: [],
              sortDir: 'desc',
              highlightRules: [],
            },
          },
        },
      ],
      dashboardWidgets: [],
    });
    assert.ok(ctx1.repo.listSnapshots().length > 0);

    // 另一份备份中恰好在几秒内创建了同 slug 但不同 ID 的库并含数据
    const ctxOther = createSeededRepo();
    const importedLibId = ctxOther.repo.upsertLibrary({
      slug: 'custom_backup_iso',
      name: '备份里的同名库',
      description: '',
      icon: '✨',
      color: 'blue',
      fields: [{ key: 'title', label: '标题', type: 'text', required: true }],
      views: {
        card: {
          titleFieldKey: 'title',
          footerMetricKeys: [],
          sortDir: 'desc',
          highlightRules: [],
        },
      },
    });
    const importedEntryId = ctxOther.repo.createEntry('custom_backup_iso', {
      title: '来自备份的珍贵数据',
    });
    const otherBundle = ctxOther.repo.exportBackupBundle();

    ctx1.repo.importBackupBundle(otherBundle);
    assert.equal(ctx1.repo.listSnapshots().length, 0, 'Full backup import must clear prior snapshots');
    assert.equal(ctx1.repo.getLibraryBySlug('custom_backup_iso')?.id, importedLibId);
    assert.equal(
      ctx1.repo.getHydratedEntryById(importedEntryId)?.entry.rawData.title,
      '来自备份的珍贵数据'
    );

    // 场景 B：模拟 8eaa8a4 遗留的数据库状态（旧版导入备份未清空 ai_snapshots，旧建库快照缺少 createdLibraries 且与导入库时间相差 < 5 秒）
    const snapTime = Date.now();
    const legacySnapId = 'snap_legacy_8eaa8a4';
    ctx1.driver.runSync(
      `INSERT INTO ai_snapshots (id, action_summary, snapshot_json, undone, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      [
        legacySnapId,
        '8eaa8a4 遗留建库方案',
        JSON.stringify({
          kind: 'architect_plan',
          createdLibrarySlugs: ['custom_backup_iso'],
          previousLibraries: [],
          previousLibraryViews: [],
          createdWidgetIds: [],
        }),
        snapTime,
      ]
    );
    ctx1.driver.runSync('UPDATE libraries SET created_at = ? WHERE id = ?', [
      snapTime + 1000,
      importedLibId,
    ]);
    // 模拟从 8eaa8a4 (v4) 升级到最新版 (v5)
    ctx1.driver.execSync('PRAGMA user_version = 4;');
    const upgradedRepo = new OmniRepository(ctx1.driver);

    assert.equal(upgradedRepo.describeSnapshotUndoImpact(legacySnapId).affectedEntriesCount, 0);
    upgradedRepo.undoSnapshot(legacySnapId);
    assert.equal(
      upgradedRepo.getLibraryBySlug('custom_backup_iso')?.id,
      importedLibId,
      'Legacy snapshot without createdLibraries must never delete an imported library by slug/time window'
    );
    assert.equal(
      upgradedRepo.getHydratedEntryById(importedEntryId)?.entry.rawData.title,
      '来自备份的珍贵数据'
    );
  });

  it('restores original text field values and search metadata when undoing an Architect plan that converted text to relation', () => {
    const { repo } = createSeededRepo();
    repo.upsertLibrary({
      slug: 'edition_notes_r8',
      name: '藏书品相',
      description: '',
      icon: '📖',
      color: 'amber',
      fields: [
        { key: 'title', label: '书名', type: 'text', required: true },
        { key: 'remark', label: '品相备注', type: 'text', required: false },
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

    const entryId = repo.createEntry('edition_notes_r8', {
      title: '百年孤独',
      remark: '签名初版，书衣有折痕',
    });

    const lib = repo.getLibraryBySlug('edition_notes_r8')!;
    const convertSnapId = repo.applyArchitectPlan(
      {
        summary: '将品相备注误改为关联字段',
        libraries: [
          {
            slug: lib.slug,
            name: lib.name,
            description: lib.description,
            icon: lib.icon,
            color: lib.color,
            fields: lib.fields.map((f) =>
              f.key === 'remark'
                ? {
                    ...f,
                    type: 'relation',
                    relationConfig: { targetLibrarySlug: 'books', allowMultiple: true },
                  }
                : f
            ),
            views: lib.views,
          },
        ],
        dashboardWidgets: [],
      },
      { allowDestructiveFieldChanges: true }
    );

    assert.deepEqual(repo.getHydratedEntryById(entryId)?.entry.rawData.remark, []);

    // 立即撤销方案：字段类型恢复为 text，原文必须完整找回且可搜索
    repo.undoSnapshot(convertSnapId);
    const restoredLib = repo.getLibraryBySlug('edition_notes_r8')!;
    assert.equal(restoredLib.fields.find((f) => f.key === 'remark')?.type, 'text');
    const restoredEntry = repo.getHydratedEntryById(entryId)!;
    assert.equal(restoredEntry.entry.rawData.remark, '签名初版，书衣有折痕');
    assert.ok(
      repo.searchEntrySummaries('书衣有折痕').some((hit) => hit.id === entryId),
      'Restored text field must also be reindexed into search_text'
    );
  });

  it('preserves pending relations across arbitrary partial undo orders for both delete snapshots and Architect plan trims', () => {
    const { repo } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);
    const [bookA, bookB] = books;

    // 场景 A：先删书、再删引用它的笔记 -> 先恢复书、再恢复笔记 -> 正向与反向关联均完整恢复
    const noteId = repo.createEntry('reading_logs', {
      book: [bookA.id],
      read_date: '2026-11-27',
      note: '先删书后删笔记测试',
    });
    const delBookSnap = repo.deleteEntry(bookA.id)!;
    const delNoteSnap = repo.deleteEntry(noteId)!;

    repo.undoSnapshot(delBookSnap);
    repo.undoSnapshot(delNoteSnap);

    const restoredNote = repo.getHydratedEntryById(noteId)!;
    const restoredBook = repo.getHydratedEntryById(bookA.id)!;
    assert.deepEqual(restoredNote.entry.rawData.book, [bookA.id]);
    assert.deepEqual(
      restoredNote.entry.forwardLinks.book?.map((r) => r.id),
      [bookA.id]
    );
    assert.ok(restoredBook.entry.backlinks.some((r) => r.id === noteId));

    // 场景 B：书单 [A, B] 经 AI 方案改为单选 -> 删除 B -> 撤销方案 -> 再恢复 B -> 书单恢复 [A, B]
    repo.upsertLibrary({
      slug: 'booklists_r8',
      name: '分次撤销书单',
      description: '',
      icon: '📚',
      color: 'teal',
      fields: [
        { key: 'title', label: '书单名', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '收录书籍',
          type: 'relation',
          required: false,
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
    const listId = repo.createEntry('booklists_r8', {
      title: '双书单',
      books_ref: [bookA.id, bookB.id],
    });
    const listLib = repo.getLibraryBySlug('booklists_r8')!;
    const narrowSnap = repo.applyArchitectPlan({
      summary: '书单改为单选',
      libraries: [
        {
          slug: listLib.slug,
          name: listLib.name,
          description: listLib.description,
          icon: listLib.icon,
          color: listLib.color,
          fields: listLib.fields.map((f) =>
            f.key === 'books_ref'
              ? { ...f, relationConfig: { targetLibrarySlug: 'books', allowMultiple: false } }
              : f
          ),
          views: listLib.views,
        },
      ],
      dashboardWidgets: [],
    });

    const delBookBSnap = repo.deleteEntry(bookB.id)!;
    repo.undoSnapshot(narrowSnap);
    assert.deepEqual(repo.getHydratedEntryById(listId)?.entry.rawData.books_ref, [bookA.id]);

    repo.undoSnapshot(delBookBSnap);
    const finalList = repo.getHydratedEntryById(listId)!;
    assert.deepEqual(finalList.entry.rawData.books_ref, [bookA.id, bookB.id]);
    assert.deepEqual(
      finalList.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookA.id, bookB.id]
    );
  });

  it('preserves legacy 9080eb3 entry_relations when adding unrelated fields after upgrade and when restoring legacy double-deleted entries in order', () => {
    // 场景 A：9080eb3 遗留的笔记（data_json.book = []，关联仅在 entry_relations），升级后给该库新增无关关联字段，原书籍关联必须保留
    const ctxA = createSeededRepo();
    const bookA = ctxA.repo.listHydratedEntries('books')[0];
    const logAId = ctxA.repo.createEntry('reading_logs', {
      book: [bookA.id],
      read_date: '2026-11-27',
      note: '旧版仅关系表有效笔记',
    });
    const rawLogA = ctxA.driver.getFirstSync<{ data_json: string }>(
      'SELECT data_json FROM entries WHERE id = ?',
      [logAId]
    )!;
    const parsedLogA = JSON.parse(rawLogA.data_json) as Record<string, unknown>;
    parsedLogA.book = [];
    ctxA.driver.runSync('UPDATE entries SET data_json = ? WHERE id = ?', [
      JSON.stringify(parsedLogA),
      logAId,
    ]);
    // 即使跳过 v4->v5 迁移（保持当前 user_version=5），直接新增无关关联字段也必须先合并旧 entry_relations 而不清空
    const logsLibA = ctxA.repo.getLibraryBySlug('reading_logs')!;
    ctxA.repo.upsertLibrary({
      slug: logsLibA.slug,
      name: logsLibA.name,
      description: logsLibA.description,
      icon: logsLibA.icon,
      color: logsLibA.color,
      parentLibrarySlug: logsLibA.parentLibrarySlug ?? undefined,
      showOnHome: logsLibA.showOnHome,
      fields: [
        ...logsLibA.fields,
        {
          key: 'extra_asset',
          label: '关联装备',
          type: 'relation',
          required: false,
          relationConfig: { targetLibrarySlug: 'my_assets', allowMultiple: false },
        },
      ],
      views: logsLibA.views,
    });
    const afterAddField = ctxA.repo.getHydratedEntryById(logAId)!;
    assert.deepEqual(afterAddField.entry.rawData.book, [bookA.id]);
    assert.deepEqual(
      afterAddField.entry.forwardLinks.book?.map((r) => r.id),
      [bookA.id]
    );

    // 场景 B：9080eb3 中先删笔记（data_json.book = []，仅 payload.relations 有 bookB）、再删书 -> 升级后先恢复笔记再恢复书 -> 关联恢复
    const ctxB = createSeededRepo();
    const bookB = ctxB.repo.listHydratedEntries('books')[0];
    const logBId = ctxB.repo.createEntry('reading_logs', {
      book: [bookB.id],
      read_date: '2026-11-27',
      note: '旧版双删同序恢复笔记',
    });
    const delLogBSnap = ctxB.repo.deleteEntry(logBId)!;
    const delBookBSnap = ctxB.repo.deleteEntry(bookB.id)!;

    // 模拟 9080eb3 删笔记快照：entry.data_json.book 为 []，关联只存在 payload.relations
    const snapRow = ctxB.driver.getFirstSync<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM ai_snapshots WHERE id = ?',
      [delLogBSnap]
    )!;
    const snapPayload = JSON.parse(snapRow.snapshot_json) as {
      entry: { data_json: string };
      relations: Array<Record<string, unknown>>;
    };
    const eData = JSON.parse(snapPayload.entry.data_json) as Record<string, unknown>;
    eData.book = [];
    snapPayload.entry.data_json = JSON.stringify(eData);
    ctxB.driver.runSync('UPDATE ai_snapshots SET snapshot_json = ? WHERE id = ?', [
      JSON.stringify(snapPayload),
      delLogBSnap,
    ]);

    ctxB.repo.undoSnapshot(delLogBSnap);
    // 书尚未恢复时笔记必须可编辑保存
    const midLogB = ctxB.repo.getHydratedEntryById(logBId)!;
    assert.deepEqual(midLogB.entry.rawData.book, []);
    ctxB.repo.updateEntry(logBId, { ...midLogB.entry.rawData, note: '期间修改正文' });

    ctxB.repo.undoSnapshot(delBookBSnap);
    const finalLogB = ctxB.repo.getHydratedEntryById(logBId)!;
    assert.equal(finalLogB.entry.rawData.note, '期间修改正文');
    assert.deepEqual(finalLogB.entry.rawData.book, [bookB.id]);
    assert.deepEqual(
      finalLogB.entry.forwardLinks.book?.map((r) => r.id),
      [bookB.id]
    );
  });

  it('accounts for previously inserted missing items when merging multiple leading sort_order entries on legacy backup import', () => {
    const { repo } = createSeededRepo();
    const bookA = repo.createEntry('books', { book_title: '前序A', status: '想读' });
    const bookB = repo.createEntry('books', { book_title: '前序B', status: '想读' });
    const bookC = repo.createEntry('books', { book_title: '前序C', status: '想读' });
    const bookD = repo.createEntry('books', { book_title: '前序D', status: '想读' });

    repo.upsertLibrary({
      slug: 'multi_lead_import_notes',
      name: '多前项导入顺序',
      description: '',
      icon: '📑',
      color: 'amber',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        {
          key: 'books_ref',
          label: '书目',
          type: 'relation',
          required: false,
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

    const noteId = repo.createEntry('multi_lead_import_notes', {
      title: 'ABCD顺序测试',
      books_ref: [bookA, bookB, bookC, bookD],
    });

    const bundle = repo.exportBackupBundle();
    // 构造实际备份：data_json 只剩 [C, D]，关系表仅记录 A(0)、B(1)
    bundle.entries = bundle.entries.map((e) => {
      if (String(e.id) !== noteId) return e;
      const parsed = JSON.parse(String(e.data_json)) as Record<string, unknown>;
      parsed.books_ref = [bookC, bookD];
      return { ...e, data_json: JSON.stringify(parsed) };
    });
    bundle.relations = bundle.relations.filter((r) => {
      if (String(r.source_entry_id) !== noteId) return true;
      return String(r.target_entry_id) === bookA || String(r.target_entry_id) === bookB;
    });

    const freshCtx = createInstrumentedSqliteDriver();
    const freshRepo = new OmniRepository(freshCtx.driver);
    freshRepo.importBackupBundle(bundle);

    const hydrated = freshRepo.getHydratedEntryById(noteId)!;
    assert.deepEqual(hydrated.entry.rawData.books_ref, [bookA, bookB, bookC, bookD]);
    assert.deepEqual(
      hydrated.entry.forwardLinks.books_ref?.map((r) => r.id),
      [bookA, bookB, bookC, bookD]
    );
  });

  it('performs zero ai_snapshots reads during repository startup after v5 migration even with large snapshots', () => {
    const { repo, driver, queries, clearQueries } = createSeededRepo();
    const books = repo.listHydratedEntries('books');
    assert.ok(books.length >= 2);

    repo.upsertLibrary({
      slug: 'large_snap_lib_r8',
      name: '大快照测试库',
      description: '',
      icon: '📦',
      color: 'slate',
      fields: [
        { key: 'title', label: '标题', type: 'text', required: true },
        { key: 'body', label: '正文', type: 'text', required: false },
        {
          key: 'books_ref',
          label: '关联书',
          type: 'relation',
          required: false,
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
    const lib = repo.getLibraryBySlug('large_snap_lib_r8')!;
    const bigBody = '长正文内容'.repeat(200);
    const now = Date.now();
    driver.withTransactionSync(() => {
      for (let i = 0; i < 64; i++) {
        driver.runSync(
          `INSERT INTO entries (id, library_id, title_summary, search_text, data_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            `ent_big_${i}`,
            lib.id,
            `大记录${i}`,
            `大记录${i}`,
            JSON.stringify({ title: `大记录${i}`, body: bigBody, books_ref: [books[0].id, books[1].id] }),
            now + i,
            now + i,
          ]
        );
      }
    });

    // 生成包含较大 trimmedSources 的新格式 architect_plan 快照
    repo.applyArchitectPlan({
      summary: '生成大方案快照',
      libraries: [
        {
          slug: lib.slug,
          name: lib.name,
          description: lib.description,
          icon: lib.icon,
          color: lib.color,
          fields: lib.fields.map((f) =>
            f.key === 'books_ref'
              ? { ...f, relationConfig: { targetLibrarySlug: 'books', allowMultiple: false } }
              : f
          ),
          views: lib.views,
        },
      ],
      dashboardWidgets: [],
    });

    // 连续两次重新初始化 OmniRepository：均不应查询 ai_snapshots 表
    for (let boot = 0; boot < 2; boot++) {
      clearQueries();
      new OmniRepository(driver);
      const snapshotQueries = queries.filter((q) => /SELECT[\s\S]*FROM\s+ai_snapshots/i.test(q));
      assert.deepEqual(
        snapshotQueries,
        [],
        `Startup #${boot + 1} must not read ai_snapshots`
      );
    }
  });
});
