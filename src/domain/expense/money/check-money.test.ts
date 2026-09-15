import { describe, expect, it } from 'vitest';
import { checkClaim } from '../check';
import { createExpenseClaim, type Claimant, type ExpenseItem } from '../claim';
import { defaultExpensePolicy } from '../default-policy';
import type { CheckReason } from '../judgment';
import { createExpensePolicy, type ExpensePolicy } from '../policy';
import { MONEY_REASON_CODES } from '../reason-codes';
import type { MoneyCardFacts, MoneyCheckFacts } from './check-facts';
import { advanceReasons, moneyContributor } from './check-money';

const AT = '2026-09-14T00:00:00.000Z';
const TARO: Claimant = { name: 'テスト太郎', employeeId: 'emp-taro' };

function item(id: string, facts: Partial<ExpenseItem['facts']> = {}): ExpenseItem {
  return {
    id, categoryId: 'transport.taxi', source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] }, addedOn: '2026-09-14',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプルマート 霞が関店', amount: 3200, description: 'タクシー代', purpose: '客先訪問', ...facts },
  };
}

function claim(items: readonly ExpenseItem[], overrides: { claimant?: Claimant; advanceId?: string } = {}) {
  return createExpenseClaim({
    tenant: { tenantId: 't', workspaceId: 'w' }, id: 'claim-1', claimant: overrides.claimant ?? TARO, period: { from: '2026-09-01', to: '2026-09-30' },
    items, acknowledgements: [], history: [{ type: 'created', by: 'u', at: AT }], submittedBy: 'u', createdAt: AT, updatedAt: AT,
    ...(overrides.advanceId === undefined ? {} : { advanceId: overrides.advanceId }),
  });
}

function policyWith(card: Partial<ExpensePolicy['card']> = {}, severityOverrides: ExpensePolicy['severityOverrides'] = {}): ExpensePolicy {
  const base = defaultExpensePolicy();
  return createExpensePolicy({ ...base, card: { ...base.card, ...card }, severityOverrides });
}

const cards: MoneyCardFacts['cards'] = [
  { id: 'card-sales', label: '営業用カード', last4: '1111', holderEmployeeId: 'emp-taro' },
  { id: 'card-hanako', label: '花子のカード', last4: '3333', holderEmployeeId: 'emp-hanako' },
  { id: 'card-shared', label: '共用カード', last4: '2222' },
];

function cardFacts(overrides: Partial<MoneyCardFacts> = {}): MoneyCardFacts {
  return {
    cards,
    transactions: [{ id: 'tx-1', cardId: 'card-sales', usedOn: '2026-09-10', merchantRaw: 'サンプルマート 霞が関店', merchantKey: 'サンプルマート霞が関店', amount: 3200 }],
    coverage: [{ cardId: 'card-sales', from: '2026-09-01', to: '2026-09-30' }],
    ...overrides,
  };
}

function moneyReasons(items: readonly ExpenseItem[], money: MoneyCheckFacts | undefined, policy = policyWith(), claimant?: Claimant): readonly CheckReason[] {
  const judgment = checkClaim({ claim: claim(items, claimant === undefined ? {} : { claimant }), policy, policySaved: true, duplicateCandidates: [], today: '2026-09-30', ...(money === undefined ? {} : { extensions: { money } }) });
  const money16 = new Set<string>(MONEY_REASON_CODES);
  return [...judgment.claimReasons, ...judgment.items.flatMap((entry) => entry.reasons)].filter((reason) => money16.has(reason.code));
}

describe('moneyContributor: 仮払（申請の理由）', () => {
  const advance = { id: 'adv-1', employeeId: 'emp-taro', employeeName: 'テスト太郎', status: 'paid', settledClaimIds: [] as string[] };
  const claimed = (claimant: Claimant | undefined) => ({ id: 'claim-1', advanceId: 'adv-1', ...(claimant === undefined ? {} : { claimant }) });

  it('正常: 支払済みの本人の仮払なら何も出さない。仮払の事実が無い・別の仮払の事実なら何も出さない', () => {
    expect(advanceReasons(claimed(TARO), advance)).toEqual([]);
    expect(advanceReasons(claimed(TARO), undefined)).toEqual([]);
    expect(advanceReasons({ id: 'claim-1', claimant: TARO }, advance)).toEqual([]);
    expect(advanceReasons({ ...claimed(TARO), advanceId: 'adv-other' }, advance)).toEqual([]);
  });

  it('異常: 申請者が違う（未紐付けを含む）なら advance-employee-mismatch だけを出し、状態の理由は重ねない', () => {
    expect(advanceReasons(claimed({ name: 'テスト花子', employeeId: 'emp-hanako' }), { ...advance, status: 'requested' })).toEqual([
      { code: 'advance-employee-mismatch', params: { advanceId: 'adv-1', advanceEmployee: 'テスト太郎', employeeId: 'emp-taro' } },
    ]);
    expect(advanceReasons(claimed({ name: 'テスト太郎' }), advance).map((reason) => reason.code)).toEqual(['advance-employee-mismatch']);
  });

  it('異常: 別の申請で精算済み・精算中なら advance-already-settled（advance-not-paid は出さない）。この申請を含む精算なら出さない', () => {
    expect(advanceReasons(claimed(TARO), { ...advance, status: 'settled', settledOn: '2026-09-20', settledClaimIds: ['claim-0'] })).toEqual([{ code: 'advance-already-settled', params: { advanceId: 'adv-1', settledOn: '2026-09-20' } }]);
    expect(advanceReasons(claimed(TARO), { ...advance, status: 'settling', settledClaimIds: [] })).toEqual([{ code: 'advance-already-settled', params: { advanceId: 'adv-1', settledOn: '' } }]);
    expect(advanceReasons(claimed(TARO), { ...advance, status: 'settled', settledOn: '2026-09-20', settledClaimIds: ['claim-1'] })).toEqual([]);
  });

  it('異常: 申請中・承認済み・取消なら advance-not-paid（状態はコードのまま）', () => {
    for (const status of ['requested', 'approved', 'cancelled']) {
      expect(advanceReasons(claimed(TARO), { ...advance, status })).toEqual([{ code: 'advance-not-paid', params: { advanceId: 'adv-1', advanceStatus: status } }]);
    }
  });

  it('正常: checkClaim に差し込むと明細が無い申請でも出て、既定の重さ（mismatch は差し戻し・not-paid は要確認）になる', () => {
    const judgment = checkClaim({ claim: claim([], { advanceId: 'adv-1' }), policy: policyWith(), policySaved: true, duplicateCandidates: [], today: '2026-09-30', extensions: { money: { advance: { ...advance, status: 'approved' } } } });
    expect(judgment.claimReasons.map((reason) => [reason.code, reason.severity])).toEqual([['advance-not-paid', 'review'], ['claim-empty', 'return']]);
  });
});

describe('moneyContributor: カード（明細の理由）', () => {
  it('正常: 事実が無い（カード未登録）なら MVP と同じく何も出さない', () => {
    expect(moneyReasons([item('i1')], undefined)).toEqual([]);
    expect(moneyReasons([item('i1')], {})).toEqual([]);
    expect(moneyContributor.codes).toEqual(MONEY_REASON_CODES);
  });

  it('異常: 立替の明細が加盟店名も一致するカード利用と一致したら card-charge-claimed（差し戻し）と差し込み値', () => {
    const [reason] = moneyReasons([item('i1')], { card: cardFacts() });
    expect(reason).toMatchObject({ code: 'card-charge-claimed', severity: 'return', itemId: 'i1' });
    expect(reason?.params).toMatchObject({ cardLabel: '営業用カード', usedOn: '2026-09-10', merchant: 'サンプルマート 霞が関店', cardAmount: 3200, weak: false, dateDiffDays: 0, cardTransactionId: 'tx-1' });
  });

  it('異常: 加盟店名が一致しない弱い一致は、規程の重さに関係なく要確認で weak を付ける', () => {
    const [reason] = moneyReasons([item('i1', { payeeName: '別の店' })], { card: cardFacts() }, policyWith({}, { 'card-charge-claimed': 'return' }));
    expect(reason).toMatchObject({ code: 'card-charge-claimed', severity: 'review', params: expect.objectContaining({ weak: true }) });
  });

  it('正常: 規程で card-charge-claimed を要確認にした重さが効く', () => {
    expect(moneyReasons([item('i1')], { card: cardFacts() }, policyWith({}, { 'card-charge-claimed': 'review' }))[0]?.severity).toBe('review');
  });

  it('境界: 取引日か金額が無い明細は照合しない', () => {
    expect(moneyReasons([item('i1', { transactionDate: undefined })], { card: cardFacts() })).toEqual([]);
    expect(moneyReasons([item('i1', { amount: undefined })], { card: cardFacts() })).toEqual([]);
  });

  it('正常: 1 対 1。同じカード利用に一致しうる明細が 2 件でも理由は 1 件だけ（強い一致の方）', () => {
    const reasons = moneyReasons([item('i1', { payeeName: '別の店' }), item('i2')], { card: cardFacts() });
    expect(reasons.map((reason) => reason.itemId)).toEqual(['i2']);
  });

  it('正常: 手動の紐付けは自動の割り当てより先に確定する（加盟店名が違っても強い一致として出す）', () => {
    const facts = cardFacts({ transactions: [{ id: 'tx-9', cardId: 'card-shared', usedOn: '2026-09-12', merchantRaw: '別名', merchantKey: '別名', amount: 3000, manualItemId: 'i1' }] });
    expect(moneyReasons([item('i1')], { card: facts })[0]).toMatchObject({ code: 'card-charge-claimed', severity: 'return', params: expect.objectContaining({ cardTransactionId: 'tx-9', cardLabel: '共用カード', weak: false, dateDiffDays: 2 }) });
  });

  it('正常: 会社払いの明細はカード利用と一致すれば何も出さない（受け入れる運用）', () => {
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: cardFacts() }, policyWith({ acceptCorporatePaymentItems: true }))).toEqual([]);
  });

  it('異常: 会社払いの明細（受け入れる運用）で一致が無く、取引日が申請者のカードの取込範囲に入れば corporate-payment-unmatched（要確認）', () => {
    const facts = cardFacts({ transactions: [], coverage: [{ cardId: 'card-sales', from: '2026-09-01', to: '2026-09-30' }, { cardId: 'card-shared', from: '2026-08-01', to: '2026-09-15' }, { cardId: 'card-hanako', from: '2026-01-01', to: '2026-12-31' }] });
    const [reason] = moneyReasons([item('i1', { corporatePayment: true })], { card: facts }, policyWith({ acceptCorporatePaymentItems: true }));
    expect(reason).toMatchObject({ code: 'corporate-payment-unmatched', severity: 'review', params: { coverage: '2026-09-01〜2026-09-30、2026-08-01〜2026-09-15', description: 'タクシー代' } });
  });

  it('境界: 取込範囲の外（まだ明細を取り込んでいない月）・他人のカードだけの範囲・受け入れない運用では出さない', () => {
    const outside = cardFacts({ transactions: [], coverage: [{ cardId: 'card-sales', from: '2026-08-01', to: '2026-09-09' }] });
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: outside }, policyWith({ acceptCorporatePaymentItems: true }))).toEqual([]);
    const others = cardFacts({ transactions: [], coverage: [{ cardId: 'card-hanako', from: '2026-09-01', to: '2026-09-30' }] });
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: others }, policyWith({ acceptCorporatePaymentItems: true }))).toEqual([]);
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: cardFacts({ transactions: [] }) })).toEqual([]);
  });

  it('正常: 申請者が従業員に紐付いていなければ共用カードの取込範囲だけで判断する', () => {
    const facts = cardFacts({ transactions: [], coverage: [{ cardId: 'card-sales', from: '2026-09-01', to: '2026-09-30' }] });
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: facts }, policyWith({ acceptCorporatePaymentItems: true }), { name: 'テスト太郎' })).toEqual([]);
    const shared = cardFacts({ transactions: [], coverage: [{ cardId: 'card-shared', from: '2026-09-01', to: '2026-09-30' }] });
    expect(moneyReasons([item('i1', { corporatePayment: true })], { card: shared }, policyWith({ acceptCorporatePaymentItems: true }), { name: 'テスト太郎' })).toHaveLength(1);
  });

  it('正常: 保有者の違うカードの利用は立替の明細と照合しない', () => {
    const facts = cardFacts({ transactions: [{ id: 'tx-2', cardId: 'card-hanako', usedOn: '2026-09-10', merchantRaw: 'サンプルマート 霞が関店', merchantKey: 'サンプルマート霞が関店', amount: 3200 }] });
    expect(moneyReasons([item('i1')], { card: facts })).toEqual([]);
  });

  it('正常: itemReasons は申請を渡されなければ何も出さない', () => {
    const evaluation = { item: item('i1'), index: 0, description: 'x', amount: 3200, date: '2026-09-10', emitted: new Set<never>() };
    expect(moneyContributor.itemReasons?.(evaluation, policyWith(), { money: { card: cardFacts() } })).toEqual([]);
  });
});
