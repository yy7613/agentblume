/**
 * 判定の拡張点（docs/21 §20.3.1）: 系統の検査関数の差し込み・並び・コードの集合・重さ。
 * 既存の判定の期待値は `check.test.ts`（変えない）。ここは contributor を差し替えて骨格の規律だけを見る。
 */
import { describe, expect, it } from 'vitest';
import { checkClaim } from './check';
import { EXPENSE_CHECK_CONTRIBUTORS } from './check-contributors';
import { mergeCheckExtensions, type ExpenseCheckContributor, type ItemEvaluation, type ReasonDraft } from './check-extensions';
import type { ExpenseItem } from './claim';
import { defaultExpensePolicy } from './default-policy';
import { ExpenseDomainError } from './errors';
import { createExpensePolicy } from './policy';
import { INPUT_REASON_CODES, MONEY_REASON_CODES, MVP_REASON_CODES, PEOPLE_REASON_CODES, REASON_CODES } from './reason-codes';

const policy = defaultExpensePolicy('2026-09-14T00:00:00.000Z');
const period = { from: '2026-09-01', to: '2026-09-30' };

function item(id: string, facts: Partial<ExpenseItem['facts']> = {}): ExpenseItem {
  return { id, categoryId: 'transport.public', facts: { transactionDate: '2026-09-10', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', ...facts }, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } };
}

const judge = (items: readonly ExpenseItem[], contributors: readonly ExpenseCheckContributor[], extra: Partial<Parameters<typeof checkClaim>[0]> = {}) =>
  checkClaim({ claim: { id: 'c1', period, items, claimant: { name: 'テスト太郎' } }, policy, policySaved: false, duplicateCandidates: [], today: '2026-09-30', contributors, ...extra });

describe('EXPENSE_CHECK_CONTRIBUTORS', () => {
  it('正常: 3 系統のコードは互いに素で、和が実用化の 16 コード（既存 27 コードを含まない）', () => {
    const all = EXPENSE_CHECK_CONTRIBUTORS.flatMap((contributor) => contributor.codes);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(REASON_CODES.filter((code) => !(MVP_REASON_CODES as readonly string[]).includes(code)).sort());
    expect(all).toHaveLength(16);
    expect(EXPENSE_CHECK_CONTRIBUTORS.map((contributor) => [contributor.id, contributor.codes])).toEqual([['people', PEOPLE_REASON_CODES], ['money', MONEY_REASON_CODES], ['input', INPUT_REASON_CODES]]);
  });

  it('正常: 系統の事実が無ければ（マスタ・運賃・カードを使わない構成）、3 系統の検査関数を差し込んでも MVP と完全に同じ判定（§20.2.13）', () => {
    const items = [item('i1'), item('i2', { payeeName: undefined, corporatePayment: true })];
    const withContributors = judge(items, EXPENSE_CHECK_CONTRIBUTORS);
    expect(withContributors).toEqual(judge(items, []));
    expect(checkClaim({ claim: { id: 'c1', period, items }, policy, policySaved: false, duplicateCandidates: [], today: '2026-09-30' })).toEqual(withContributors);
  });

  it('正常: マスタを使っている事実があり申請者が紐付いていなければ、MVP との差は A の claimant-unlinked だけ（§20.3.3）', () => {
    const items = [item('i1'), item('i2', { payeeName: undefined, corporatePayment: true })];
    const withMaster = judge(items, EXPENSE_CHECK_CONTRIBUTORS, { extensions: { people: { masterInUse: true }, money: {}, input: {} } });
    const mvp = judge(items, []);
    expect(withMaster.items).toEqual(mvp.items);
    const added = withMaster.claimReasons.filter((reason) => !mvp.claimReasons.some((base) => base.code === reason.code));
    expect(added.map((reason) => reason.code)).toEqual(['claimant-unlinked']);
    expect(withMaster.claimReasons).toHaveLength(mvp.claimReasons.length + 1);
  });
});

describe('contributor の差し込み', () => {
  it('正常: 申請の理由は明細が無くても出て、評価順（policy-unreviewed → 申請の前提 → claim-empty）に並ぶ', () => {
    const people: ExpenseCheckContributor = { id: 'people', codes: PEOPLE_REASON_CODES, claimReasons: (_claim, _policy, extensions): readonly ReasonDraft[] => (extensions.people?.masterInUse === true ? [{ code: 'approval-route-unresolved', params: { routeName: '経路' } }, { code: 'claimant-unlinked', params: { claimant: 'テスト太郎', candidates: null } }] : []) };
    const judgment = judge([], [people], { extensions: { people: { masterInUse: true } } });
    expect(judgment.claimReasons.map((reason) => [reason.code, reason.severity])).toEqual([['policy-unreviewed', 'review'], ['claimant-unlinked', 'review'], ['approval-route-unresolved', 'review'], ['claim-empty', 'return']]);
    expect(judgment.claimReasons[1]).not.toHaveProperty('itemId');
  });

  it('正常: 明細の理由は評価済みの値を受け取り、評価順へ安定ソートされ、明細の呼び名が params に入る', () => {
    const seen: ItemEvaluation[] = [];
    const money: ExpenseCheckContributor = { id: 'money', codes: MONEY_REASON_CODES, itemReasons: (evaluation) => { seen.push(evaluation); return [{ code: 'card-charge-claimed', params: { cardLabel: '法人カード' } }]; } };
    const input: ExpenseCheckContributor = { id: 'input', codes: INPUT_REASON_CODES, itemReasons: () => [{ code: 'date-substituted-by-issue-date', params: { date: '2026-09-10' } }] };
    const judgment = judge([item('i1', { payeeName: undefined })], [money, input]);
    expect(judgment.items[0]?.reasons.map((reason) => reason.code)).toEqual(['payee-missing', 'date-substituted-by-issue-date', 'card-charge-claimed']);
    // 摘要も支払先も無い明細の呼び名は「明細 N」。
    expect(judgment.items[0]?.reasons.find((reason) => reason.code === 'card-charge-claimed')).toEqual({ code: 'card-charge-claimed', severity: 'return', itemId: 'i1', params: { description: '明細 1', cardLabel: '法人カード' } });
    expect(seen[0]).toMatchObject({ index: 0, description: '明細 1', amount: 420, date: '2026-09-10', category: { id: 'transport.public' } });
    expect([...seen[0]!.emitted]).toEqual(['payee-missing']);
    expect(judgment.verdict).toBe('returned');
  });

  it('境界: forcedSeverity は規程の重さより優先し、off の上書きは理由ごと消す', () => {
    const money: ExpenseCheckContributor = { id: 'money', codes: MONEY_REASON_CODES, itemReasons: () => [{ code: 'card-charge-claimed', params: { weak: true }, forcedSeverity: 'review' }] };
    expect(judge([item('i1')], [money]).items[0]?.reasons.map((reason) => [reason.code, reason.severity])).toEqual([['card-charge-claimed', 'review']]);
    const input: ExpenseCheckContributor = { id: 'input', codes: INPUT_REASON_CODES, itemReasons: () => [{ code: 'route-missing', params: {} }] };
    const quiet = createExpensePolicy({ ...policy, severityOverrides: { 'route-missing': 'off' } });
    const judgment = checkClaim({ claim: { id: 'c1', period, items: [item('i1')] }, policy: quiet, policySaved: true, duplicateCandidates: [], today: '2026-09-30', contributors: [input] });
    expect(judgment.items[0]?.reasons).toEqual([]);
    const claimOff: ExpenseCheckContributor = { id: 'people', codes: PEOPLE_REASON_CODES, claimReasons: () => [{ code: 'claimant-unlinked', params: {} }] };
    expect(checkClaim({ claim: { id: 'c1', period, items: [item('i1')] }, policy: createExpensePolicy({ ...policy, severityOverrides: { 'claimant-unlinked': 'off' } }), policySaved: true, duplicateCandidates: [], today: '2026-09-30', contributors: [claimOff] }).claimReasons).toEqual([]);
  });

  it('例外: 自分のコードの集合に無いコードを返したら実装の誤りとして ExpenseDomainError', () => {
    const wrong: ExpenseCheckContributor = { id: 'people', codes: PEOPLE_REASON_CODES, claimReasons: () => [{ code: 'advance-not-paid', params: {} }] };
    expect(() => judge([], [wrong])).toThrow(ExpenseDomainError);
    const wrongItem: ExpenseCheckContributor = { id: 'input', codes: INPUT_REASON_CODES, itemReasons: () => [{ code: 'amount-missing', params: {} }] };
    expect(() => judge([item('i1')], [wrongItem])).toThrow(/not one of its codes/u);
  });

  it('正常: provider の事実をまとめる（undefined のキーは上書きしない）', () => {
    expect(mergeCheckExtensions([{ people: { masterInUse: true } }, { money: undefined }, { input: { fareTableSaved: false } }])).toEqual({ people: { masterInUse: true }, input: { fareTableSaved: false } });
    expect(mergeCheckExtensions([])).toEqual({});
  });
});

describe('会社払いの明細を申請に含める運用（§20.3.2 5）', () => {
  it('境界: フラグ on なら会社払いの明細に payment-not-reimbursable を出さず、off（既定）なら出す', () => {
    const corporate = [item('i1', { corporatePayment: true })];
    expect(judge(corporate, []).items[0]?.reasons.map((reason) => reason.code)).toEqual(['payment-not-reimbursable']);
    const accepting = createExpensePolicy({ ...policy, card: { acceptCorporatePaymentItems: true } });
    const judgment = checkClaim({ claim: { id: 'c1', period, items: corporate }, policy: accepting, policySaved: true, duplicateCandidates: [], today: '2026-09-30' });
    expect(judgment.items[0]?.reasons).toEqual([]);
  });
});
