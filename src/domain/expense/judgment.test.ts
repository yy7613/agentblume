import { describe, expect, it } from 'vitest';
import { ExpenseDomainError } from './errors';
import { allReasons, reasonKey, validateStoredJudgment, verdictOf, type StoredClaimJudgment } from './judgment';

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function stored(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'returned',
    items: [{ itemId: 'i1', verdict: 'returned', reasons: [{ code: 'amount-missing', severity: 'return', itemId: 'i1', params: { amount: null, ok: true, n: 1 }, searchKey: 'amount' }] }],
    claimReasons: [{ code: 'policy-unreviewed', severity: 'review', params: {} }],
    totals: { amount: 1000, byCategory: [{ categoryId: 'taxi', amount: 1000 }] },
    searchKeysComplete: false,
    policyUpdatedAt: '2026-09-14T00:00:00.000Z',
    itemsFingerprint: 'fp',
    checkedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('verdictOf', () => {
  it('正常: 理由なしは pass', () => {
    expect(verdictOf([])).toBe('pass');
  });

  it('正常: review だけなら needs-review', () => {
    expect(verdictOf([{ severity: 'review' }, { severity: 'review' }])).toBe('needs-review');
  });

  it('正常: return が 1 件でもあれば returned', () => {
    expect(verdictOf([{ severity: 'review' }, { severity: 'return' }])).toBe('returned');
  });
});

describe('allReasons / reasonKey', () => {
  it('正常: 申請の理由 → 明細順に並べる', () => {
    const judgment = validateStoredJudgment(stored(), 'judgment', fail);
    expect(allReasons(judgment).map((reason) => reason.code)).toEqual(['policy-unreviewed', 'amount-missing']);
  });

  it('正常: 申請単位の理由は itemId 空で鍵を作る', () => {
    // 区切りは明細 id に現れない文字（空の itemId と連結しても別の明細の鍵と衝突しない）
    expect(reasonKey('claim-empty', undefined)).toBe(reasonKey('claim-empty', ''));
    expect(reasonKey('amount-missing', 'i1')).not.toBe(reasonKey('amount-missing', 'i2'));
    expect(reasonKey('amount-missing', 'i1').endsWith('amount-missing')).toBe(true);
    expect(reasonKey('amount-missing', 'i1').startsWith('i1')).toBe(true);
  });
});

describe('validateStoredJudgment', () => {
  it('正常: 保存済みの判定を複製して返す（未知のキーは落とす）', () => {
    const value = stored({ extra: 'x' });
    const result: StoredClaimJudgment = validateStoredJudgment(value, 'judgment', fail);
    expect(result).toEqual(stored());
    expect(result.items).not.toBe(value['items']);
  });

  it.each([
    ['object でない', null, /judgment must be an object/u],
    ['verdict', stored({ verdict: 'ok' }), /verdict must be one of/u],
    ['items', stored({ items: {} }), /items must be an array/u],
    ['claimReasons', stored({ claimReasons: null }), /claimReasons must be an array/u],
    ['明細が object でない', stored({ items: [1] }), /items\[0\] must be an object/u],
    ['明細の itemId', stored({ items: [{ verdict: 'pass', reasons: [] }] }), /items\[0\]\.itemId must be a string/u],
    ['明細の verdict', stored({ items: [{ itemId: 'i', verdict: 'x', reasons: [] }] }), /items\[0\]\.verdict/u],
    ['明細の reasons', stored({ items: [{ itemId: 'i', verdict: 'pass' }] }), /reasons must be an array/u],
    ['理由が object でない', stored({ claimReasons: [null] }), /claimReasons\[0\] must be an object/u],
    ['理由コード', stored({ claimReasons: [{ code: 'x', severity: 'review', params: {} }] }), /code must be a reason code/u],
    ['重さ', stored({ claimReasons: [{ code: 'claim-empty', severity: 'off', params: {} }] }), /severity must be review or return/u],
    ['理由の itemId', stored({ claimReasons: [{ code: 'claim-empty', severity: 'return', itemId: 1, params: {} }] }), /itemId must be a string/u],
    ['params が配列', stored({ claimReasons: [{ code: 'claim-empty', severity: 'return', params: [] }] }), /params must be an object of primitive values/u],
    ['params に object', stored({ claimReasons: [{ code: 'claim-empty', severity: 'return', params: { x: {} } }] }), /params must be/u],
    ['searchKey', stored({ claimReasons: [{ code: 'claim-empty', severity: 'return', params: {}, searchKey: 'tax' }] }), /searchKey must be/u],
    ['totals', stored({ totals: { amount: '1', byCategory: [] } }), /totals must be/u],
    ['totals なし', stored({ totals: undefined }), /totals must be/u],
    ['byCategory の要素', stored({ totals: { amount: 1, byCategory: [{ categoryId: 1, amount: 1 }] } }), /byCategory\[0\]/u],
    ['searchKeysComplete', stored({ searchKeysComplete: 'no' }), /searchKeysComplete must be a boolean/u],
    ['policyUpdatedAt', stored({ policyUpdatedAt: 'x' }), /policyUpdatedAt/u],
    ['checkedAt', stored({ checkedAt: undefined }), /checkedAt/u],
    ['itemsFingerprint', stored({ itemsFingerprint: '' }), /itemsFingerprint must be a non-empty string/u],
  ])('異常: %s が不正なら渡した fail のエラーを投げる', (_label, value, message) => {
    expect(() => validateStoredJudgment(value, 'judgment', fail)).toThrow(ExpenseDomainError);
    expect(() => validateStoredJudgment(value, 'judgment', fail)).toThrow(message);
  });
});
