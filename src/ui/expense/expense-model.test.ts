import { describe, expect, it } from 'vitest';
import { REASON_MESSAGES } from '../../application/expense/reason-messages';
import { APPROVAL_BLOCKER_CODES } from '../../domain/expense/approval';
import { CLAIM_STATUSES } from '../../domain/expense/claim';
import { EXPENSE_FIX_TARGETS, INPUT_REASON_CODES, MONEY_REASON_CODES, PEOPLE_REASON_CODES, REASON_CATALOG, REASON_CODES } from '../../domain/expense/reason-codes';
import {
  EXPENSE_CLAIM_STATUSES, EXPENSE_REASON_CODES, type ExpenseCategoryDto, type ExpenseClaimDto, type ExpenseFixTargetDto, type ExpensePolicyDto, type SaveExpensePolicyDto,
} from '../api/expense-types';
import {
  EXPENSE_APPROVAL_BLOCKER_CODES, EXPENSE_LEDGER_TABS, EXPENSE_REASON_ADJUSTABLE, EXPENSE_REASON_DEFAULT_SEVERITY, EXPENSE_REASON_FIX_TARGETS, accountKnown, advanceStatusLabel,
  amountFromInput, categoryHints, claimDraftFromClaim, claimInputFromDraft,
  claimStatusLabel, confirmedExtraction, copyIssueDate, csvFieldLabel, defaultPeriod, detailArray, emptyClaimDraft, emptyItemDraft, fixTargetLabel, focusSelectsClaim, isBlockingReason, isIsoDate, isJournalLinkProblem,
  isString, itemDraftFrom, itemInputFromDraft, itemLabel, journalProblemLabel, journalProblemTarget, localIsoDate, newCategory, newPreApprovalRule, openTargetForFix,
  parseExpenseTarget, parseInteger, paymentMethodLabel, policyBody, policyIssues, readinessLabel, readinessRows, reasonTitle, reviewReasonsOf, searchKeysOf, severityLabel, splitNames, sumAmounts,
  summarizeBlocker, summarizeCheck, verdictLabel, warningFields, withOptional, withSeverityOverride, type Translate,
} from './expense-model';

const en: Translate = (english) => english;
const ja: Translate = (_english, japanese) => japanese;

/** 全コードの文言に差し込める値。 */
const FULL = {
  description: 'タクシー代', categoryText: '交通', categoryId: 'transport.taxi', category: 'タクシー', issueDate: '2026-09-01', readerHint: true, exemptBelow: 3000,
  warnings: '警告A / 警告B', sum: 1000, amount: 1100, diff: 100, tolerance: 2, date: '2026-09-05', from: '2026-09-01', to: '2026-09-30', today: '2026-09-10', days: 120, limitDays: 90,
  paymentMethod: 'credit_card', deductionRate: 80, raw: 'T123', digits: 3, limit: 10000, over: 500, perPerson: 12000, basis: 'tax-excluded', count: 3, basisFallback: true,
  missingNames: true, missingRelation: true, unitLabel: '泊', perUnit: 15000, unitCount: 2, ruleName: '交際費 5 万円以上', ruleId: 'entertainment-50000',
  otherItemId: 'i2', otherDescription: '弁当', weak: true, otherClaimId: 'c9', otherStatus: 'approved', claimantName: '佐藤', total: 50000, documentKind: 'receipt', count2: 1,
  // 実用化の 16 コード（§20.4）。件数・回数・日数は桁区切りしない値と比べるため 1,000 以上も混ぜる。
  claimant: '山田 太郎', candidates: '山田 太郎（E001）、山田 次郎（E002）', missing: '到着駅', advanceId: 'adv-1', advanceEmployee: '鈴木', advanceStatus: 'paid', settledOn: '2026-09-01',
  routeName: '高額', stepName: '部門長', cause: 'department-head-missing', manager: '鈴木', department: '営業部', group: '経理', employee: '高橋',
  disagreements: '登録番号: 仕訳の読取「T1234567890123」/ 追加の読取「T123456789012（数字 12 桁）」', fields: '参加人数・区間・支払先',
  route: '新宿 > 霞ケ関', passRoute: '新宿 > 東京', validTo: '2027-03-31', overlapFrom: '新宿', overlapTo: '四ツ谷', restRoute: '四ツ谷 > 霞ケ関', suggestedAmount: 1180,
  fareType: 'ticket', fare: 1200, trips: 1000, expected: 1200000, candidateCount: 1200,
  cardLabel: '法人カード A', usedOn: '2026-09-10', merchant: 'タクシー会社', cardAmount: 12500, dateDiffDays: -2, coverage: '2026-08-01〜2026-09-30',
} as const;
const SPARSE = {
  ...FULL, categoryText: null, issueDate: null, readerHint: false, exemptBelow: null, raw: null, digits: null, date: null, deductionRate: null, basisFallback: false, missingNames: false, missingRelation: true, weak: false, basis: 'tax-included',
  candidates: null, missing: true, advanceStatus: 'mystery', cause: 'mystery', validTo: null, restRoute: null, suggestedAmount: null, fareType: 'ic', candidateCount: 1, dateDiffDays: 0,
};

describe('理由コードのカタログ（domain との一致）', () => {
  it('正常: EXPENSE_REASON_CODES は domain の REASON_CODES と同じ並び', () => {
    expect([...EXPENSE_REASON_CODES]).toEqual([...REASON_CODES]);
  });

  it('正常: 重さの選択肢・既定の重さ・導線先は REASON_CATALOG と一致し、全コードを網羅する', () => {
    for (const code of REASON_CODES) {
      expect(EXPENSE_REASON_ADJUSTABLE[code], code).toEqual(REASON_CATALOG[code].adjustable);
      expect(EXPENSE_REASON_DEFAULT_SEVERITY[code], code).toBe(REASON_CATALOG[code].defaultSeverity);
      expect(EXPENSE_REASON_FIX_TARGETS[code], code).toEqual(REASON_CATALOG[code].fixTargets);
    }
    expect(Object.keys(EXPENSE_REASON_ADJUSTABLE).sort()).toEqual([...REASON_CODES].sort());
    expect(Object.keys(EXPENSE_REASON_FIX_TARGETS).sort()).toEqual([...REASON_CODES].sort());
    expect(Object.keys(EXPENSE_REASON_DEFAULT_SEVERITY).sort()).toEqual([...REASON_CODES].sort());
  });

  it('正常: 申請の状態・導線先・承認の擬似コードも domain と同じ（並びも含む）', () => {
    expect([...EXPENSE_CLAIM_STATUSES]).toEqual([...CLAIM_STATUSES]);
    expect([...ALL_FIX_TARGETS]).toEqual([...EXPENSE_FIX_TARGETS]);
    expect([...EXPENSE_APPROVAL_BLOCKER_CODES]).toEqual([...APPROVAL_BLOCKER_CODES]);
  });
});

/** UI の導線先の全件（型で UI の DTO に当てはまることを確かめ、値で domain と突き合わせる）。 */
const ALL_FIX_TARGETS: readonly ExpenseFixTargetDto[] = [
  'item', 'item-category', 'receipt', 'policy-category', 'policy-rules', 'policy-pre-approval', 'policy-save', 'other-claim',
  'claim-claimant', 'claim-advance', 'item-route', 'employee', 'employee-commuter', 'organization', 'policy-approval',
  'advance', 'card-transaction', 'card-transactions', 'fare-table',
];

describe('summarizeCheck', () => {
  it('正常: 43 コードすべてに原因・直し方・見出しがあり、日英で違う文になり、差し込み漏れ（undefined）が無い', () => {
    expect(REASON_CODES).toHaveLength(43);
    for (const code of REASON_CODES) {
      for (const params of [FULL, SPARSE, {}]) {
        const english = summarizeCheck({ code, severity: 'review', params }, en);
        const japanese = summarizeCheck({ code, severity: 'review', params }, ja);
        for (const value of [english.title, english.cause, english.fix, japanese.title, japanese.cause, japanese.fix]) {
          expect(value, code).not.toBe('');
          expect(value, code).not.toContain('undefined');
        }
        expect(english.cause, code).not.toBe(japanese.cause);
        expect(japanese.fixTargets).toEqual(REASON_CATALOG[code].fixTargets);
      }
    }
  });

  it('正常: 日本語の原因・直し方は §4 の文言（application の reason-messages）と一致する。申請の状態だけは画面でラベルにする', () => {
    for (const code of REASON_CODES) {
      for (const params of [FULL, SPARSE]) {
        const japanese = summarizeCheck({ code, severity: 'return', params }, ja);
        const server = REASON_MESSAGES[code];
        expect(japanese.fix, code).toBe(server.fix(params));
        if (code === 'duplicate-across-claims') expect(japanese.cause).toContain('（承認済み）');
        else expect(japanese.cause, code).toBe(server.cause(params));
      }
    }
  });

  it('正常: 実用化の 16 コードは差し込み値の分岐（候補・未登録・原因・期限・提案・件数・弱い一致と日付差）でもサーバーの文と一致する', () => {
    const variants = [
      { candidates: '' }, { missing: false }, { missing: true }, { validTo: '' }, { restRoute: '四ツ谷 > 霞ケ関', suggestedAmount: null }, { candidateCount: 2 }, { fareType: 'bus' },
      { weak: true, dateDiffDays: 0 }, { weak: false, dateDiffDays: 3 }, { weak: true, dateDiffDays: -1 },
      ...['manager-missing', 'manager-disabled', 'department-head-missing', 'group-empty', 'employee-disabled', 'only-claimant', 'claimant-unlinked'].map((cause) => ({ cause })),
      ...['requested', 'approved', 'settling', 'settled', 'cancelled'].map((advanceStatus) => ({ advanceStatus })),
    ];
    for (const code of [...PEOPLE_REASON_CODES, ...MONEY_REASON_CODES, ...INPUT_REASON_CODES]) {
      for (const variant of variants) {
        const params = { ...FULL, ...variant };
        const japanese = summarizeCheck({ code, severity: 'review', params }, ja);
        expect(japanese.cause, `${code} ${JSON.stringify(variant)}`).toBe(REASON_MESSAGES[code].cause(params));
        expect(japanese.fix, `${code} ${JSON.stringify(variant)}`).toBe(REASON_MESSAGES[code].fix(params));
      }
    }
  });

  it('正常: 実用化の原因（英語）も差し込み値を落とさない', () => {
    expect(summarizeCheck({ code: 'fare-exceeds-table', severity: 'review', params: { ...FULL, candidateCount: 3 } }, en).cause)
      .toBe('The amount ¥1,100 exceeds ¥1,200 × 1000 trips = ¥1,200,000 for 新宿 > 霞ケ関 (ticket) in the fare table by ¥500 (tolerance ¥2; compared with the highest of 3 fares registered for the route).');
    expect(summarizeCheck({ code: 'card-charge-claimed', severity: 'return', params: { ...FULL, weak: true, dateDiffDays: 2 } }, en).cause)
      .toBe('It matches the ¥12,500 charge at タクシー会社 on 2026-09-10 on the corporate card "法人カード A" (the merchant name differs, so only the date and amount were compared) (2 days from the usage date). Reimbursing it would pay twice.');
    expect(summarizeCheck({ code: 'claimant-employee-disabled', severity: 'review', params: { claimant: '山田', missing: true } }, en).cause).toContain('was not found');
    expect(reasonTitle('commuter-pass-overlap', ja)).toBe('通勤定期の範囲内');
  });

  it('正常: 明細 id を持つ理由は itemId を返し、持たない理由はキーを作らない', () => {
    expect(summarizeCheck({ code: 'amount-missing', severity: 'return', params: {}, itemId: 'i1' }, en).itemId).toBe('i1');
    expect('itemId' in summarizeCheck({ code: 'claim-empty', severity: 'return', params: {} }, en)).toBe(false);
    expect(reasonTitle('payee-missing', ja)).toBe('支払先なし');
  });
});

describe('導線', () => {
  const base = { claimId: 'c1', itemId: 'i1', categoryId: 'meal.meeting' };

  it('正常: 導線先ごとの OpenTarget（完全一致）', () => {
    expect(openTargetForFix('item', { ...base, code: 'amount-missing', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'amount' });
    expect(openTargetForFix('item', { ...base, code: 'duplicate-in-claim', params: { otherItemId: 'i2' } })).toEqual({ internalId: 'c1', section: 'item:i2' });
    expect(openTargetForFix('item', { ...base, code: 'duplicate-in-claim', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1' });
    expect(openTargetForFix('item', { claimId: 'c1', code: 'claim-empty', params: {} })).toEqual({ internalId: 'c1', section: 'item:' });
    expect(openTargetForFix('item-category', { ...base, code: 'category-missing', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'categoryId' });
    expect(openTargetForFix('item-category', { claimId: 'c1', code: 'category-missing', params: {} })).toEqual({ internalId: 'c1', section: 'item:', nodeId: 'categoryId' });
    expect(openTargetForFix('receipt', { ...base, code: 'receipt-extraction-warning', params: {} })).toEqual({ internalId: 'c1', section: 'receipt:i1' });
    expect(openTargetForFix('receipt', { claimId: 'c1', code: 'receipt-extraction-warning', params: {} })).toEqual({ internalId: 'c1', section: 'receipt:' });
    expect(openTargetForFix('policy-category', { ...base, code: 'per-claim-limit-exceeded', params: { categoryId: 'transport.taxi' } })).toEqual({ internalId: 'transport.taxi', section: 'category' });
    expect(openTargetForFix('policy-category', { ...base, code: 'per-item-limit-exceeded', params: {} })).toEqual({ internalId: 'meal.meeting', section: 'category' });
    expect(openTargetForFix('policy-category', { claimId: 'c1', code: 'category-missing', params: {} })).toEqual({ internalId: '', section: 'category' });
    expect(openTargetForFix('policy-rules', { ...base, code: 'submission-late', params: {} })).toEqual({ internalId: '', section: 'rules' });
    expect(openTargetForFix('policy-pre-approval', { ...base, code: 'pre-approval-missing', params: { ruleId: 'r1' } })).toEqual({ internalId: 'r1', section: 'pre-approval' });
    expect(openTargetForFix('policy-pre-approval', { ...base, code: 'pre-approval-missing', params: {} })).toEqual({ internalId: '', section: 'pre-approval' });
    expect(openTargetForFix('policy-save', { claimId: 'c1', code: 'policy-unreviewed', params: {} })).toEqual({ internalId: '', section: 'save' });
    expect(openTargetForFix('other-claim', { ...base, code: 'duplicate-across-claims', params: { otherClaimId: 'c9' } })).toEqual({ internalId: 'c9', section: 'claim' });
    expect(openTargetForFix('other-claim', { ...base, code: 'duplicate-across-claims', params: {} })).toEqual({ internalId: '', section: 'claim' });
  });

  it('正常: 実用化の導線先（申請の欄・規程の承認経路・台帳）。行の id は params にあれば使い、無ければ一覧を開く', () => {
    expect(openTargetForFix('claim-claimant', { ...base, code: 'claimant-unlinked', params: {} })).toEqual({ internalId: 'c1', section: 'claimant' });
    expect(openTargetForFix('claim-advance', { ...base, code: 'advance-not-paid', params: {} })).toEqual({ internalId: 'c1', section: 'advance-link' });
    expect(openTargetForFix('item-route', { ...base, code: 'route-missing', params: {} })).toEqual({ internalId: 'c1', section: 'item-route:i1' });
    expect(openTargetForFix('item-route', { claimId: 'c1', code: 'route-missing', params: {} })).toEqual({ internalId: 'c1', section: 'item-route:' });
    expect(openTargetForFix('employee', { ...base, code: 'claimant-employee-disabled', params: { employeeId: 'e1' } })).toEqual({ internalId: 'e1', section: 'employee' });
    expect(openTargetForFix('employee', { ...base, code: 'claimant-unlinked', params: {} })).toEqual({ internalId: '', section: 'employee' });
    expect(openTargetForFix('employee-commuter', { ...base, code: 'commuter-pass-overlap', params: { employeeId: 'e2' } })).toEqual({ internalId: 'e2', section: 'employee-commuter' });
    expect(openTargetForFix('organization', { ...base, code: 'approval-route-unresolved', params: { departmentId: 'd1', groupId: 'g1' } })).toEqual({ internalId: 'd1', section: 'organization' });
    expect(openTargetForFix('organization', { ...base, code: 'approval-route-unresolved', params: { groupId: 'g1' } })).toEqual({ internalId: 'g1', section: 'organization' });
    expect(openTargetForFix('policy-approval', { ...base, code: 'approval-route-unresolved', params: { routeId: 'high' } })).toEqual({ internalId: 'high', section: 'approval' });
    expect(openTargetForFix('advance', { ...base, code: 'advance-not-paid', params: { advanceId: 'adv-1' } })).toEqual({ internalId: 'adv-1', section: 'advance' });
    expect(openTargetForFix('card-transaction', { ...base, code: 'card-charge-claimed', params: { cardTransactionId: 'tx1' } })).toEqual({ internalId: 'tx1', section: 'card' });
    expect(openTargetForFix('card-transaction', { ...base, code: 'card-charge-claimed', params: {} })).toEqual({ internalId: '', section: 'card' });
    expect(openTargetForFix('card-transactions', { ...base, code: 'corporate-payment-unmatched', params: {} })).toEqual({ internalId: '', section: 'cards' });
    expect(openTargetForFix('fare-table', { ...base, code: 'fare-route-unknown', params: {} })).toEqual({ internalId: '', section: 'fares' });
    // item 導線でフォーカスする欄（発行日の代用は取引日、一部重複は金額、カードの一致は支払方法）。
    expect(openTargetForFix('item', { ...base, code: 'date-substituted-by-issue-date', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'transactionDate' });
    expect(openTargetForFix('item', { ...base, code: 'commuter-pass-partial-overlap', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'amount' });
    expect(openTargetForFix('item', { ...base, code: 'card-charge-claimed', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'paymentMethod' });
    expect(openTargetForFix('item', { ...base, code: 'corporate-payment-unmatched', params: {} })).toEqual({ internalId: 'c1', section: 'item:i1' });
  });

  it('正常: 全コード × 導線先にボタンの文言があり、導線から開いた先を parseExpenseTarget が解釈できる', () => {
    for (const code of REASON_CODES) for (const target of REASON_CATALOG[code].fixTargets) {
      expect(fixTargetLabel(target, code, en), `${code} ${target}`).not.toBe('');
      expect(fixTargetLabel(target, code, ja), `${code} ${target}`).not.toBe('');
      expect(parseExpenseTarget(openTargetForFix(target, { claimId: 'c1', itemId: 'i1', code, params: {} })), `${code} ${target}`).toBeDefined();
    }
    expect(new Set(ALL_FIX_TARGETS.map((target) => fixTargetLabel(target, 'amount-missing', en))).size).toBe(ALL_FIX_TARGETS.length);
    expect(fixTargetLabel('item', 'claim-empty', ja)).toBe('取込を開く');
    expect(fixTargetLabel('item', 'duplicate-in-claim', ja)).toBe('相手の明細を開く');
    expect(fixTargetLabel('item', 'unit-count-missing', en)).toBe('Enter the day / night count');
    // §20.4 の導線の文言。
    expect(fixTargetLabel('item', 'corporate-payment-unmatched', ja)).toBe('明細を開く');
    expect(fixTargetLabel('receipt', 'receipt-reads-disagree', ja)).toBe('領収書と並べて開く');
    expect(fixTargetLabel('receipt', 'read-values-unconfirmed', ja)).toBe('領収書を見る');
    expect(fixTargetLabel('employee', 'claimant-unlinked', ja)).toBe('従業員マスタを開く');
    expect(fixTargetLabel('employee', 'claimant-employee-disabled', ja)).toBe('従業員を開く');
    expect(fixTargetLabel('card-transactions', 'corporate-payment-unmatched', ja)).toBe('カード明細を開く');
    expect(fixTargetLabel('fare-table', 'fare-route-unknown', ja)).toBe('運賃マスタを開く');
  });

  it('正常: OpenTarget の解釈（未知の section は undefined）', () => {
    expect(parseExpenseTarget({ internalId: 'c1', section: 'item:i1', nodeId: 'amount' })).toEqual({ tab: 'ingest', section: 'item', id: 'c1', itemId: 'i1', field: 'amount' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'item:' })).toEqual({ tab: 'ingest', section: 'item', id: 'c1' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'receipt:i1' })).toEqual({ tab: 'check', section: 'receipt', id: 'c1', itemId: 'i1' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'receipt:' })).toEqual({ tab: 'check', section: 'receipt', id: 'c1' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'claim' })).toEqual({ tab: 'check', section: 'claim', id: 'c1' });
    for (const section of ['category', 'rules', 'pre-approval', 'save', 'journal'] as const) {
      expect(parseExpenseTarget({ internalId: 'x', section })).toEqual({ tab: 'policy', section, id: 'x' });
    }
    expect(parseExpenseTarget({ internalId: 'x', section: 'hearing' })).toBeUndefined();
    expect(parseExpenseTarget({ internalId: 'x' })).toBeUndefined();
  });

  it('正常: 実用化の section はそれぞれのタブへ開く（申請の欄は取込、承認経路は規程、台帳の行は台帳）', () => {
    expect(parseExpenseTarget({ internalId: 'c1', section: 'claimant' })).toEqual({ tab: 'ingest', section: 'claimant', id: 'c1' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'advance-link' })).toEqual({ tab: 'ingest', section: 'advance-link', id: 'c1' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'item-route:i1' })).toEqual({ tab: 'ingest', section: 'item-route', id: 'c1', itemId: 'i1', field: 'route' });
    expect(parseExpenseTarget({ internalId: 'c1', section: 'item-route:' })).toEqual({ tab: 'ingest', section: 'item-route', id: 'c1', field: 'route' });
    expect(parseExpenseTarget({ internalId: 'high', section: 'approval' })).toEqual({ tab: 'policy', section: 'approval', id: 'high' });
    for (const section of ['employee', 'employee-commuter', 'organization'] as const) expect(parseExpenseTarget({ internalId: 'e1', section })).toEqual({ tab: 'employees', section, id: 'e1' });
    expect(parseExpenseTarget({ internalId: 'adv-1', section: 'advance' })).toEqual({ tab: 'advances', section: 'advance', id: 'adv-1' });
    expect(parseExpenseTarget({ internalId: 'tx1', section: 'card' })).toEqual({ tab: 'cards', section: 'card', id: 'tx1' });
    expect(parseExpenseTarget({ internalId: '', section: 'cards' })).toEqual({ tab: 'cards', section: 'cards', id: '' });
    expect(parseExpenseTarget({ internalId: '', section: 'fares' })).toEqual({ tab: 'fares', section: 'fares', id: '' });
    // 台帳の section の打ち間違い（複数形・単数形の取り違え）は開かない。
    expect(parseExpenseTarget({ internalId: 'e1', section: 'employees' })).toBeUndefined();
    expect(parseExpenseTarget({ internalId: 'x', section: 'item-routes:i1' })).toBeUndefined();
  });

  it('境界: 選んでいる申請を切り替えるのは申請のタブで id があるときだけ（台帳の行 id・規程の id を申請にしない）', () => {
    expect(focusSelectsClaim({ tab: 'ingest', id: 'c1' })).toBe(true);
    expect(focusSelectsClaim({ tab: 'check', id: 'c1' })).toBe(true);
    expect(focusSelectsClaim({ tab: 'approve', id: 'c1' })).toBe(true);
    expect(focusSelectsClaim({ tab: 'check', id: '' })).toBe(false);
    expect(focusSelectsClaim({ tab: 'policy', id: 'meal.meeting' })).toBe(false);
    for (const tab of EXPENSE_LEDGER_TABS) expect(focusSelectsClaim({ tab, id: 'e1' })).toBe(false);
  });

  it('正常: 仕訳連携の問題の導線（科目マスタだけ仕訳画面へ出る）', () => {
    const problem = { code: 'x', message: 'm' };
    expect(journalProblemTarget({ ...problem, fixTarget: 'journal-chart', accountId: 'expense.travel' }, 'c1')).toEqual({ screen: 'Journal', target: { internalId: 'expense.travel', section: 'account' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'journal-chart' }, 'c1')).toEqual({ screen: 'Journal', target: { internalId: '', section: 'account' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'policy-category', categoryId: 'transport.taxi' }, 'c1')).toEqual({ screen: 'Expense', target: { internalId: 'transport.taxi', section: 'category' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'policy-category' }, 'c1')).toEqual({ screen: 'Expense', target: { internalId: '', section: 'category' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'policy-journal' }, 'c1')).toEqual({ screen: 'Expense', target: { internalId: '', section: 'journal' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'item', itemId: 'i1' }, 'c1')).toEqual({ screen: 'Expense', target: { internalId: 'c1', section: 'item:i1' } });
    expect(journalProblemTarget({ ...problem, fixTarget: 'item' }, 'c1')).toEqual({ screen: 'Expense', target: { internalId: 'c1', section: 'item:' } });
    const labels = (['journal-chart', 'policy-category', 'policy-journal', 'item'] as const).map((fixTarget) => journalProblemLabel({ ...problem, fixTarget }, ja));
    expect(new Set(labels).size).toBe(4);
  });
});

const judgedClaim: Pick<ExpenseClaimDto, 'id' | 'judgment' | 'items' | 'acknowledgements'> = {
  id: 'c1',
  items: [{ id: 'i1', categoryId: 'meal.meeting', facts: {}, hasReceipt: false, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } }],
  acknowledgements: [{ itemId: 'i1', code: 'payee-missing', note: '店名は領収書に無い', by: 'u1', at: '2026-09-02T00:00:00.000Z' }],
  judgment: {
    verdict: 'returned', claimReasons: [{ code: 'policy-unreviewed', severity: 'review', params: {} }],
    items: [{ itemId: 'i1', verdict: 'returned', reasons: [
      { code: 'payee-missing', severity: 'review', itemId: 'i1', params: {} },
      { code: 'per-item-limit-exceeded', severity: 'return', itemId: 'i1', params: { category: '会議費', limit: 5000, over: 100, amount: 5100 } },
    ] }],
    totals: { amount: 5100, byCategory: [] }, searchKeysComplete: false, policyUpdatedAt: 'p', itemsFingerprint: 'f', checkedAt: '2026-09-02T00:00:00.000Z',
  },
};

describe('承認できない理由・判定の読み方', () => {
  it('正常: 判定なし・古い・自己承認はそれぞれの案内と導線を返す', () => {
    expect(summarizeBlocker({ code: 'judgment-missing' }, judgedClaim, en)).toMatchObject({ key: 'judgment-missing:', target: { internalId: 'c1', section: 'claim' }, actionLabel: 'Open Check' });
    expect(summarizeBlocker({ code: 'judgment-stale' }, judgedClaim, ja)).toMatchObject({ title: '判定の後に規程か明細が変わりました', target: { internalId: 'c1', section: 'claim' } });
    expect(summarizeBlocker({ code: 'self-approval' }, judgedClaim, ja)).toMatchObject({ fix: '取り込んだ人とは別の人が承認してください（規程の申請ルールで変更できます）', target: { internalId: '', section: 'rules' }, actionLabel: '規程を開く' });
  });

  it('正常: 理由コードは判定の params を使い、最初の導線先へ連れて行く。判定に無い理由も既定の重さで文言を出す', () => {
    const limit = summarizeBlocker({ code: 'per-item-limit-exceeded', itemId: 'i1' }, judgedClaim, ja);
    expect(limit.title).toContain('5,000 円');
    expect(limit.target).toEqual({ internalId: 'meal.meeting', section: 'category' });
    const payee = summarizeBlocker({ code: 'payee-missing', itemId: 'i1' }, { ...judgedClaim, judgment: undefined }, en);
    expect(payee.target).toEqual({ internalId: 'c1', section: 'item:i1', nodeId: 'payeeName' });
    expect(summarizeBlocker({ code: 'claim-empty' }, { ...judgedClaim, items: [] }, en).target).toEqual({ internalId: 'c1', section: 'item:' });
  });

  it('正常: 承認経路の擬似コード（§20.5.1）は params の段名・承認者・ログイン ID・前の段を差し込み、直す場所へ連れて行く', () => {
    const notCurrent = summarizeBlocker({ code: 'approval-not-current-approver', params: { stepName: '部門長', approvers: '鈴木、高橋', routeId: 'high' } }, judgedClaim, ja);
    expect(notCurrent).toEqual({
      key: 'approval-not-current-approver:', title: 'あなたは現在の段「部門長」の承認者ではありません（承認者: 鈴木、高橋）',
      fix: '承認者に承認を依頼してください。代理で承認するなら、規程の代理承認グループに入れてもらってください', target: { internalId: 'high', section: 'approval' }, actionLabel: '承認経路を開く',
    });
    expect(summarizeBlocker({ code: 'approval-actor-unlinked', params: { subject: 'user@example.com' } }, judgedClaim, ja)).toMatchObject({
      title: 'ログイン ID「user@example.com」が従業員マスタに紐付いていないため、指定の承認者か判定できません', fix: '従業員マスタで自分の「ログイン ID」に user@example.com を足してください',
      target: { internalId: '', section: 'employee' }, actionLabel: '従業員マスタを開く',
    });
    expect(summarizeBlocker({ code: 'approval-claimant-self' }, judgedClaim, ja)).toMatchObject({ title: '申請者本人は自分の申請を承認できません', target: { internalId: '', section: 'approval' } });
    expect(summarizeBlocker({ code: 'approval-same-approver', params: { previousStep: '課長' } }, judgedClaim, ja)).toMatchObject({ title: '前の段「課長」を承認した人は、この段を承認できません', fix: '別の承認者に依頼してください（規程で「同じ人の連続承認」を許すこともできます）' });
    const changed = summarizeBlocker({ code: 'approval-step-changed', params: { stepName: '経理' } }, judgedClaim, ja);
    expect(changed).toMatchObject({ title: '画面を開いた後に承認が進みました（現在の段: 経理）', fix: '画面を再読み込みしてから操作してください', localAction: 'reload', actionLabel: '再読み込み' });
    expect(changed.target).toBeUndefined();
    expect(summarizeBlocker({ code: 'approval-proxy-comment-missing' }, judgedClaim, en)).toMatchObject({ title: 'A proxy approval needs a comment', localAction: 'focus-comment' });
  });

  it.each([
    ['manager-missing', { internalId: 'e9', section: 'employee' }, '山田 さんの上長が未設定です', '従業員マスタで上長を設定してください'],
    ['manager-disabled', { internalId: 'e9', section: 'employee' }, '上長 鈴木 さんが無効です', '上長を設定し直してください'],
    ['department-head-missing', { internalId: 'd1', section: 'organization' }, '部門「営業部」とその上位の部門に部門長がいません', '組織で部門長を設定してください'],
    ['group-empty', { internalId: 'd1', section: 'organization' }, '承認グループ「経理」に有効なメンバーがいません', '組織でメンバーを足してください'],
    ['employee-disabled', { internalId: 'high', section: 'approval' }, '指定の承認者 高橋 さんが無効です', '規程の承認経路で承認者を選び直してください'],
    ['only-claimant', { internalId: 'high', section: 'approval' }, '承認者が申請者本人しかいません', '別の承認者を足すか、規程の承認経路を見直してください'],
    ['claimant-unlinked', { internalId: 'c1', section: 'claimant' }, '申請者が従業員マスタに紐付いていません', '申請の編集で申請者を従業員マスタから選んでください'],
  ])('正常: 承認者が決まらない（原因 %s）は段の名前と原因の文を見出しにし、原因ごとの直す場所を開く', (cause, target, causeText, causeFix) => {
    const params = { stepName: '部門長', cause, claimant: '山田', manager: '鈴木', department: '営業部', group: '経理', employee: '高橋', employeeId: 'e9', departmentId: 'd1', routeId: 'high' };
    const summary = summarizeBlocker({ code: 'approval-route-unresolved', params }, judgedClaim, ja);
    expect(summary).toMatchObject({ key: 'approval-route-unresolved:', title: `段「部門長」の承認者が決まりません（${causeText}）`, fix: causeFix, target });
    expect(summary.actionLabel).not.toBe('');
  });

  it('境界: params の無い approval-route-unresolved は理由コードとして判定の文言を使う', () => {
    const claimWithReason = { ...judgedClaim, judgment: judgedClaim.judgment === undefined ? undefined : { ...judgedClaim.judgment, claimReasons: [{ code: 'approval-route-unresolved' as const, severity: 'review' as const, params: { routeName: '高額', stepName: '課長', cause: 'only-claimant' } }] } };
    const summary = summarizeBlocker({ code: 'approval-route-unresolved' }, claimWithReason, ja);
    expect(summary.title).toBe('承認者が決まらない: 承認経路「高額」の段「課長」の承認者が決まりません（承認者が申請者本人しかいません）');
    expect(summary.target).toEqual({ internalId: '', section: 'employee' });
  });

  it('異常: 知らないコードはコードをそのまま見出しにし、導線を出さない', () => {
    const unknown = summarizeBlocker({ code: 'mystery' }, judgedClaim, en);
    expect(unknown.title).toBe('mystery');
    expect(unknown.target).toBeUndefined();
  });

  it('正常: 要確認の理由と確認済みの記録を突き合わせる', () => {
    const reviews = reviewReasonsOf(judgedClaim);
    expect(reviews.map((entry) => entry.reason.code)).toEqual(['policy-unreviewed', 'payee-missing']);
    expect(reviews[0]?.acknowledged).toBeUndefined();
    expect(reviews[1]?.acknowledged?.note).toBe('店名は領収書に無い');
    expect(reviewReasonsOf({ acknowledgements: [] })).toEqual([]);
  });

  it('正常: 検索要件・明細の見出し・警告の欄', () => {
    expect(searchKeysOf({})).toEqual({ date: false, amount: false, payee: false });
    expect(searchKeysOf({ transactionDate: '2026-09-01', amount: 1, payeeName: ' 店 ' })).toEqual({ date: true, amount: true, payee: true });
    expect(searchKeysOf({ amount: 0, payeeName: '  ' })).toEqual({ date: false, amount: false, payee: false });
    expect(itemLabel({ facts: { description: '弁当' } }, 0, en)).toBe('弁当');
    expect(itemLabel({ facts: { payeeName: '店' } }, 0, en)).toBe('店');
    expect(itemLabel({ facts: {} }, 2, ja)).toBe('明細 3');
    expect([...warningFields(['登録番号の桁数が合いません', '取引日が読めず発行日で代用', '税率別合計と総額が一致しません', '参加人数は読取値です', '目的は読取値', '発行者が空'])].sort())
      .toEqual(['amount', 'attendeesCount', 'payeeName', 'purpose', 'registrationNumber', 'transactionDate']);
    expect(warningFields(['ok']).size).toBe(0);
  });
});

const category: ExpenseCategoryDto = {
  id: 'meal.entertainment', name: '交際費', enabled: true, sortOrder: 1, aliases: [], accountId: 'expense.entertainment', defaultTaxRate: 10, taxCodeByRate: { '10': 'JP-IN-10-S' },
  receipt: { required: true, exemptBelow: 3000 }, invoice: { required: true }, requires: { purpose: true, attendees: true, attendeeDetails: true },
  limits: { perItem: 50000, perClaim: 100000, perPerson: 10000, perPersonBasis: 'tax-included', perUnit: { label: '泊', amount: 12000 } },
};

describe('費目のヒント', () => {
  it('正常: 必須の欄と上限の文言を費目のデータから作る', () => {
    const hints = categoryHints(category, ja);
    expect([...hints.required].sort()).toEqual(['attendeeNames', 'attendeeRelation', 'attendeesCount', 'purpose', 'receipt', 'registrationNumber', 'unitCount']);
    expect(hints.limits).toEqual(['1 件 50,000 円まで', '1 人 10,000 円まで（税込）', '1 泊 12,000 円まで', '1 申請 100,000 円まで', '3,000 円以上は領収書が必要']);
    const excluded = categoryHints({ ...category, receipt: { required: false }, invoice: { required: false }, requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPerson: 5000, perPersonBasis: 'tax-excluded' } }, en);
    expect([...excluded.required]).toEqual([]);
    expect(excluded.limits).toEqual(['Up to ¥5,000 per person (tax excluded)']);
    expect(categoryHints(undefined, en)).toEqual({ required: new Set(), limits: [] });
    expect(categoryHints(category, en).limits[0]).toBe('Up to ¥50,000 per item');
  });
});

describe('入力値', () => {
  it('境界: 日付・整数・一覧', () => {
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026/02/01')).toBe(false);
    expect(parseInteger('')).toBeUndefined();
    expect(parseInteger(' 1,200円 ')).toBe(1200);
    expect(parseInteger('１２００')).toBe(1200);
    expect(parseInteger('¥-5')).toBe(-5);
    expect(parseInteger('12a')).toBeNull();
    expect(splitNames('山田; 佐藤、鈴木\n  ;')).toEqual(['山田', '佐藤', '鈴木']);
    expect(localIsoDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(defaultPeriod(new Date(2026, 1, 10))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('正常: 申請フォーム ⇔ DTO（任意項目は空ならキーを作らない）', () => {
    const empty = emptyClaimDraft(new Date(2026, 8, 3));
    expect(empty).toMatchObject({ name: '', from: '2026-09-01', to: '2026-09-30' });
    expect(Object.keys(claimInputFromDraft(empty).errors)).toEqual(['name']);
    expect(claimInputFromDraft({ ...empty, name: ' 山田 ' }).input).toEqual({ claimant: { name: '山田' }, period: { from: '2026-09-01', to: '2026-09-30' } });
    const full = { name: '山田', employeeCode: 'E1', department: '営業', from: '2026-09-01', to: '2026-09-30', title: '9 月', employeeId: '' };
    expect(claimInputFromDraft(full).input).toEqual({ claimant: { name: '山田', employeeCode: 'E1', department: '営業' }, period: { from: '2026-09-01', to: '2026-09-30' }, title: '9 月' });
    expect(claimDraftFromClaim({ claimant: { name: '山田', employeeCode: 'E1', department: '営業' }, period: { from: '2026-09-01', to: '2026-09-30' }, title: '9 月' })).toEqual(full);
    expect(claimDraftFromClaim({ claimant: { name: '山田' }, period: { from: '2026-09-01', to: '2026-09-30' } })).toMatchObject({ employeeCode: '', department: '', title: '', employeeId: '' });
  });

  it('正常: 従業員マスタの紐付け（employeeId）は下書き ⇔ 保存本文で往復し、空白だけなら送らない', () => {
    const linked = claimDraftFromClaim({ claimant: { name: '山田', employeeId: 'e1', departmentId: 'd1' }, period: { from: '2026-09-01', to: '2026-09-30' } });
    expect(linked.employeeId).toBe('e1');
    expect(claimInputFromDraft(linked).input?.claimant).toEqual({ name: '山田', employeeId: 'e1' });
    expect(claimInputFromDraft({ ...linked, employeeId: '  ' }).input?.claimant).toEqual({ name: '山田' });
  });

  it('正常: 明細の区間は読んだ値 → フォーム → 保存本文で落ちず、消したら送らない', () => {
    const route = { stations: ['新宿', '四ツ谷', '霞ケ関'], trips: 2, fareType: 'ic' as const };
    const draft = itemDraftFrom({ categoryId: 'transport.public', facts: { amount: 398, route } });
    expect(draft.route).toEqual(route);
    expect(itemInputFromDraft(draft, { source: { type: 'manual' } }).input?.facts).toEqual({ amount: 398, route });
    expect(itemInputFromDraft(withOptional(draft, 'route', undefined), { source: { type: 'manual' } }).input?.facts).toEqual({ amount: 398 });
  });

  it('異常: 申請フォームの期間の不備', () => {
    expect(Object.keys(claimInputFromDraft({ ...emptyClaimDraft(), name: 'a', from: 'x', to: 'y' }).errors).sort()).toEqual(['from', 'to']);
    expect(claimInputFromDraft({ ...emptyClaimDraft(), name: 'a', from: '2026-09-30', to: '2026-09-01' }).errors.to?.[1]).toBe('終了日は開始日以降にしてください。');
  });

  it('正常: 明細の読取値 → フォーム → 保存本文（値を推測で埋めず、読取のままの日付は read のまま）', () => {
    const facts = {
      transactionDate: '2026-09-05', issueDate: '2026-09-06', payeeName: '店', registrationNumber: 'T1234567890123', amount: 3300,
      totalsByRate: [{ rate: 10 as const, taxableAmount: 3300, amountIncludesTax: true }], paymentMethod: 'cash' as const, corporatePayment: true,
      description: '弁当', purpose: '会議', attendees: { count: 3, names: ['山田', '佐藤'], relation: '取引先' }, unitCount: 2, preApprovalRef: 'R-1', dateSource: 'read' as const,
    };
    const draft = itemDraftFrom({ categoryId: 'meal.meeting', facts });
    expect(draft.readTransactionDate).toBe('2026-09-05');
    const result = itemInputFromDraft(draft, { itemId: 'i1', source: { type: 'image', fileName: 'r.jpg' }, extraction: { method: 'llm' }, receipt: { dataUrl: 'data:x' } });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({ itemId: 'i1', categoryId: 'meal.meeting', facts, source: { type: 'image', fileName: 'r.jpg' }, extraction: { method: 'llm' }, receipt: { dataUrl: 'data:x' } });
    expect(itemInputFromDraft({ ...draft, transactionDate: '2026-09-04' }, { source: { type: 'manual' } }).input?.facts.dateSource).toBe('manual');
  });

  it('正常: 人が直した欄の読取の印だけを外す（直していない欄の印は残し、全部外れたら flags を送らない）', () => {
    const original = itemDraftFrom({ facts: { payeeName: '店', purpose: '会議', attendees: { count: 2 } } });
    const extraction = { method: 'llm' as const, flags: ['attendees-read', 'payee-read', 'purpose-read'] as const };
    expect(confirmedExtraction(extraction, original, { ...original, attendeesCount: '3' })).toEqual({ method: 'llm', flags: ['payee-read', 'purpose-read'] });
    expect(confirmedExtraction(extraction, original, original)).toBe(extraction);
    expect(confirmedExtraction(extraction, original, { ...original, attendeesCount: '3', payeeName: '別の店', purpose: '打合せ' })).toEqual({ method: 'llm' });
    // 区間は構造（駅の並び）で比べる。
    const routed = { ...original, route: { stations: ['新宿', '霞ケ関'], trips: 1 } };
    expect(confirmedExtraction({ flags: ['route-read'] }, routed, { ...routed, route: { stations: ['新宿', '大手町'], trips: 1 } })).toEqual({});
    // 渡さなければ印はそのまま（新規・読取直後の保存）。
    expect(itemInputFromDraft({ ...original, attendeesCount: '3' }, { source: { type: 'manual' }, extraction }).input?.extraction).toEqual(extraction);
    expect(itemInputFromDraft({ ...original, attendeesCount: '3' }, { source: { type: 'manual' }, extraction, original }).input?.extraction).toEqual({ method: 'llm', flags: ['payee-read', 'purpose-read'] });
  });

  it('境界: reads-disagree は食い違った欄をすべて直したときだけ外す。発行日の代用は取引日を直せば外す', () => {
    const original = itemDraftFrom({ facts: { transactionDate: '2026-09-01', registrationNumber: 'T1234567890123' } });
    const detail = { disagreements: [{ field: 'registrationNumber', journalValue: 'T1234567890123', detailValue: 'T123456789012' }, { field: 'transactionDate', journalValue: '2026-09-01', detailValue: '2026-09-02' }] };
    const extraction = { flags: ['reads-disagree', 'transaction-date-substituted'], detail } as unknown as Parameters<typeof confirmedExtraction>[0];
    expect(confirmedExtraction(extraction, original, { ...original, transactionDate: '2026-09-02' }).flags).toEqual(['reads-disagree']);
    expect(confirmedExtraction(extraction, original, { ...original, transactionDate: '2026-09-02', registrationNumber: 'T9999999999999' }).flags).toBeUndefined();
    // 食い違いの欄が記録に無ければ（古いデータ）外さない。
    expect(confirmedExtraction({ flags: ['reads-disagree'] }, original, { ...original, payeeName: 'x' }).flags).toEqual(['reads-disagree']);
  });

  it('正常: 発行日を取引日にすると issue-copied。発行日が無ければ何もしない。空のフォームは facts が空', () => {
    const copied = copyIssueDate({ ...emptyItemDraft(), issueDate: '2026-09-01' });
    expect(copied).toMatchObject({ transactionDate: '2026-09-01', dateSource: 'issue-copied' });
    expect(itemInputFromDraft(copied, { source: { type: 'manual' } }).input?.facts).toEqual({ transactionDate: '2026-09-01', issueDate: '2026-09-01', dateSource: 'issue-copied' });
    const empty = emptyItemDraft();
    expect(copyIssueDate(empty)).toBe(empty);
    expect(itemInputFromDraft(empty, { source: { type: 'manual' } }).input).toEqual({ facts: {}, source: { type: 'manual' } });
    expect(itemInputFromDraft({ ...empty, categoryText: ' 交通 ' }, { source: { type: 'csv-row' } }).input?.categoryText).toBe('交通');
    expect(itemDraftFrom({ facts: {} })).toEqual(empty);
  });

  it('異常: 明細の入力の不備は欄ごとのエラー。形の合わない登録番号は止めずに警告', () => {
    const bad = itemInputFromDraft({ ...emptyItemDraft(), amount: '0', transactionDate: '2026-13-01', issueDate: 'x', attendeesCount: '0', unitCount: 'a' }, { source: { type: 'manual' } });
    expect(bad.input).toBeUndefined();
    expect(Object.keys(bad.errors).sort()).toEqual(['amount', 'attendeesCount', 'issueDate', 'transactionDate', 'unitCount']);
    expect(Object.keys(itemInputFromDraft({ ...emptyItemDraft(), amount: 'abc' }, { source: { type: 'manual' } }).errors)).toEqual(['amount']);
    const warned = itemInputFromDraft({ ...emptyItemDraft(), registrationNumber: 't-123' }, { source: { type: 'manual' } });
    expect(warned.warnings).toHaveLength(1);
    expect(warned.input?.facts.registrationNumber).toBe('T123');
  });
});

const validPolicy: SaveExpensePolicyDto = {
  categories: [category], preApprovalRules: [{ id: 'r1', name: '高額', enabled: true, categoryIds: ['meal.entertainment'], minAmount: 50000 }],
  claimRules: { submissionDeadlineDays: 90, nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false },
  severityOverrides: {}, journal: { creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant}' },
};

describe('規程の編集', () => {
  it('正常: 正しい規程には指摘が無い', () => {
    expect(policyIssues(validPolicy)).toEqual([]);
  });

  it('異常: 費目・事前承認条件・申請ルール・仕訳設定の不備をパス付きで返す', () => {
    const broken: SaveExpensePolicyDto = {
      ...validPolicy,
      categories: [
        { ...category, id: 'Bad Id', name: ' ', receipt: { required: true, exemptBelow: -1 }, requires: { ...category.requires, attendees: false }, limits: { perItem: 0.5, perPersonBasis: 'tax-included', perPerson: 100, perUnit: { label: '', amount: Number.NaN } } },
        { ...category }, { ...category },
      ],
      preApprovalRules: [{ id: 'r1', name: '', enabled: true, categoryIds: [] }, { id: 'r2', name: 'x', enabled: true, categoryIds: ['ghost'], minPerPerson: 200_000_000 }],
      claimRules: { ...validPolicy.claimRules, submissionDeadlineDays: 0 },
      journal: { ...validPolicy.journal, creditAccountId: ' ', descriptionTemplate: 'x'.repeat(201) },
    };
    expect(policyIssues(broken).map((issue) => issue.path)).toEqual([
      'categories.0.id', 'categories.0.name', 'categories.0.limits.perItem', 'categories.0.limits.perUnit.amount', 'categories.0.limits.perUnit.label', 'categories.0.requires.attendees', 'categories.0.receipt.exemptBelow',
      'categories.2.id',
      'preApprovalRules.0.name', 'preApprovalRules.0.categoryIds', 'preApprovalRules.1.minPerPerson', 'preApprovalRules.1.categoryIds',
      'claimRules.submissionDeadlineDays', 'journal.creditAccountId', 'journal.descriptionTemplate',
    ]);
  });

  it('正常: 保存本文・新しい費目 / 条件・数値欄・任意キー・重さの上書き', () => {
    expect(policyBody({ ...validPolicy, updatedAt: 'x' })).toEqual(validPolicy);
    const added = newCategory([category, { ...category, id: 'category-2', sortOrder: 5 }]);
    expect(added).toMatchObject({ id: 'category-3', name: '', enabled: true, sortOrder: 6, taxCodeByRate: category.taxCodeByRate, limits: { perPersonBasis: 'tax-included' } });
    expect(newCategory([])).toMatchObject({ id: 'category-1', sortOrder: 1, taxCodeByRate: {} });
    // 件数 + 1 から空いている番号を探す（rule-2 が使われていれば rule-3）。
    expect(newPreApprovalRule([{ id: 'rule-2', name: 'x', enabled: true, categoryIds: [] }])).toEqual({ id: 'rule-3', name: '', enabled: true, categoryIds: [] });
    expect(newPreApprovalRule([])).toEqual({ id: 'rule-1', name: '', enabled: true, categoryIds: [] });
    expect(amountFromInput('')).toBeUndefined();
    expect(amountFromInput('1,000')).toBe(1000);
    expect(amountFromInput('x')).toBeNaN();
    expect(withOptional({ a: 1, b: 2 }, 'b', undefined)).toEqual({ a: 1 });
    expect(withOptional({ a: 1 }, 'b', 3)).toEqual({ a: 1, b: 3 });
    expect(withSeverityOverride({ 'payee-missing': 'return' }, 'payee-missing', '')).toEqual({});
    expect(withSeverityOverride({}, 'purpose-missing', 'off')).toEqual({ 'purpose-missing': 'off' });
    expect(accountKnown(undefined, [])).toBe(true);
    expect(accountKnown('', [])).toBe(true);
    expect(accountKnown('a', [{ id: 'a', enabled: true }])).toBe(true);
    expect(accountKnown('a', [{ id: 'a', enabled: false }])).toBe(false);
    expect(sumAmounts([{ totalAmount: 100 }, { totalAmount: 250 }])).toBe(350);
  });

  it('正常: 保存本文は実用化の節（承認経路・交通費・カード・仮払）と費目の区間・仕訳の部門の補助軸を引き継ぐ', () => {
    const practical: ExpensePolicyDto = {
      ...validPolicy, updatedAt: 'x',
      categories: [{ ...category, route: { required: true, commuterPass: true, fareTable: false } }],
      journal: { ...validPolicy.journal, departmentDimensionId: 'department' },
      approval: { routes: [], defaultSteps: [{ id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }], forbidClaimantApproval: true, requireDistinctApprovers: false },
      transport: { commuterPassDeduction: true, fareToleranceYen: 10, defaultFareType: 'ic' },
      card: { acceptCorporatePaymentItems: true, dateToleranceDays: 3, amountToleranceYen: 0, weakMatchMinAmount: 3000, creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA' },
      advance: { advanceAccountId: 'asset.suspense_paid', paymentAccountId: 'asset.ordinary_deposit', refundAccountId: 'asset.ordinary_deposit', settleWithinDays: 30 },
    };
    const { updatedAt: _updatedAt, ...expected } = practical;
    expect(policyBody(practical)).toEqual(expected);
    // 無い節はキーを作らない（null や undefined を送って既定値と取り違えさせない）。
    expect(Object.keys(policyBody(validPolicy)).sort()).toEqual(['categories', 'claimRules', 'journal', 'preApprovalRules', 'severityOverrides']);
  });

  it('正常: ApiError.details の取り出しは形の違う値を捨てる', () => {
    const details = { blockingReasons: [{ code: 'payee-missing' }, 3, null], problems: [{ message: 'm', fixTarget: 'item' }, { message: 'no target' }], ids: ['e1', 2], notArray: 'x' };
    expect(detailArray(details, 'blockingReasons', isBlockingReason)).toEqual([{ code: 'payee-missing' }]);
    expect(detailArray(details, 'problems', isJournalLinkProblem)).toEqual([{ message: 'm', fixTarget: 'item' }]);
    expect(detailArray(details, 'ids', isString)).toEqual(['e1']);
    expect(detailArray(details, 'notArray', isString)).toEqual([]);
    expect(detailArray(undefined, 'ids', isString)).toEqual([]);
  });
});

describe('実用機能の準備状況', () => {
  it('境界: 何も分からなければ 5 行とも未設定で、承認経路だけは規程の経路の有無で決まる', () => {
    const rows = readinessRows(undefined);
    expect(rows.map((row) => [row.key, row.configured])).toEqual([['employees', false], ['approval', false], ['payout', false], ['cards', false], ['fares', false]]);
    expect(readinessRows({ approval: { routes: [], defaultSteps: [], forbidClaimantApproval: true, requireDistinctApprovers: false } }).find((row) => row.key === 'approval')?.configured).toBe(false);
    const route = { id: 'r1', name: '高額', enabled: true, when: { categoryIds: [], departmentIds: [] }, steps: [] };
    expect(readinessRows({ approval: { routes: [route], defaultSteps: [], forbidClaimantApproval: true, requireDistinctApprovers: false } }).find((row) => row.key === 'approval')?.configured).toBe(true);
  });

  it('正常: 系統の設定が分かれば渡した値で ✓ にし、「開く」は台帳のタブ・規程の承認経路・精算出力へ', () => {
    const rows = readinessRows(undefined, { employees: true, payout: false, cards: true });
    expect(rows.filter((row) => row.configured).map((row) => row.key)).toEqual(['employees', 'cards']);
    expect(rows.map((row) => row.target)).toEqual([{ tab: 'employees' }, { internalId: '', section: 'approval' }, { tab: 'settle' }, { tab: 'cards' }, { tab: 'fares' }]);
    const titles = rows.map((row) => readinessLabel(row.key, ja).title);
    expect(titles).toEqual(['従業員マスタ', '承認経路', '振込元', 'カード', '運賃']);
    for (const row of rows) expect(readinessLabel(row.key, en).unlocks).not.toBe(readinessLabel(row.key, ja).unlocks);
  });
});

describe('ラベル', () => {
  it('正常: 支払方法・状態・判定・重さ・CSV 項目は日英の表示名を持ち、知らない値はそのまま出す', () => {
    for (const method of ['cash', 'credit_card', 'bank_transfer', 'qr', 'e_money', 'direct_debit', 'corporate', 'unknown']) expect(paymentMethodLabel(method, ja)).not.toBe(method);
    expect(paymentMethodLabel('bitcoin', ja)).toBe('bitcoin');
    for (const status of EXPENSE_CLAIM_STATUSES) expect(claimStatusLabel(status, en)).not.toBe(status);
    expect(claimStatusLabel('in-approval', ja)).toBe('承認中');
    expect(claimStatusLabel('archived', en)).toBe('archived');
    for (const status of ['requested', 'approved', 'paid', 'settling', 'settled', 'cancelled']) expect(advanceStatusLabel(status, en)).not.toBe(status);
    expect(advanceStatusLabel('paid', ja)).toBe('支払済み');
    expect(advanceStatusLabel('lost', ja)).toBe('lost');
    expect(['pass', 'needs-review', 'returned', undefined].map((verdict) => verdictLabel(verdict as never, ja))).toEqual(['通過', '要確認', '差し戻し', '未チェック']);
    expect(['review', 'return', 'off'].map((severity) => severityLabel(severity as never, ja))).toEqual(['要確認', '差し戻し', '出さない']);
    const fields = ['claimant', 'employeeCode', 'department', 'transactionDate', 'payeeName', 'amount', 'category', 'purpose', 'attendeeCount', 'attendeeNames', 'relation', 'unitCount', 'paymentMethod', 'corporatePayment', 'registrationNumber', 'preApprovalRef', 'description'];
    for (const field of fields) expect(csvFieldLabel(field, en)).not.toBe(field);
    expect(csvFieldLabel(null, ja)).toBe('（当たらない）');
    expect(csvFieldLabel('other', ja)).toBe('other');
  });
});
