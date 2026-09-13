/**
 * ドメイン: ルール条件の評価（純関数）。
 *
 * `field` は facts のパス。`extra.<key>` と `lines[].<key>`（配列の**いずれかの要素**が満たせば真）を
 * 解決する。文字列の比較は NFKC 正規化 + 大文字小文字無視で行う（摘要の揺れを吸収するため）。
 */
import type { DocumentFacts, JsonValue } from './document';
import type { RuleCondition } from './rule';

/** パスが指す値。`lines[]` を含むパスは要素ごとの値の配列（array-any 意味論）を返す。 */
export type FactValue = JsonValue | undefined;

function readPath(root: unknown, segments: readonly string[]): FactValue | readonly FactValue[] {
  let current: unknown = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.endsWith('[]')) {
      const key = segment.slice(0, -2);
      const container = current === null || typeof current !== 'object' ? undefined : (current as Record<string, unknown>)[key];
      if (!Array.isArray(container)) return [];
      const rest = segments.slice(index + 1);
      return container.flatMap((element) => {
        const value = readPath(element, rest);
        return Array.isArray(value) ? (value as readonly FactValue[]) : [value as FactValue];
      });
    }
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current as FactValue;
}

/** facts からパスの値を読む。`lines[].description` は各行の値の配列。 */
export function readFactPath(facts: DocumentFacts, path: string): FactValue | readonly FactValue[] {
  const segments = path.trim().split('.').filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;
  return readPath(facts, segments);
}

/** パスが「値を持つ」か（`lines[]` は 1 要素でも値があれば真）。requiredFacts の判定に使う。 */
export function hasFact(facts: DocumentFacts, path: string): boolean {
  const value = readFactPath(facts, path);
  if (Array.isArray(value)) return (value as readonly FactValue[]).some((entry) => entry !== undefined && entry !== null && entry !== '');
  return value !== undefined && value !== null && value !== '';
}

function normalizeText(value: unknown): string {
  return String(value).normalize('NFKC').trim().toLowerCase();
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function equalsValue(actual: FactValue, expected: JsonValue | undefined): boolean {
  if (actual === undefined || actual === null || expected === undefined || expected === null) return actual === expected;
  if (typeof actual === 'number' && typeof expected === 'number') return actual === expected;
  if (typeof actual === 'boolean' || typeof expected === 'boolean') return actual === expected;
  if (isScalar(actual) && isScalar(expected)) return normalizeText(actual) === normalizeText(expected);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function compareOrdered(actual: FactValue, expected: JsonValue | undefined): number | undefined {
  if (typeof actual === 'number' && typeof expected === 'number') return actual - expected;
  if (typeof actual === 'string' && typeof expected === 'string') return actual < expected ? -1 : actual > expected ? 1 : 0;
  if (typeof actual === 'number' && typeof expected === 'string') { const parsed = Number(expected); return Number.isFinite(parsed) ? actual - parsed : undefined; }
  if (typeof actual === 'string' && typeof expected === 'number') { const parsed = Number(actual); return Number.isFinite(parsed) ? parsed - expected : undefined; }
  return undefined;
}

function evaluateScalar(actual: FactValue, condition: RuleCondition): boolean {
  const expected = condition.value;
  switch (condition.op) {
    case 'exists': return actual !== undefined && actual !== null && actual !== '';
    case 'notExists': return actual === undefined || actual === null || actual === '';
    case 'isTrue': return actual === true;
    case 'isFalse': return actual === false;
    case 'equals': return equalsValue(actual, expected);
    case 'contains': return isScalar(actual) && typeof expected === 'string' && normalizeText(actual).includes(normalizeText(expected));
    case 'startsWith': return isScalar(actual) && typeof expected === 'string' && normalizeText(actual).startsWith(normalizeText(expected));
    case 'endsWith': return isScalar(actual) && typeof expected === 'string' && normalizeText(actual).endsWith(normalizeText(expected));
    case 'regex': {
      if (!isScalar(actual) || typeof expected !== 'string') return false;
      try { return new RegExp(expected, 'iu').test(String(actual).normalize('NFKC')); } catch { return false; }
    }
    case 'gte': { const cmp = compareOrdered(actual, expected); return cmp !== undefined && cmp >= 0; }
    case 'lte': { const cmp = compareOrdered(actual, expected); return cmp !== undefined && cmp <= 0; }
    case 'between': {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const low = compareOrdered(actual, expected[0]);
      const high = compareOrdered(actual, expected[1]);
      return low !== undefined && high !== undefined && low >= 0 && high <= 0;
    }
    case 'in': return Array.isArray(expected) && expected.some((candidate) => equalsValue(actual, candidate));
    default: return false;
  }
}

/** 条件 1 つを評価する。`lines[]` パスは要素のいずれかが満たせば真（notExists は全要素が空のとき真）。 */
export function evaluateCondition(facts: DocumentFacts, condition: RuleCondition): boolean {
  const value = readFactPath(facts, condition.field);
  if (Array.isArray(value)) {
    const values = value as readonly FactValue[];
    if (condition.op === 'notExists') return values.every((entry) => evaluateScalar(entry, condition));
    return values.some((entry) => evaluateScalar(entry, condition));
  }
  return evaluateScalar(value as FactValue, condition);
}

/** 条件列（AND）をすべて満たすか。空は真。 */
export function evaluateConditions(facts: DocumentFacts, conditions: readonly RuleCondition[]): boolean {
  return conditions.every((condition) => evaluateCondition(facts, condition));
}
