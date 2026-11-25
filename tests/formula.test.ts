import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatLocalDate, formatLocalDateOffset } from '../src/engine/date';
import { evaluateFormula, evaluateHighlightRules } from '../src/engine/formula';

describe('evaluateFormula', () => {
  it('evaluates arithmetic precedence, parentheses, and unary operators', () => {
    assert.equal(evaluateFormula('2 + 3 * 4', {}), 14);
    assert.equal(evaluateFormula('(2 + 3) * 4', {}), 20);
    assert.equal(evaluateFormula('-10 + 4.5', {}), -5.5);
    assert.equal(evaluateFormula('10 / 0', {}), 0);
    assert.equal(evaluateFormula('10 % 0', {}), 0);
  });

  it('evaluates context fields and built-in math/logic functions', () => {
    const ctx = { buy_price: 3000, extra_spend: 500, resale_value: 2000, days: 100 };
    assert.equal(
      evaluateFormula('ROUND((buy_price + extra_spend - resale_value) / MAX(1, days), 2)', ctx),
      15
    );
    assert.equal(evaluateFormula('IF(buy_price > 2000, "贵重", "常规")', ctx), '贵重');
    assert.equal(evaluateFormula('IF(buy_price < 1000, "便宜", "正常")', ctx), '正常');
    assert.equal(evaluateFormula('ABS(-42.5)', {}), 42.5);
    assert.equal(evaluateFormula('MIN(10, 3, 7)', {}), 3);
  });

  it('evaluates local date functions consistently', () => {
    assert.equal(evaluateFormula('TODAY()', {}), formatLocalDate());
    assert.equal(evaluateFormula('DAYS_SINCE(d)', { d: formatLocalDateOffset(-10) }), 10);
    assert.equal(evaluateFormula('DAYS_UNTIL(d)', { d: formatLocalDateOffset(15) }), 15);
    assert.equal(evaluateFormula('DAYS_SINCE(d)', { d: formatLocalDateOffset(5) }), 0);
  });

  it('handles empty or malformed formulas gracefully', () => {
    assert.equal(evaluateFormula('', {}), '');
    assert.equal(evaluateFormula('   ', {}), '');
    assert.equal(evaluateFormula('unknown_field + 1', {}), 1);
  });
});

describe('evaluateHighlightRules', () => {
  it('picks highest priority matching tone (danger > warning > info > success)', () => {
    const result = evaluateHighlightRules(
      [
        { fieldKey: 'stock', operator: 'lte', value: 5, tone: 'warning', badgeText: '库存偏低' },
        { fieldKey: 'expiry', operator: 'days_until_lt', value: 30, tone: 'danger', badgeText: '即将过期' },
        { fieldKey: 'active', operator: 'is_true', tone: 'success', badgeText: '启用中' },
      ],
      {
        stock: 2,
        expiry: formatLocalDateOffset(10),
        active: true,
      }
    );
    assert.deepEqual(result, { tone: 'danger', badgeText: '即将过期' });
  });

  it('supports string eq and case-insensitive contains', () => {
    const result = evaluateHighlightRules(
      [{ fieldKey: 'note', operator: 'contains', value: 'urgent', tone: 'info', badgeText: '关注' }],
      { note: 'Very URGENT item' }
    );
    assert.deepEqual(result, { tone: 'info', badgeText: '关注' });
  });
});
