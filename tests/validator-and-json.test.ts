import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { parseAndValidateAiJson } from '../src/ai/schemas';
import {
  buildMonthCalendarCells,
  formatShortRelativeTime,
} from '../src/engine/date';
import { buildEntryPayloadValidator, type FieldDef } from '../src/schema/field-defs';

describe('buildEntryPayloadValidator', () => {
  const fields: FieldDef[] = [
    { key: 'title', label: '名称', type: 'text', required: true },
    { key: 'amount', label: '金额', type: 'currency', required: true },
    { key: 'done', label: '完成', type: 'checkbox', required: false },
    { key: 'tags', label: '标签', type: 'multi_select', required: false },
    { key: 'total', label: '汇总', type: 'formula', required: false, formulaExpr: 'amount * 2' },
  ];

  it('coerces string numbers, booleans, and comma-separated arrays', () => {
    const validator = buildEntryPayloadValidator(fields);
    const parsed = validator.parse({
      title: '测试账单',
      amount: '128.5',
      done: 'true',
      tags: '餐饮, 聚餐',
    });
    assert.equal(parsed.title, '测试账单');
    assert.equal(parsed.amount, 128.5);
    assert.equal(parsed.done, true);
    assert.deepEqual(parsed.tags, ['餐饮', '聚餐']);
  });

  it('rejects empty required text fields with friendly Chinese message', () => {
    const validator = buildEntryPayloadValidator(fields);
    assert.throws(
      () => validator.parse({ title: '', amount: 10 }),
      /名称不能为空/
    );
  });
});

describe('parseAndValidateAiJson', () => {
  const SampleSchema = z.object({
    intent: z.enum(['capture', 'analyst']),
    count: z.number(),
  });

  it('parses fenced markdown JSON and prose-wrapped JSON', () => {
    assert.deepEqual(
      parseAndValidateAiJson('```json\n{"intent":"capture","count":2}\n```', SampleSchema),
      { intent: 'capture', count: 2 }
    );
    assert.deepEqual(
      parseAndValidateAiJson('结果如下：{"intent":"analyst","count":5} 以上。', SampleSchema),
      { intent: 'analyst', count: 5 }
    );
  });

  it('throws clear error on schema violation or non-JSON text', () => {
    assert.throws(
      () => parseAndValidateAiJson('{"intent":"unknown","count":1}', SampleSchema),
      /Zod 校验/
    );
    assert.throws(
      () => parseAndValidateAiJson('纯文本无对象', SampleSchema),
      /未返回合法 JSON/
    );
  });
});

describe('date helpers', () => {
  it('builds calendar cells with proper leading weekday nulls and day count', () => {
    // 2026-11-01 is Sunday (getDay() === 0), November has 30 days
    const cells = buildMonthCalendarCells(2026, 10);
    assert.equal(cells.length, 30);
    assert.equal(cells[0], '2026-11-01');
    assert.equal(cells[29], '2026-11-30');
  });

  it('formats short relative times across day boundaries', () => {
    const base = new Date(2026, 10, 25, 18, 0, 0);
    assert.equal(formatShortRelativeTime(new Date(2026, 10, 25, 9, 0, 0).getTime(), base), '今天');
    assert.equal(formatShortRelativeTime(new Date(2026, 10, 24, 23, 0, 0).getTime(), base), '昨天');
    assert.equal(formatShortRelativeTime(new Date(2026, 10, 21, 12, 0, 0).getTime(), base), '4天前');
    assert.equal(formatShortRelativeTime(new Date(2026, 10, 10, 12, 0, 0).getTime(), base), '11/10');
  });
});
