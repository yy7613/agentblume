import { describe, expect, it } from 'vitest';
import { checkClaim } from '../check';
import type { CheckedClaim, CheckExtensionsInput, ItemEvaluation } from '../check-extensions';
import type { ExpenseItem } from '../claim';
import { defaultExpensePolicy } from '../default-policy';
import type { ExpenseDetailRecord } from '../detail-read';
import { allReasons } from '../judgment';
import { createExpensePolicy, findCategory, type ExpensePolicy } from '../policy';
import type { ReceiptFacts } from '../receipt-facts';
import { transportInUse, type InputCheckFacts } from './check-facts';
import { formatDisagreements, inputContributor } from './check-input';

const AT = '2026-09-15T00:00:00.000Z';
const policy = defaultExpensePolicy(AT);

const FARE_ROUTES: InputCheckFacts['fareRoutes'] = [
  { id: 'fare-nakano-kasumigaseki', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ic', fare: 300, bidirectional: true },
  { id: 'fare-nakano-kasumigaseki-ticket', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', fare: 320, bidirectional: true },
  { id: 'fare-shinjuku-shibuya', stations: ['新宿', '渋谷'], fareType: 'ic', fare: 160, bidirectional: true },
];
const PASS = { id: 'pass-taro', stations: ['中野', '新宿', '霞ケ関'], validFrom: '2026-04-01', validTo: '2027-03-31' };
const FACTS: InputCheckFacts = { fareTableSaved: true, fareRoutes: FARE_ROUTES, stationAliases: [{ name: '霞ケ関', aliases: ['霞が関'] }], commuterPasses: [PASS] };
const NO_PASS: InputCheckFacts = { ...FACTS, commuterPasses: [] };

const claim: CheckedClaim = { id: 'c1', period: { from: '2026-09-01', to: '2026-09-30' }, items: [], claimant: { name: 'テスト太郎', employeeId: 'emp-taro' } };

function item(facts: ReceiptFacts, extraction: Partial<ExpenseItem['extraction']> = {}, categoryId = 'transport.public'): ExpenseItem {
  return { id: 'item-1', categoryId, facts, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [], ...extraction } };
}

function evaluation(target: ExpenseItem, targetPolicy: ExpensePolicy = policy): ItemEvaluation {
  const category = findCategory(targetPolicy, target.categoryId);
  return {
    item: target, index: 0, description: '明細 1', emitted: new Set(),
    ...(category === undefined ? {} : { category }),
    ...(target.facts.amount === undefined ? {} : { amount: target.facts.amount }),
    ...(target.facts.transactionDate === undefined ? {} : { date: target.facts.transactionDate }),
  };
}

function reasons(target: ExpenseItem, extensions: CheckExtensionsInput = { input: FACTS }, targetPolicy: ExpensePolicy = policy, targetClaim: CheckedClaim | undefined = claim) {
  return inputContributor.itemReasons!(evaluation(target, targetPolicy), targetPolicy, extensions, targetClaim);
}

const trip = (stations: readonly string[], amount: number, extra: Partial<ReceiptFacts> = {}): ReceiptFacts => ({ transactionDate: '2026-09-10', amount, route: { stations, trips: 1 }, ...extra });

describe('transportInUse', () => {
  it('正常: 運賃マスタに経路があるか、申請者に通勤定期があるときだけ true', () => {
    expect(transportInUse(undefined)).toBe(false);
    expect(transportInUse({})).toBe(false);
    expect(transportInUse({ fareRoutes: [], commuterPasses: [] })).toBe(false);
    expect(transportInUse({ fareRoutes: FARE_ROUTES })).toBe(true);
    expect(transportInUse({ commuterPasses: [PASS] })).toBe(true);
  });
});

describe('inputContributor: 交通費（5a）', () => {
  it('MVP と同じ: 事実が無い・運賃も定期も無い構成では、区間が必須の費目でも何も出さない', () => {
    expect(reasons(item({ transactionDate: '2026-09-10', amount: 420 }), {})).toEqual([]);
    expect(reasons(item({ transactionDate: '2026-09-10', amount: 420 }), { input: { fareTableSaved: false, fareRoutes: [], commuterPasses: [] } })).toEqual([]);
  });

  it('正常: 区間が必須の費目で区間が無ければ route-missing だけ（残りを飛ばす）', () => {
    expect(reasons(item({ transactionDate: '2026-09-10', amount: 420 }))).toEqual([{ code: 'route-missing', params: { category: '電車・バス', missing: '区間' } }]);
  });

  it('境界: 区間を必須にしない費目・区間の設定が無い費目では、区間が無くても何も出さない', () => {
    const optional = createExpensePolicy({ ...policy, categories: policy.categories.map((category) => (category.id === 'transport.public' ? { ...category, route: { required: false, commuterPass: true, fareTable: true } } : category)) });
    expect(reasons(item({ amount: 420 }), { input: FACTS }, optional)).toEqual([]);
    expect(reasons(item({ amount: 420, route: { stations: ['中野', '新宿'], trips: 1 } }, {}, 'transport.taxi'))).toEqual([]);
  });

  it('正常: 区間が通勤定期の範囲内なら commuter-pass-overlap（差し戻し）で、運賃の照合は飛ばす', () => {
    expect(reasons(item(trip(['新宿', '霞が関'], 9999)))).toEqual([{
      code: 'commuter-pass-overlap',
      params: { route: '新宿 > 霞が関', claimant: 'テスト太郎', passRoute: '中野 > 新宿 > 霞ケ関', validTo: '2027-03-31', employeeId: 'emp-taro' },
    }]);
  });

  it('正常: 一部だけ重なれば commuter-pass-partial-overlap（金額の候補つき）と、運賃の照合の両方を見る', () => {
    expect(reasons(item(trip(['中野', '新宿', '渋谷'], 999, { route: { stations: ['中野', '新宿', '渋谷'], trips: 2 } })))).toEqual([
      { code: 'commuter-pass-partial-overlap', params: { route: '中野 > 新宿 > 渋谷', overlapFrom: '中野', overlapTo: '新宿', restRoute: '新宿 > 渋谷', suggestedAmount: 320, employeeId: 'emp-taro' } },
      { code: 'fare-route-unknown', params: { route: '中野 > 新宿 > 渋谷', fareType: 'ic' } },
    ]);
  });

  it('境界: 申請者が紐付いていない・定期の外の日付・規程で定期の控除を切った・費目で定期を見ない なら定期の理由を出さない', () => {
    const unlinked: CheckedClaim = { ...claim, claimant: { name: '手入力' } };
    expect(reasons(item(trip(['新宿', '霞ケ関'], 200)), { input: FACTS }, policy, unlinked)).toEqual([{ code: 'commuter-pass-overlap', params: { route: '新宿 > 霞ケ関', claimant: '手入力', passRoute: '中野 > 新宿 > 霞ケ関', validTo: '2027-03-31' } }]);
    expect(reasons(item(trip(['新宿', '霞ケ関'], 200, { transactionDate: '2026-03-31' })))).toEqual([{ code: 'fare-route-unknown', params: { route: '新宿 > 霞ケ関', fareType: 'ic' } }]);
    const noDeduction = createExpensePolicy({ ...policy, transport: { ...policy.transport, commuterPassDeduction: false } });
    expect(reasons(item(trip(['新宿', '霞ケ関'], 200)), { input: FACTS }, noDeduction).map((reason) => reason.code)).toEqual(['fare-route-unknown']);
    const noPassCheck = createExpensePolicy({ ...policy, categories: policy.categories.map((category) => (category.id === 'transport.public' ? { ...category, route: { required: true, commuterPass: false, fareTable: false } } : category)) });
    expect(reasons(item(trip(['新宿', '霞ケ関'], 200)), { input: FACTS }, noPassCheck)).toEqual([]);
    expect(inputContributor.itemReasons!(evaluation(item(trip(['新宿', '霞ケ関'], 200))), policy, { input: FACTS }, undefined)[0]).toMatchObject({ params: { claimant: '' } });
  });

  it('正常: 金額が運賃 × 回数 + 許容差を超えれば fare-exceeds-table（文言の差し込み値つき）', () => {
    expect(reasons(item(trip(['中野', '霞ケ関'], 700, { route: { stations: ['中野', '霞ケ関'], trips: 2 } })), { input: NO_PASS })).toEqual([{
      code: 'fare-exceeds-table',
      params: { amount: 700, route: '中野 > 霞ケ関', fareType: 'ic', fare: 300, trips: 2, expected: 600, over: 100, tolerance: 0, candidateCount: 1 },
    }]);
  });

  it('境界: 許容差ちょうどは出さない。券種は明細の指定、無ければ規程の既定', () => {
    const tolerant = createExpensePolicy({ ...policy, transport: { ...policy.transport, fareToleranceYen: 20 } });
    expect(reasons(item(trip(['中野', '霞ケ関'], 320)), { input: NO_PASS }, tolerant)).toEqual([]);
    expect(reasons(item(trip(['中野', '霞ケ関'], 321)), { input: NO_PASS }, tolerant).map((reason) => reason.code)).toEqual(['fare-exceeds-table']);
    expect(reasons(item(trip(['中野', '霞ケ関'], 320, { route: { stations: ['中野', '霞ケ関'], trips: 1, fareType: 'ticket' } })), { input: NO_PASS })).toEqual([]);
    const ticketDefault = createExpensePolicy({ ...policy, transport: { ...policy.transport, defaultFareType: 'ticket' } });
    expect(reasons(item(trip(['中野', '霞ケ関'], 320)), { input: NO_PASS }, ticketDefault)).toEqual([]);
  });

  it('境界: 金額が無ければ運賃を飛ばす。取引日が無くても運賃は期間で絞らずに照合する', () => {
    expect(reasons(item({ route: { stations: ['渋谷', '品川'], trips: 1 } }), { input: NO_PASS })).toEqual([]);
    expect(reasons(item({ amount: 999, route: { stations: ['中野', '霞ケ関'], trips: 1 } }), { input: NO_PASS }).map((reason) => reason.code)).toEqual(['fare-exceeds-table']);
  });
});

describe('inputContributor: 読取（3）', () => {
  const detail: ExpenseDetailRecord = {
    promptVersion: 'expense-detail/v1', readAt: AT,
    raw: { registrationNumberText: 'T123456789012', payeeNameText: null, transactionDateText: null, issueDateText: null, attendees: { countText: null, names: [] }, purposeClues: [], route: { from: null, to: null, via: [], fareType: null }, notes: [] },
    disagreements: [{ field: 'registrationNumber', journalValue: 'T1234567890123', detailValue: 'T123456789012' }],
  };

  it('正常: 印が無い明細には何も出さない（MVP のデータ・手入力・CSV）', () => {
    expect(reasons(item({ transactionDate: '2026-09-10', amount: 500 }, {}, 'misc'))).toEqual([]);
  });

  it('正常: 発行日で代用した取引日・食い違い・未確認の候補を印から出す', () => {
    const flagged = item({ transactionDate: '2026-09-10', amount: 500 }, { flags: ['transaction-date-substituted', 'reads-disagree', 'attendees-read', 'route-read', 'payee-read', 'purpose-read', 'registration-number-rejected'], detail }, 'misc');
    expect(reasons(flagged)).toEqual([
      { code: 'date-substituted-by-issue-date', params: { date: '2026-09-10' } },
      { code: 'receipt-reads-disagree', params: { disagreements: '登録番号: 仕訳の読取「T1234567890123」/ 追加の読取「T123456789012（数字 12 桁）」' } },
      { code: 'read-values-unconfirmed', params: { fields: '参加人数・区間・支払先・目的' } },
    ]);
  });

  it('境界: 取引日が無ければ発行日の代用は言わない（date-missing が先に出る）。記録が無い食い違いは空の文言', () => {
    expect(reasons(item({ amount: 500 }, { flags: ['transaction-date-substituted', 'reads-disagree'] }, 'misc'))).toEqual([{ code: 'receipt-reads-disagree', params: { disagreements: '' } }]);
  });
});

describe('formatDisagreements', () => {
  it('境界: 値が無い側は「なし」、最大 4 欄、欄は「 / 」で並べる', () => {
    const entry = { field: 'payeeName' as const, journalValue: null, detailValue: null };
    expect(formatDisagreements([entry])).toBe('支払先: 仕訳の読取「なし」/ 追加の読取「なし」');
    const many = formatDisagreements([
      { field: 'transactionDate', journalValue: '2026-09-10', detailValue: '2026-09-11' }, { field: 'issueDate', journalValue: 'a', detailValue: 'b' },
      entry, entry, { field: 'registrationNumber', journalValue: 'x', detailValue: 'y' },
    ]);
    expect(many.split(' / 取').length).toBe(1);
    expect(many).not.toContain('登録番号');
    expect(many.startsWith('取引日: 仕訳の読取「2026-09-10」/ 追加の読取「2026-09-11」 / 発行日')).toBe(true);
  });
});

describe('checkClaim との結合', () => {
  const claimWith = (items: readonly ExpenseItem[]): CheckedClaim => ({ ...claim, items });
  const judge = (items: readonly ExpenseItem[], extensions: CheckExtensionsInput | undefined, targetPolicy: ExpensePolicy = policy) => checkClaim({
    claim: claimWith(items), policy: targetPolicy, policySaved: true, duplicateCandidates: [], today: '2026-09-30', ...(extensions === undefined ? {} : { extensions }),
  });

  it('正常: 系統の理由は評価順（読取 → 交通費）へ並び、重さは規程から決まる', () => {
    const flagged = { ...item(trip(['新宿', '霞ケ関'], 200, { purpose: '客先訪問', payeeName: '東京メトロ' }), { flags: ['transaction-date-substituted'] }) };
    const codes = allReasons(judge([flagged], { input: FACTS })).map((reason) => [reason.code, reason.severity]);
    expect(codes).toEqual([['date-substituted-by-issue-date', 'review'], ['commuter-pass-overlap', 'return']]);
    const lighter = createExpensePolicy({ ...policy, severityOverrides: { 'commuter-pass-overlap': 'review' } });
    expect(allReasons(judge([flagged], { input: FACTS }, lighter)).find((reason) => reason.code === 'commuter-pass-overlap')?.severity).toBe('review');
  });

  it('MVP と同じ: 拡張の事実が無ければ、区間が無い電車・バスの明細に系統の理由は出ない', () => {
    const plain = item({ transactionDate: '2026-09-10', amount: 420, payeeName: '東京メトロ', purpose: '客先訪問' });
    expect(allReasons(judge([plain], undefined))).toEqual([]);
    expect(allReasons(judge([plain], { input: NO_PASS })).map((reason) => reason.code)).toEqual(['route-missing']);
  });
});
