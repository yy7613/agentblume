import { describe, expect, it } from 'vitest';
import { conditionValueProblem, evaluateCondition, isConditionOp, type Condition, type ConditionOp } from './conditions';

const cond = (op: ConditionOp, value?: Condition['value']): Condition => ({ field: 'x', op, ...(value === undefined ? {} : { value }) });

describe('conditions: evaluateCondition', () => {
  it.each([
    ['equals', 'us', 'us', 'pass'], ['equals', 'us', 'counterparty', 'fail'],
    ['notEquals', 'us', 'counterparty', 'pass'], ['notEquals', 'us', 'us', 'fail'],
    ['in', ['prior_consent', 'prohibited'], 'prohibited', 'pass'], ['in', ['prior_consent', 'prohibited'], 'free', 'fail'],
    ['notIn', ['free'], 'notify', 'pass'], ['notIn', ['free'], 'free', 'fail'],
    ['gte', 12, 12, 'pass'], ['gte', 12, 11, 'fail'],
    ['lte', 90, 90, 'pass'], ['lte', 90, 91, 'fail'],
    ['isTrue', undefined, true, 'pass'], ['isTrue', undefined, false, 'fail'],
    ['isFalse', undefined, false, 'pass'], ['isFalse', undefined, true, 'fail'],
    ['contains', '東京', '東京地方裁判所', 'pass'], ['contains', '東京', '大阪地方裁判所', 'fail'],
    ['contains', 'ABC', 'ＡＢＣ地方裁判所', 'pass'],
  ] as const)('正常: %s %o に対し実値 %o → %s', (op, value, actual, expected) => {
    expect(evaluateCondition(cond(op, value as Condition['value']), actual)).toBe(expected);
  });

  it.each([
    ['exists', 'x', 'pass'], ['exists', undefined, 'fail'], ['notExists', undefined, 'pass'], ['notExists', 'x', 'fail'],
  ] as const)('境界: %s は値の有無そのものを見る（実値 %o → %s）', (op, actual, expected) => {
    expect(evaluateCondition(cond(op), actual)).toBe(expected);
  });

  it.each(['equals', 'notEquals', 'in', 'notIn', 'gte', 'lte', 'isTrue', 'isFalse', 'contains'] as const)('異常: %s は値が無ければ合否を出さず field-missing', (op) => {
    expect(evaluateCondition(cond(op, 1), undefined)).toBe('field-missing');
  });

  it.each([
    ['gte', 12, '12'], ['lte', 12, true], ['isTrue', undefined, 'yes'], ['isFalse', undefined, 0], ['contains', 'a', 1],
  ] as const)('例外: %s の型が合わない実値 %o は field-missing（不合格と取り違えない）', (op, value, actual) => {
    expect(evaluateCondition(cond(op, value as Condition['value']), actual)).toBe('field-missing');
  });

  it('例外: in / notIn の値が配列でなければ不合格として扱う', () => {
    expect(evaluateCondition(cond('in', 'x'), 'x')).toBe('fail');
    expect(evaluateCondition(cond('notIn', 'x'), 'y')).toBe('fail');
  });
});

describe('conditions: conditionValueProblem / isConditionOp', () => {
  it.each([
    [cond('exists'), undefined], [cond('isTrue', true), 'isTrue takes no value'],
    [cond('in', ['a']), undefined], [cond('in', []), 'in needs a non-empty array of values'], [cond('notIn', 'a'), 'notIn needs a non-empty array of values'],
    [{ field: 'x', op: 'in', value: [{}] } as unknown as Condition, 'in needs a non-empty array of values'],
    [cond('gte', 1), undefined], [cond('lte', '1'), 'lte needs a number'], [cond('gte', Number.POSITIVE_INFINITY), 'gte needs a number'],
    [cond('contains', 'a'), undefined], [cond('contains', ''), 'contains needs a non-empty string'],
    [cond('equals', false), undefined], [cond('equals'), 'equals needs a value'], [cond('notEquals', ['a']), 'notEquals needs a value'],
  ])('境界: %o → %s', (condition, expected) => {
    expect(conditionValueProblem(condition)).toBe(expected);
  });

  it.each([['equals', true], ['contains', true], ['startsWith', false], [1, false]])('境界: isConditionOp(%s) = %s', (value, expected) => {
    expect(isConditionOp(value)).toBe(expected);
  });
});
