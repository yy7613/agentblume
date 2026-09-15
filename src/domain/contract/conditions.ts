/**
 * ドメイン: 決定的な基準（`condition`）の比較（docs/23 §4.2）。
 *
 * 値が無いパスの比較は合否を出さず `field-missing` を返す（「上限額が読めなかった」を「基準に合わない」と
 * 取り違えないため）。`exists` / `notExists` だけは値の有無そのものを見るので合否を出す。
 */

export const CONDITION_OPS = ['equals', 'notEquals', 'in', 'notIn', 'gte', 'lte', 'exists', 'notExists', 'isTrue', 'isFalse', 'contains'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export type ConditionScalar = string | number | boolean;

export interface Condition {
  readonly field: string;
  readonly op: ConditionOp;
  /** `exists` / `notExists` / `isTrue` / `isFalse` は値を持たない。`in` / `notIn` は配列。 */
  readonly value?: ConditionScalar | readonly ConditionScalar[];
}

export type ConditionOutcome = 'pass' | 'fail' | 'field-missing';

export function isConditionOp(value: unknown): value is ConditionOp {
  return typeof value === 'string' && (CONDITION_OPS as readonly string[]).includes(value);
}

const VALUELESS: ReadonlySet<ConditionOp> = new Set(['exists', 'notExists', 'isTrue', 'isFalse']);

/** 演算子に対して値の形が正しいか（保存時の検証）。正しければ undefined。 */
export function conditionValueProblem(condition: Condition): string | undefined {
  const { op, value } = condition;
  const scalar = (raw: unknown) => typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean';
  if (VALUELESS.has(op)) return value === undefined ? undefined : `${op} takes no value`;
  if (op === 'in' || op === 'notIn') return Array.isArray(value) && value.length > 0 && value.every(scalar) ? undefined : `${op} needs a non-empty array of values`;
  if (op === 'gte' || op === 'lte') return typeof value === 'number' && Number.isFinite(value) ? undefined : `${op} needs a number`;
  if (op === 'contains') return typeof value === 'string' && value !== '' ? undefined : 'contains needs a non-empty string';
  return scalar(value) ? undefined : `${op} needs a value`;
}

/** 1 条件を評価する。`actual` が undefined は「値が無い」。 */
export function evaluateCondition(condition: Condition, actual: ConditionScalar | undefined): ConditionOutcome {
  const { op, value } = condition;
  if (op === 'exists') return actual === undefined ? 'fail' : 'pass';
  if (op === 'notExists') return actual === undefined ? 'pass' : 'fail';
  if (actual === undefined) return 'field-missing';
  const verdict = (ok: boolean): ConditionOutcome => ok ? 'pass' : 'fail';
  switch (op) {
    case 'equals': return verdict(actual === value);
    case 'notEquals': return verdict(actual !== value);
    case 'in': return verdict(Array.isArray(value) && value.includes(actual));
    case 'notIn': return verdict(Array.isArray(value) && !value.includes(actual));
    case 'gte': return typeof actual === 'number' && typeof value === 'number' ? verdict(actual >= value) : 'field-missing';
    case 'lte': return typeof actual === 'number' && typeof value === 'number' ? verdict(actual <= value) : 'field-missing';
    case 'isTrue': return typeof actual === 'boolean' ? verdict(actual) : 'field-missing';
    case 'isFalse': return typeof actual === 'boolean' ? verdict(!actual) : 'field-missing';
    case 'contains': return typeof actual === 'string' && typeof value === 'string' ? verdict(actual.normalize('NFKC').includes(value.normalize('NFKC'))) : 'field-missing';
  }
}
