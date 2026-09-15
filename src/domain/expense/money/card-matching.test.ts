import { describe, expect, it } from 'vitest';
import { cardItemKey, cardMatchStrength, dateInRanges, matchCardTransactions, type CardMatchItem, type CardMatchTransaction } from './card-matching';

const tolerance = { dateToleranceDays: 3, amountToleranceYen: 0, weakMatchMinAmount: 3000 };

function tx(id: string, overrides: Partial<CardMatchTransaction> = {}): CardMatchTransaction {
  return { id, cardId: 'card-a', usedOn: '2026-09-10', merchantKey: 'サンプルマート霞が関店', amount: 3200, ...overrides };
}

function item(itemId: string, overrides: Partial<CardMatchItem> = {}): CardMatchItem {
  return { claimId: 'claim-1', itemId, transactionDate: '2026-09-10', amount: 3200, payeeKey: 'サンプルマート霞が関店', corporate: false, ...overrides };
}

function match(transactions: readonly CardMatchTransaction[], items: readonly CardMatchItem[], overrides: Partial<typeof tolerance> = {}, cards: readonly { id: string; holderEmployeeId?: string }[] = []) {
  return matchCardTransactions({ transactions, items, cards, tolerance: { ...tolerance, ...overrides } });
}

describe('cardMatchStrength', () => {
  it('正常: キーが等しければ strong、一方が他方を含み短い方が 3 文字以上なら strong', () => {
    expect(cardMatchStrength('abc', 'abc', 1, 3000)).toBe('strong');
    expect(cardMatchStrength('サンプルマート', 'サンプルマート霞が関店', 1, 3000)).toBe('strong');
    expect(cardMatchStrength('サンプルマート霞が関店', 'マート', 1, 3000)).toBe('strong');
  });

  it('境界: 短い方が 2 文字なら包含でも strong にせず、金額が最低金額以上なら weak・未満なら組にしない', () => {
    expect(cardMatchStrength('ab', 'abc', 3000, 3000)).toBe('weak');
    expect(cardMatchStrength('ab', 'abc', 2999, 3000)).toBeUndefined();
    expect(cardMatchStrength('タクシー', 'ホテル', 3000, 3000)).toBe('weak');
    expect(cardMatchStrength('タクシー', 'ホテル', 2999, 3000)).toBeUndefined();
  });

  it('正常: どちらかのキーが空なら金額に関係なく weak', () => {
    expect(cardMatchStrength('', 'abc', 1, 3000)).toBe('weak');
    expect(cardMatchStrength('abc', undefined, 1, 3000)).toBe('weak');
    expect(cardMatchStrength(undefined, undefined, 1, 3000)).toBe('weak');
  });
});

describe('matchCardTransactions', () => {
  it('正常: 立替の明細と一致すれば reimbursement-item、会社払いの明細なら corporate-item', () => {
    expect(match([tx('t1')], [item('i1')])).toEqual([{ transactionId: 't1', claimId: 'claim-1', itemId: 'i1', kind: 'reimbursement-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0 }]);
    expect(match([tx('t1')], [item('i1', { corporate: true })])[0]?.kind).toBe('corporate-item');
  });

  it('境界: 日付の許容 3 日は 3 日ずれで一致し 4 日ずれで一致しない（前後どちらも）', () => {
    expect(match([tx('t1', { usedOn: '2026-09-13' })], [item('i1')])[0]?.dateDiffDays).toBe(3);
    expect(match([tx('t1', { usedOn: '2026-09-07' })], [item('i1')])[0]?.dateDiffDays).toBe(-3);
    expect(match([tx('t1', { usedOn: '2026-09-14' })], [item('i1')])).toEqual([]);
    expect(match([tx('t1', { usedOn: '2026-09-06' })], [item('i1')])).toEqual([]);
  });

  it('境界: 金額の許容 0 円は 1 円違いで一致しない。許容 10 円なら 10 円差は一致・11 円差は一致しない', () => {
    expect(match([tx('t1', { amount: 3201 })], [item('i1')])).toEqual([]);
    expect(match([tx('t1', { amount: 3210 })], [item('i1')], { amountToleranceYen: 10 })[0]?.amountDiff).toBe(10);
    expect(match([tx('t1', { amount: 3189 })], [item('i1')], { amountToleranceYen: 10 })).toEqual([]);
  });

  it('例外: 返金（負の金額）・金額 0 の明細は照合しない', () => {
    expect(match([tx('t1', { amount: -3200 })], [item('i1', { amount: -3200 })], { amountToleranceYen: 0 })).toEqual([]);
    expect(match([tx('t1', { amount: 0 })], [item('i1', { amount: 0 })])).toEqual([]);
  });

  it('正常: カードの保有者と申請者が両方あって違えば除外し、共用カード（保有者なし）や未紐付けの申請者は照合する', () => {
    const cards = [{ id: 'card-a', holderEmployeeId: 'emp-taro' }, { id: 'card-shared' }];
    expect(match([tx('t1')], [item('i1', { employeeId: 'emp-hanako' })], {}, cards)).toEqual([]);
    expect(match([tx('t1')], [item('i1', { employeeId: 'emp-taro' })], {}, cards)).toHaveLength(1);
    expect(match([tx('t1')], [item('i1')], {}, cards)).toHaveLength(1);
    expect(match([tx('t1', { cardId: 'card-shared' })], [item('i1', { employeeId: 'emp-hanako' })], {}, cards)).toHaveLength(1);
    // 設定に無いカードは共用として扱う。
    expect(match([tx('t1', { cardId: 'card-unknown' })], [item('i1', { employeeId: 'emp-hanako' })], {}, cards)).toHaveLength(1);
  });

  it('正常: 1 対 1。強い一致 → 日付差 → 金額差の順で先に採り、使ったカード利用・明細は二度使わない', () => {
    const assignments = match(
      [tx('t1'), tx('t2', { usedOn: '2026-09-11' })],
      [item('i-weak', { payeeKey: '別の店' }), item('i-strong'), item('i-near', { transactionDate: '2026-09-11' })],
    );
    expect(assignments.map((entry) => [entry.transactionId, entry.itemId, entry.strength])).toEqual([['t1', 'i-strong', 'strong'], ['t2', 'i-near', 'strong']]);
  });

  it('境界: 同点（強さ・日付差・金額差・利用日が同じ）はカード利用 id → 申請 id → 明細 id の昇順で決まる（入力の順に依らない）', () => {
    const items = [item('i2', { claimId: 'claim-b' }), item('i1', { claimId: 'claim-b' }), item('i9', { claimId: 'claim-a' })];
    const forward = match([tx('t2'), tx('t1')], items);
    const reversed = match([tx('t1'), tx('t2')], [...items].reverse());
    expect(forward).toEqual(reversed);
    expect(forward.map((entry) => [entry.transactionId, entry.claimId, entry.itemId])).toEqual([['t1', 'claim-a', 'i9'], ['t2', 'claim-b', 'i1']]);
  });

  it('境界: 金額の差が小さい方を先に採る（許容差の中）', () => {
    const assignments = match([tx('t1', { amount: 3205 })], [item('i-far', { amount: 3195 }), item('i-near', { amount: 3203 })], { amountToleranceYen: 10 });
    expect(assignments.map((entry) => entry.itemId)).toEqual(['i-near']);
  });
});

describe('cardItemKey / dateInRanges', () => {
  it('正常: 明細キーは申請 id と明細 id の組で区別し、区間は両端を含む', () => {
    expect(cardItemKey('a', 'b')).not.toBe(cardItemKey('ab', ''));
    expect(dateInRanges('2026-09-01', [{ from: '2026-09-01', to: '2026-09-30' }])).toBe(true);
    expect(dateInRanges('2026-09-30', [{ from: '2026-09-01', to: '2026-09-30' }])).toBe(true);
    expect(dateInRanges('2026-10-01', [{ from: '2026-09-01', to: '2026-09-30' }])).toBe(false);
    expect(dateInRanges('2026-10-01', [])).toBe(false);
  });
});
