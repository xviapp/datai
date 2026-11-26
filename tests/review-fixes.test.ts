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
    const { repo, queries, clearQueries } = createSeededRepo();

    // 1. 删除空库时清理历史失效引用：删笔记 -> 删光书架 -> 只撤销删笔记 -> 手动删空书架 -> 编辑笔记仍可保存
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
    assert.deepEqual(repo.getHydratedEntryById(logId)?.entry.rawData.book, [books[0].id]);

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
