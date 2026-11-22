import type { HighlightRule, HighlightTone } from '@/schema/view-dsl';
import { formatLocalDate } from './date';

export type FormulaValue = number | string | boolean;

type Token =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'paren'; value: '(' | ')' }
  | { type: 'comma' };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = expr.length;

  while (i < len) {
    const ch = expr[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ type: 'paren', value: ch });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ type: 'comma' });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < len && expr[i] !== quote) {
        str += expr[i++];
      }
      i++; // skip closing quote
      tokens.push({ type: 'str', value: str });
      continue;
    }
    const twoChar = expr.slice(i, i + 2);
    if (['>=', '<=', '==', '!='].includes(twoChar)) {
      tokens.push({ type: 'op', value: twoChar });
      i += 2;
      continue;
    }
    if (['+', '-', '*', '/', '%', '>', '<'].includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let numStr = '';
      while (i < len && /[0-9.]/.test(expr[i])) {
        numStr += expr[i++];
      }
      tokens.push({ type: 'num', value: Number(numStr) || 0 });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = '';
      while (i < len && /[a-zA-Z0-9_]/.test(expr[i])) {
        ident += expr[i++];
      }
      tokens.push({ type: 'ident', value: ident });
      continue;
    }
    i++;
  }
  return tokens;
}

export function daysBetweenTodayAnd(dateVal: unknown): number | null {
  if (!dateVal || typeof dateVal !== 'string') return null;
  const parsed = new Date(dateVal.length === 10 ? `${dateVal}T00:00:00` : dateVal);
  if (Number.isNaN(parsed.getTime())) return null;
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetMidnight = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  return Math.round((targetMidnight.getTime() - todayMidnight.getTime()) / 86_400_000);
}

function toNum(v: FormulaValue): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 零 eval 的安全递归下降公式求值引擎
 * 支持四则运算、比较运算、DAYS_SINCE / DAYS_UNTIL / TODAY / IF / ROUND / MAX / MIN / ABS
 */
export function evaluateFormula(
  expr: string,
  context: Record<string, unknown>
): FormulaValue {
  if (!expr || !expr.trim()) return '';
  try {
    const tokens = tokenize(expr);
    let pos = 0;

    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];

    function parseComparison(): FormulaValue {
      let left = parseAddSub();
      while (peek()?.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes((peek() as { value: string }).value)) {
        const op = (consume() as { value: string }).value;
        const right = parseAddSub();
        switch (op) {
          case '>':
            left = toNum(left) > toNum(right);
            break;
          case '<':
            left = toNum(left) < toNum(right);
            break;
          case '>=':
            left = toNum(left) >= toNum(right);
            break;
          case '<=':
            left = toNum(left) <= toNum(right);
            break;
          case '==':
            left = String(left) === String(right);
            break;
          case '!=':
            left = String(left) !== String(right);
            break;
        }
      }
      return left;
    }

    function parseAddSub(): FormulaValue {
      let left = parseMulDiv();
      while (peek()?.type === 'op' && ['+', '-'].includes((peek() as { value: string }).value)) {
        const op = (consume() as { value: string }).value;
        const right = parseMulDiv();
        if (op === '+') {
          if (typeof left === 'string' && Number.isNaN(Number(left))) {
            left = `${left}${right}`;
          } else {
            left = toNum(left) + toNum(right);
          }
        } else {
          left = toNum(left) - toNum(right);
        }
      }
      return left;
    }

    function parseMulDiv(): FormulaValue {
      let left = parseUnary();
      while (peek()?.type === 'op' && ['*', '/', '%'].includes((peek() as { value: string }).value)) {
        const op = (consume() as { value: string }).value;
        const right = parseUnary();
        const rNum = toNum(right);
        if (op === '*') left = toNum(left) * rNum;
        else if (op === '/') left = rNum === 0 ? 0 : toNum(left) / rNum;
        else left = rNum === 0 ? 0 : toNum(left) % rNum;
      }
      return left;
    }

    function parseUnary(): FormulaValue {
      const t = peek();
      if (t?.type === 'op' && t.value === '-') {
        consume();
        return -toNum(parseUnary());
      }
      if (t?.type === 'op' && t.value === '+') {
        consume();
        return toNum(parseUnary());
      }
      return parsePrimary();
    }

    function parsePrimary(): FormulaValue {
      const t = peek();
      if (!t) return 0;

      if (t.type === 'num' || t.type === 'str') {
        consume();
        return t.value;
      }

      if (t.type === 'paren' && t.value === '(') {
        consume();
        const val = parseComparison();
        if (peek()?.type === 'paren' && (peek() as { value: string }).value === ')') {
          consume();
        }
        return val;
      }

      if (t.type === 'ident') {
        consume();
        const name = t.value;
        const upper = name.toUpperCase();

        if (upper === 'TRUE') return true;
        if (upper === 'FALSE') return false;

        // Function call
        if (peek()?.type === 'paren' && (peek() as { value: string }).value === '(') {
          consume(); // '('
          const args: FormulaValue[] = [];
          if (!(peek()?.type === 'paren' && (peek() as { value: string }).value === ')')) {
            args.push(parseComparison());
            while (peek()?.type === 'comma') {
              consume();
              args.push(parseComparison());
            }
          }
          if (peek()?.type === 'paren' && (peek() as { value: string }).value === ')') {
            consume();
          }
          return evalBuiltinFn(upper, args);
        }

        // Context field lookup
        const raw = context[name];
        if (raw === undefined || raw === null || raw === '') return 0;
        if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
        if (typeof raw === 'string') {
          const asNum = Number(raw);
          return !Number.isNaN(asNum) && raw.trim() !== '' ? asNum : raw;
        }
        if (Array.isArray(raw)) return raw.length;
        return 0;
      }

      consume();
      return 0;
    }

    function evalBuiltinFn(fnName: string, args: FormulaValue[]): FormulaValue {
      switch (fnName) {
        case 'TODAY':
          return formatLocalDate();
        case 'DAYS_UNTIL': {
          const diff = daysBetweenTodayAnd(args[0]);
          return diff ?? 0;
        }
        case 'DAYS_SINCE': {
          const diff = daysBetweenTodayAnd(args[0]);
          return diff === null ? 0 : Math.max(0, -diff);
        }
        case 'ROUND': {
          const val = toNum(args[0] ?? 0);
          const digits = Math.max(0, Math.min(6, Math.floor(toNum(args[1] ?? 2))));
          const factor = 10 ** digits;
          return Math.round(val * factor) / factor;
        }
        case 'MAX':
          return args.length ? Math.max(...args.map(toNum)) : 0;
        case 'MIN':
          return args.length ? Math.min(...args.map(toNum)) : 0;
        case 'ABS':
          return Math.abs(toNum(args[0] ?? 0));
        case 'IF': {
          const cond = Boolean(args[0]);
          return cond ? (args[1] ?? '') : (args[2] ?? '');
        }
        default:
          return 0;
      }
    }

    const result = parseComparison();
    if (typeof result === 'number') {
      return Math.round(result * 100) / 100;
    }
    return result;
  } catch {
    return '';
  }
}

export interface EvaluatedHighlight {
  tone: HighlightTone;
  badgeText?: string;
}

const TONE_PRIORITY: Record<HighlightTone, number> = {
  danger: 4,
  warning: 3,
  info: 2,
  success: 1,
};

export function evaluateHighlightRules(
  rules: HighlightRule[] | undefined,
  record: Record<string, unknown>
): EvaluatedHighlight | null {
  if (!rules || rules.length === 0) return null;

  let best: EvaluatedHighlight | null = null;

  for (const rule of rules) {
    const rawVal = record[rule.fieldKey];
    let matched = false;

    switch (rule.operator) {
      case 'lt':
        matched = rawVal !== undefined && rawVal !== '' && Number(rawVal) < Number(rule.value);
        break;
      case 'lte':
        matched = rawVal !== undefined && rawVal !== '' && Number(rawVal) <= Number(rule.value);
        break;
      case 'gt':
        matched = rawVal !== undefined && rawVal !== '' && Number(rawVal) > Number(rule.value);
        break;
      case 'gte':
        matched = rawVal !== undefined && rawVal !== '' && Number(rawVal) >= Number(rule.value);
        break;
      case 'eq':
        matched = String(rawVal ?? '') === String(rule.value ?? '');
        break;
      case 'contains':
        matched = String(rawVal ?? '').toLowerCase().includes(String(rule.value ?? '').toLowerCase());
        break;
      case 'is_true':
        matched = Boolean(rawVal) === true;
        break;
      case 'days_until_lt': {
        const days = daysBetweenTodayAnd(rawVal);
        matched = days !== null && days < Number(rule.value ?? 30);
        break;
      }
    }

    if (matched) {
      if (!best || TONE_PRIORITY[rule.tone] > TONE_PRIORITY[best.tone]) {
        best = { tone: rule.tone, badgeText: rule.badgeText };
      }
    }
  }

  return best;
}
