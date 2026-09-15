import { describe, expect, it } from 'vitest';
import { checkClaim, checkReceipt } from './check';
import type { ExpenseItem, ItemExtraction } from './claim';
import { payeeKeyOf, type DuplicateCandidate } from './duplicates';
import { allReasons, type CheckReason, type ClaimJudgment } from './judgment';
import { createExpensePolicy, type CreateExpensePolicyProps, type ExpenseCategory, type ExpensePolicy } from './policy';
import { MVP_REASON_CODES, REASON_CATALOG, REASON_CODES, type ExpenseReasonCode } from './reason-codes';
import type { ReceiptFacts } from './receipt-facts';

/*
 * 判定の数値はテストの規程にだけ置く（check.ts は規程のデータしか見ない）。
 * 初期テンプレートと同じ値を使うと「コードに数値が埋まっている」ことを見逃すので、テンプレートとずらした値にしている。
 */
const TODAY = '2026-09-30';
const PERIOD = { from: '2026-09-01', to: '2026-09-30' } as const;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function category(id: string, overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id,
    name: id,
    enabled: true,
    sortOrder: 10,
    aliases: [],
    accountId: 'expense.travel',
    defaultTaxRate: 10,
    taxCodeByRate: { '10': 'JP-IN-10-S', '8': 'JP-IN-8R-S', '0': 'JP-IN-NA' },
    receipt: { required: false },
    invoice: { required: false },
    requires: { purpose: false, attendees: false, attendeeDetails: false },
    limits: { perPersonBasis: 'tax-included' },
    ...overrides,
  };
}

function policyProps(overrides: Partial<CreateExpensePolicyProps> = {}): CreateExpensePolicyProps {
  return {
    categories: [
      category('plain'),
      category('taxi', {
        receipt: { required: true },
        invoice: { required: true },
        requires: { purpose: true, attendees: false, attendeeDetails: false },
        limits: { perItem: 10_001, perClaim: 30_003, perPersonBasis: 'tax-included' },
      }),
      category('meal', { requires: { purpose: false, attendees: true, attendeeDetails: true }, limits: { perPerson: 10_001, perPersonBasis: 'tax-included' } }),
      category('meal-net', { requires: { purpose: false, attendees: true, attendeeDetails: false }, limits: { perPerson: 10_001, perPersonBasis: 'tax-excluded' } }),
      category('lodging', { limits: { perPersonBasis: 'tax-included', perUnit: { label: '泊', amount: 12_001 } } }),
      category('train', { receipt: { required: true, exemptBelow: 30_001 }, invoice: { required: true, exemptBelow: 30_001 } }),
      category('retired', { enabled: false, limits: { perClaim: 1, perPersonBasis: 'tax-included' } }),
    ],
    claimRules: { submissionDeadlineDays: 31, nonReimbursablePaymentMethods: ['direct_debit'], attendeesIncludeClaimant: true, forbidSelfApproval: false },
    preApprovalRules: [],
    severityOverrides: {},
    journal: { creditAccountId: 'liability.other_payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '立替精算 {claimant}' },
    updatedAt: '2026-09-14T00:00:00.000Z',
    ...overrides,
  };
}

const POLICY = createExpensePolicy(policyProps());
const policyWith = (overrides: Partial<CreateExpensePolicyProps>): ExpensePolicy => createExpensePolicy(policyProps(overrides));

type ItemOverrides = Omit<Partial<ExpenseItem>, 'facts' | 'extraction'> & { readonly facts?: Partial<ReceiptFacts>; readonly extraction?: Partial<ItemExtraction> };

/** 何の理由も出ない明細（費目 plain・取引日・支払先・金額あり）を土台に、差分だけを書く。 */
function item(overrides: ItemOverrides = {}): ExpenseItem {
  const { facts, extraction, ...rest } = overrides;
  return {
    id: 'i1',
    categoryId: 'plain',
    facts: { transactionDate: '2026-09-10', payeeName: 'サンプル商店', amount: 1000, ...facts },
    source: { type: 'manual' },
    extraction: { method: 'manual', warnings: [], ...extraction },
    ...rest,
  };
}

function candidate(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    claimId: 'c2',
    itemId: 'x1',
    claimStatus: 'approved',
    claimantName: 'テスト花子',
    payeeKey: payeeKeyOf('サンプル商店'),
    transactionDate: '2026-09-10',
    amount: 1000,
    ...overrides,
  };
}

interface Scenario {
  readonly items?: readonly ExpenseItem[];
  readonly policy?: ExpensePolicy;
  readonly policySaved?: boolean;
  readonly candidates?: readonly DuplicateCandidate[];
  readonly receiptHashes?: ReadonlyMap<string, string>;
  readonly today?: string;
}

function judge(scenario: Scenario = {}): ClaimJudgment {
  return checkClaim({
    claim: { id: 'c1', period: PERIOD, items: scenario.items ?? [item()] },
    policy: scenario.policy ?? POLICY,
    policySaved: scenario.policySaved ?? true,
    duplicateCandidates: scenario.candidates ?? [],
    today: scenario.today ?? TODAY,
    ...(scenario.receiptHashes === undefined ? {} : { receiptHashes: scenario.receiptHashes }),
  });
}

const codesOf = (judgment: ClaimJudgment): readonly ExpenseReasonCode[] => allReasons(judgment).map((reason) => reason.code);
const reasonOf = (judgment: ClaimJudgment, code: ExpenseReasonCode): CheckReason | undefined => allReasons(judgment).find((reason) => reason.code === code);

const MEAL_ATTENDEES = { count: 2, names: ['テスト次郎'], relation: '取引先' } as const;
const threeTaxis = (last: number): ExpenseItem[] => [
  item({ id: 't1', categoryId: 'taxi', receiptId: 'r1', facts: { payeeName: '甲交通', amount: 10_001, purpose: '訪問', registrationNumber: 'T1234567890123' } }),
  item({ id: 't2', categoryId: 'taxi', receiptId: 'r2', facts: { payeeName: '乙交通', amount: 10_001, purpose: '訪問', registrationNumber: 'T1234567890123' } }),
  item({ id: 't3', categoryId: 'taxi', receiptId: 'r3', facts: { payeeName: '丙交通', amount: last, purpose: '訪問', registrationNumber: 'T1234567890123' } }),
];

/** [コード, 出る入力, 出ない入力]。出ない側は出る側から原因だけを取り除いた最小の差にする。 */
const CODE_TABLE: readonly (readonly [ExpenseReasonCode, Scenario, Scenario])[] = [
  ['policy-unreviewed', { policySaved: false }, { policySaved: true }],
  ['claim-empty', { items: [] }, { items: [item()] }],
  ['category-missing', { items: [item({ categoryId: undefined, categoryText: '謎の費目' })] }, { items: [item()] }],
  ['category-unknown', { items: [item({ categoryId: 'no-such-category' })] }, { items: [item({ categoryId: 'plain' })] }],
  ['amount-missing', { items: [item({ facts: { amount: undefined } })] }, { items: [item({ facts: { amount: 1 } })] }],
  ['date-missing', { items: [item({ facts: { transactionDate: undefined } })] }, { items: [item()] }],
  ['payee-missing', { items: [item({ facts: { payeeName: '   ' } })] }, { items: [item({ facts: { payeeName: 'サンプル商店' } })] }],
  ['purpose-missing', { items: [item({ categoryId: 'taxi' })] }, { items: [item({ categoryId: 'taxi', facts: { purpose: '客先訪問' } })] }],
  ['receipt-missing', { items: [item({ categoryId: 'taxi' })] }, { items: [item({ categoryId: 'taxi', receiptId: 'r1' })] }],
  ['receipt-extraction-warning', { items: [item({ extraction: { warnings: ['取引日は発行日で代用しました'] } })] }, { items: [item({ extraction: { warnings: [] } })] }],
  ['receipt-amount-mismatch',
    { items: [item({ facts: { totalsByRate: [{ rate: 10, taxableAmount: 1002, amountIncludesTax: true }] } })] },
    { items: [item({ facts: { totalsByRate: [{ rate: 10, taxableAmount: 1001, amountIncludesTax: true }] } })] }],
  ['date-in-future', { items: [item({ facts: { transactionDate: '2026-10-01' } })] }, { items: [item({ facts: { transactionDate: '2026-09-30' } })] }],
  ['date-outside-period', { items: [item({ facts: { transactionDate: '2026-08-31' } })] }, { items: [item({ facts: { transactionDate: '2026-09-01' } })] }],
  ['submission-late',
    { items: [item({ facts: { transactionDate: '2026-09-01' }, addedOn: '2026-10-03' })] },
    { items: [item({ facts: { transactionDate: '2026-09-01' }, addedOn: '2026-10-02' })] }],
  ['payment-not-reimbursable', { items: [item({ facts: { corporatePayment: true } })] }, { items: [item({ facts: { corporatePayment: false, paymentMethod: 'cash' } })] }],
  ['registration-number-missing', { items: [item({ categoryId: 'taxi' })] }, { items: [item({ categoryId: 'taxi', facts: { registrationNumber: 'T1234567890123' } })] }],
  ['per-item-limit-exceeded', { items: [item({ categoryId: 'taxi', facts: { amount: 10_002 } })] }, { items: [item({ categoryId: 'taxi', facts: { amount: 10_001 } })] }],
  ['attendees-missing', { items: [item({ categoryId: 'meal' })] }, { items: [item({ categoryId: 'meal', facts: { attendees: MEAL_ATTENDEES } })] }],
  ['per-person-limit-exceeded',
    { items: [item({ categoryId: 'meal', facts: { amount: 20_003, attendees: MEAL_ATTENDEES } })] },
    { items: [item({ categoryId: 'meal', facts: { amount: 20_002, attendees: MEAL_ATTENDEES } })] }],
  ['attendee-details-missing', { items: [item({ categoryId: 'meal', facts: { attendees: { count: 2 } } })] }, { items: [item({ categoryId: 'meal', facts: { attendees: MEAL_ATTENDEES } })] }],
  ['unit-count-missing', { items: [item({ categoryId: 'lodging' })] }, { items: [item({ categoryId: 'lodging', facts: { unitCount: 1 } })] }],
  ['per-unit-limit-exceeded',
    { items: [item({ categoryId: 'lodging', facts: { amount: 24_003, unitCount: 2 } })] },
    { items: [item({ categoryId: 'lodging', facts: { amount: 24_002, unitCount: 2 } })] }],
  ['pre-approval-missing',
    { policy: policyWith({ preApprovalRules: [{ id: 'big', name: '大口', enabled: true, categoryIds: [], minAmount: 5000 }] }), items: [item({ facts: { amount: 5000 } })] },
    { policy: policyWith({ preApprovalRules: [{ id: 'big', name: '大口', enabled: true, categoryIds: [], minAmount: 5000 }] }), items: [item({ facts: { amount: 5000, preApprovalRef: '稟議-1' } })] }],
  ['duplicate-in-claim', { items: [item({ id: 'i1' }), item({ id: 'i2' })] }, { items: [item({ id: 'i1' }), item({ id: 'i2', facts: { amount: 1001 } })] }],
  ['duplicate-across-claims', { candidates: [candidate()] }, { candidates: [candidate({ amount: 1001 })] }],
  ['duplicate-receipt-image',
    { receiptHashes: new Map([['i1', SHA_A]]), candidates: [candidate({ transactionDate: '2026-01-01', amount: 9, receiptSha256: SHA_A })] },
    { receiptHashes: new Map([['i1', SHA_A]]), candidates: [candidate({ transactionDate: '2026-01-01', amount: 9, receiptSha256: SHA_B })] }],
  ['per-claim-limit-exceeded', { items: threeTaxis(10_002) }, { items: threeTaxis(10_001) }],
];

describe('checkClaim: 27 理由コードの出る / 出ない', () => {
  // 実用化の 16 コードは系統の検査関数が出すので、差し込みの規律は check-contributors.test.ts で見る。
  it('正常: 表が MVP の 27 理由コードを 1 回ずつ網羅している', () => {
    expect(CODE_TABLE.map(([code]) => code)).toEqual([...MVP_REASON_CODES]);
  });

  it('正常: 土台の明細は理由なしで通過（表の「出ない」側が意味を持つ前提）', () => {
    const judgment = judge();
    expect(judgment.verdict).toBe('pass');
    expect(codesOf(judgment)).toEqual([]);
    expect(judgment.searchKeysComplete).toBe(true);
  });

  it.each(CODE_TABLE)('正常: %s は原因があれば出る（既定の重さ・対象・検索要件つき）', (code, fires) => {
    const judgment = judge(fires);
    const reason = reasonOf(judgment, code);
    expect(reason, `${code} が出ていない: ${codesOf(judgment).join(', ')}`).toBeDefined();
    const entry = REASON_CATALOG[code];
    expect(reason!.severity).toBe(entry.defaultSeverity);
    expect(reason!.searchKey).toBe(entry.searchKey);
    // 明細の理由は明細に、申請の理由は claimReasons に入る（画面が置き場所を取り違えないため）。
    if (entry.target === 'claim') {
      expect(judgment.claimReasons.map((entry) => entry.code)).toContain(code);
      expect(reason!.itemId).toBeUndefined();
    } else {
      expect(reason!.itemId).toBeDefined();
      expect(judgment.items.find((check) => check.itemId === reason!.itemId)?.reasons.map((entry) => entry.code)).toContain(code);
    }
    expect(judgment.verdict).toBe(entry.defaultSeverity === 'return' ? 'returned' : judgment.verdict);
  });

  it.each(CODE_TABLE)('異常: %s は原因を取り除けば出ない', (code, _fires, clean) => {
    expect(codesOf(judge(clean))).not.toContain(code);
  });
});

describe('checkClaim: 境界', () => {
  it('境界: 1 件上限ちょうどは超過なし、+1 円で超過（over / limit / amount を差し込む）', () => {
    const at = judge({ items: [item({ categoryId: 'taxi', facts: { amount: 10_001 } })] });
    expect(codesOf(at)).not.toContain('per-item-limit-exceeded');
    const over = reasonOf(judge({ items: [item({ categoryId: 'taxi', facts: { amount: 10_002 } })] }), 'per-item-limit-exceeded');
    expect(over?.params).toMatchObject({ category: 'taxi', limit: 10_001, over: 1, amount: 10_002 });
  });

  it('境界: 1 人あたり 10,000 × 4 人 = 40,000 は通過、40,001 は超過（割り算をしない）', () => {
    const policy = policyWith({ categories: [category('meal', { requires: { purpose: false, attendees: true, attendeeDetails: false }, limits: { perPerson: 10_000, perPersonBasis: 'tax-included' } })] });
    const at = judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: 40_000, attendees: { count: 4 } } })] });
    expect(codesOf(at)).not.toContain('per-person-limit-exceeded');
    const over = reasonOf(judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: 40_001, attendees: { count: 4 } } })] }), 'per-person-limit-exceeded');
    expect(over?.params).toMatchObject({ perPerson: 10_000, count: 4, limit: 10_000, basis: 'tax-included', basisFallback: false });
  });

  it('境界: exemptBelow 未満は領収書・登録番号とも不要、ちょうどから必要', () => {
    const policy = policyWith({ categories: [category('train', { receipt: { required: true, exemptBelow: 30_000 }, invoice: { required: true, exemptBelow: 30_000 } })] });
    const below = codesOf(judge({ policy, items: [item({ categoryId: 'train', facts: { amount: 29_999 } })] }));
    expect(below).not.toContain('receipt-missing');
    expect(below).not.toContain('registration-number-missing');
    const at = judge({ policy, items: [item({ categoryId: 'train', facts: { amount: 30_000 } })] });
    expect(codesOf(at)).toEqual(expect.arrayContaining(['receipt-missing', 'registration-number-missing']));
    expect(reasonOf(at, 'receipt-missing')?.params).toMatchObject({ exemptBelow: 30_000 });
  });

  it('境界: 期間の初日・末日は期間内、前日・翌日は期間外', () => {
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: '2026-09-01' } })] }))).not.toContain('date-outside-period');
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: '2026-09-30' } })] }))).not.toContain('date-outside-period');
    const before = reasonOf(judge({ items: [item({ facts: { transactionDate: '2026-08-31' } })] }), 'date-outside-period');
    expect(before?.params).toMatchObject({ date: '2026-08-31', from: '2026-09-01', to: '2026-09-30' });
    // 翌日は判定日も後ろへずらす（未来の日付として先に打ち切られないように）。
    expect(codesOf(judge({ today: '2026-10-05', items: [item({ facts: { transactionDate: '2026-10-01' }, addedOn: '2026-10-05' })] }))).toContain('date-outside-period');
  });

  it('境界: 提出期限ちょうど（addedOn 基準）は遅延なし、1 日過ぎたら遅延', () => {
    // 期限 31 日。2026-09-01 → 2026-10-02 は 31 日。
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: '2026-09-01' }, addedOn: '2026-10-02' })] }))).not.toContain('submission-late');
    const late = reasonOf(judge({ items: [item({ facts: { transactionDate: '2026-09-01' }, addedOn: '2026-10-03' })] }), 'submission-late');
    expect(late?.params).toMatchObject({ date: '2026-09-01', days: 32, limitDays: 31 });
  });

  it('境界: addedOn が無ければ判定日を起点にし、期限が未設定なら遅延を出さない', () => {
    // 2026-08-29 → 判定日 2026-09-30 は 32 日（期間外も出るが、ここでは遅延だけを見る）。
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: '2026-08-29' } })] }))).toContain('submission-late');
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: '2026-08-30' } })] }))).not.toContain('submission-late');
    const noDeadline = policyWith({ claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false } });
    expect(codesOf(judge({ policy: noDeadline, items: [item({ facts: { transactionDate: '2026-01-01' } })] }))).not.toContain('submission-late');
  });

  it('境界: 判定日当日は未来でない、翌日は未来', () => {
    expect(codesOf(judge({ items: [item({ facts: { transactionDate: TODAY } })] }))).not.toContain('date-in-future');
    const future = reasonOf(judge({ items: [item({ facts: { transactionDate: '2026-10-01' } })] }), 'date-in-future');
    expect(future?.params).toMatchObject({ date: '2026-10-01', today: TODAY });
  });

  it('境界: 税抜基準で内訳が無いときは税込で判定し、basisFallback を立てる（黙って税込にしない）', () => {
    const reason = reasonOf(judge({ items: [item({ categoryId: 'meal-net', facts: { amount: 20_003, attendees: { count: 2 } } })] }), 'per-person-limit-exceeded');
    expect(reason?.params).toMatchObject({ basis: 'tax-included', basisFallback: true, count: 2 });
  });

  it('境界: 税抜基準で内訳があれば税額を除いて判定する（ちょうどは通過・超えたら basisFallback なしで超過）', () => {
    // 22,002 円（10%）の税額は floor(22002 × 10 / 110) = 2000、税抜 20,002 = 10,001 × 2 人 → 通過。
    const at = judge({ items: [item({ categoryId: 'meal-net', facts: { amount: 22_002, totalsByRate: [{ rate: 10, taxableAmount: 22_002, amountIncludesTax: true }], attendees: { count: 2 } } })] });
    expect(codesOf(at)).not.toContain('per-person-limit-exceeded');
    const over = reasonOf(judge({ items: [item({ categoryId: 'meal-net', facts: { amount: 22_004, totalsByRate: [{ rate: 10, taxableAmount: 22_004, amountIncludesTax: true }], attendees: { count: 2 } } })] }), 'per-person-limit-exceeded');
    expect(over?.params).toMatchObject({ basis: 'tax-excluded', basisFallback: false });
  });

  it('境界: 申請者を人数に含む（入力値のまま）/ 含まない（+1 人）で結果が変わる', () => {
    const facts = { amount: 30_003, attendees: MEAL_ATTENDEES } as const;
    // 含む: 2 人 → 上限 20,002 を超える。
    const included = reasonOf(judge({ items: [item({ categoryId: 'meal', facts })] }), 'per-person-limit-exceeded');
    expect(included?.params).toMatchObject({ count: 2 });
    // 含まない: 3 人 → 上限 30,003 ちょうどで通過。
    const excluded = policyWith({ claimRules: { submissionDeadlineDays: 31, nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: false, forbidSelfApproval: false } });
    expect(codesOf(judge({ policy: excluded, items: [item({ categoryId: 'meal', facts })] }))).not.toContain('per-person-limit-exceeded');
  });

  it('境界: 税率別内訳のずれは行数円まで許す（1 行で 1 円は許容、2 行なら 2 円まで）', () => {
    const one = (taxable: number) => judge({ items: [item({ facts: { totalsByRate: [{ rate: 10, taxableAmount: taxable, amountIncludesTax: true }] } })] });
    expect(codesOf(one(999))).not.toContain('receipt-amount-mismatch');
    expect(reasonOf(one(998), 'receipt-amount-mismatch')?.params).toMatchObject({ sum: 998, amount: 1000, diff: 2, tolerance: 1 });
    const two = judge({ items: [item({ facts: { totalsByRate: [{ rate: 10, taxableAmount: 500, amountIncludesTax: true }, { rate: 8, taxableAmount: 498, amountIncludesTax: true }] } })] });
    expect(codesOf(two)).not.toContain('receipt-amount-mismatch');
  });

  it('境界: 事前承認の金額条件は「以上」（ちょうどで当たり、1 円下は当たらない）、1 人あたり条件は人数を掛ける', () => {
    const policy = policyWith({ preApprovalRules: [{ id: 'per', name: '1 人 5,000 円以上', enabled: true, categoryIds: ['meal'], minPerPerson: 5000 }] });
    const meal = (amount: number) => item({ categoryId: 'meal', facts: { amount, attendees: MEAL_ATTENDEES } });
    expect(reasonOf(judge({ policy, items: [meal(10_000)] }), 'pre-approval-missing')?.params).toMatchObject({ ruleId: 'per', ruleName: '1 人 5,000 円以上' });
    expect(codesOf(judge({ policy, items: [meal(9_999)] }))).not.toContain('pre-approval-missing');
    // 人数が無ければ 1 人あたりを計算できないので当たらない（attendees-missing は別に出る）。
    expect(codesOf(judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: 99_999 } })] }))).not.toContain('pre-approval-missing');
    const plain = policyWith({ preApprovalRules: [{ id: 'big', name: '大口', enabled: true, categoryIds: [], minAmount: 5000 }] });
    expect(codesOf(judge({ policy: plain, items: [item({ facts: { amount: 4999 } })] }))).not.toContain('pre-approval-missing');
  });

  it('境界: 申請者を含まない規程では事前承認の 1 人あたり条件も +1 人で数える', () => {
    const policy = policyWith({
      claimRules: { submissionDeadlineDays: 31, nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: false, forbidSelfApproval: false },
      preApprovalRules: [{ id: 'per', name: '1 人 5,000 円以上', enabled: true, categoryIds: ['meal'], minPerPerson: 5000 }],
    });
    // 2 人 + 申請者 = 3 人 → 15,000 円以上で当たる。
    expect(codesOf(judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: 14_999, attendees: MEAL_ATTENDEES } })] }))).not.toContain('pre-approval-missing');
    expect(codesOf(judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: 15_000, attendees: MEAL_ATTENDEES } })] }))).toContain('pre-approval-missing');
  });

  it('境界: 無効な事前承認条件・別の費目を指す条件には当たらない', () => {
    const policy = policyWith({
      preApprovalRules: [
        { id: 'off', name: '無効', enabled: false, categoryIds: [], minAmount: 1 },
        { id: 'taxi-only', name: 'タクシーだけ', enabled: true, categoryIds: ['taxi'], minAmount: 1 },
      ],
    });
    expect(codesOf(judge({ policy }))).not.toContain('pre-approval-missing');
  });

  it('境界: 申請の合計上限は金額のある明細だけで数え、無効な費目・規程に無い費目は集計しても上限を見ない', () => {
    const judgment = judge({
      items: [
        ...threeTaxis(10_002),
        item({ id: 'x-missing', categoryId: 'taxi', facts: { payeeName: '丁交通', amount: undefined } }),
        item({ id: 'x-retired', categoryId: 'retired', facts: { payeeName: '戊', amount: 50 } }),
        item({ id: 'x-unknown', categoryId: 'ghost', facts: { payeeName: '己', amount: 70 } }),
        item({ id: 'x-nocat', categoryId: undefined, facts: { payeeName: '庚', amount: 9 } }),
      ],
    });
    const perClaim = judgment.claimReasons.filter((reason) => reason.code === 'per-claim-limit-exceeded');
    expect(perClaim).toHaveLength(1);
    expect(perClaim[0]!.params).toEqual({ categoryId: 'taxi', category: 'taxi', total: 30_004, limit: 30_003, over: 1 });
    expect(judgment.totals).toEqual({
      amount: 30_004 + 50 + 70 + 9,
      byCategory: [{ categoryId: 'taxi', amount: 30_004 }, { categoryId: 'retired', amount: 50 }, { categoryId: 'ghost', amount: 70 }],
    });
  });
});

describe('checkClaim: 打ち切り', () => {
  it('例外: amount-missing なら上限系・重複・金額条件の事前承認を出さず、閾値つきの要否は「必要」とみなす', () => {
    const policy = policyWith({ preApprovalRules: [{ id: 'big', name: '大口', enabled: true, categoryIds: [], minAmount: 1 }] });
    const judgment = judge({
      policy,
      items: [
        item({ id: 'a', categoryId: 'meal', facts: { amount: undefined } }),
        item({ id: 'b', categoryId: 'lodging', facts: { amount: 0 } }),
        item({ id: 'c', categoryId: 'train', facts: { amount: undefined } }),
      ],
      candidates: [candidate({ amount: undefined })],
      receiptHashes: new Map([['a', SHA_A]]),
    });
    const codes = codesOf(judgment);
    for (const code of ['per-item-limit-exceeded', 'attendees-missing', 'per-person-limit-exceeded', 'attendee-details-missing', 'unit-count-missing', 'per-unit-limit-exceeded', 'pre-approval-missing', 'duplicate-in-claim', 'duplicate-across-claims', 'duplicate-receipt-image', 'receipt-amount-mismatch'] as const) {
      expect(codes, code).not.toContain(code);
    }
    const train = judgment.items.find((check) => check.itemId === 'c')!.reasons.map((reason) => reason.code);
    expect(train).toEqual(['amount-missing', 'receipt-missing', 'registration-number-missing']);
    // 0 円も金額なしと同じ扱い（params には元の値を残す）。
    expect(reasonOf(judgment, 'amount-missing')?.params).toMatchObject({ amount: null });
    expect(judgment.items.find((check) => check.itemId === 'b')!.reasons[0]!.params).toMatchObject({ amount: 0 });
  });

  it('例外: amount-missing でも費目だけの事前承認条件は評価する', () => {
    const policy = policyWith({ preApprovalRules: [{ id: 'meal-any', name: '飲食は全件', enabled: true, categoryIds: ['meal'] }] });
    expect(codesOf(judge({ policy, items: [item({ categoryId: 'meal', facts: { amount: undefined } })] }))).toContain('pre-approval-missing');
  });

  it('例外: date-missing なら日付系と重複を出さず、登録番号の経過措置は null にする', () => {
    const judgment = judge({
      items: [item({ id: 'i1', categoryId: 'taxi', facts: { transactionDate: undefined, issueDate: '2026-09-09' } }), item({ id: 'i2', categoryId: 'taxi', facts: { transactionDate: undefined } })],
      candidates: [candidate({ transactionDate: undefined })],
    });
    const codes = codesOf(judgment);
    for (const code of ['date-in-future', 'date-outside-period', 'submission-late', 'duplicate-in-claim', 'duplicate-across-claims', 'duplicate-receipt-image'] as const) expect(codes).not.toContain(code);
    expect(reasonOf(judgment, 'date-missing')?.params).toMatchObject({ issueDate: '2026-09-09', description: 'サンプル商店' });
    expect(reasonOf(judgment, 'registration-number-missing')?.params).toMatchObject({ date: null, deductionRate: null });
  });

  it('例外: attendees-missing なら 1 人あたりを出さない、unit-count-missing なら単位あたりを出さない', () => {
    const codes = codesOf(judge({ items: [item({ id: 'm', categoryId: 'meal', facts: { amount: 999_999 } }), item({ id: 'l', categoryId: 'lodging', facts: { payeeName: '宿', amount: 999_999 } })] }));
    expect(codes).toEqual(expect.arrayContaining(['attendees-missing', 'unit-count-missing']));
    expect(codes).not.toContain('per-person-limit-exceeded');
    expect(codes).not.toContain('per-unit-limit-exceeded');
  });

  it('例外: claim-empty なら明細の理由も集計も無い（policy-unreviewed だけは並ぶ）', () => {
    const judgment = judge({ items: [], policySaved: false });
    expect(judgment).toEqual({
      verdict: 'returned',
      items: [],
      claimReasons: [{ code: 'policy-unreviewed', severity: 'review', params: {} }, { code: 'claim-empty', severity: 'return', params: {} }],
      totals: { amount: 0, byCategory: [] },
      searchKeysComplete: false,
    });
  });

  it('例外: 費目が未解決なら費目依存（目的・証憑・インボイス・上限）を出さないが、費目指定なしの事前承認条件は評価する', () => {
    const policy = policyWith({
      preApprovalRules: [
        { id: 'any', name: '全費目 1,000 円以上', enabled: true, categoryIds: [], minAmount: 1000 },
        { id: 'taxi', name: 'タクシー', enabled: true, categoryIds: ['taxi'], minAmount: 1 },
      ],
    });
    for (const unresolved of [item({ categoryId: undefined, facts: { amount: 999_999 } }), item({ categoryId: 'retired', facts: { amount: 999_999 } })]) {
      const judgment = judge({ policy, items: [unresolved] });
      const codes = codesOf(judgment);
      for (const code of ['purpose-missing', 'receipt-missing', 'registration-number-missing', 'per-item-limit-exceeded', 'attendees-missing', 'unit-count-missing'] as const) expect(codes).not.toContain(code);
      expect(reasonOf(judgment, 'pre-approval-missing')?.params).toMatchObject({ ruleId: 'any' });
    }
  });

  it('例外: date-in-future なら期間外・提出遅延を出さない（年の打ち間違いを二重に言わない）', () => {
    const codes = codesOf(judge({ items: [item({ facts: { transactionDate: '2027-09-10' }, addedOn: '2030-01-01' })] }));
    expect(codes).toContain('date-in-future');
    expect(codes).not.toContain('date-outside-period');
    expect(codes).not.toContain('submission-late');
  });
});

describe('checkClaim: 重さ', () => {
  it('正常: severityOverrides が反映される（上げる・下げる・off で出さない）', () => {
    const policy = policyWith({ severityOverrides: { 'payee-missing': 'return', 'receipt-missing': 'review', 'purpose-missing': 'off', 'policy-unreviewed': 'off', 'per-claim-limit-exceeded': 'review' } });
    const judgment = judge({ policy, policySaved: false, items: [item({ categoryId: 'taxi', facts: { payeeName: undefined } })] });
    expect(reasonOf(judgment, 'payee-missing')?.severity).toBe('return');
    expect(reasonOf(judgment, 'receipt-missing')?.severity).toBe('review');
    expect(codesOf(judgment)).not.toContain('purpose-missing');
    expect(codesOf(judgment)).not.toContain('policy-unreviewed');
    expect(reasonOf(judge({ policy, items: threeTaxis(10_002) }), 'per-claim-limit-exceeded')?.severity).toBe('review');
  });

  it('正常: 申請の理由を review に下げても、明細の差し戻し理由（1 件上限・領収書なし）が残れば判定は差し戻し', () => {
    const policy = policyWith({ severityOverrides: { 'per-claim-limit-exceeded': 'review' } });
    const judgment = judge({ policy, items: threeTaxis(10_002) });
    expect(judgment.claimReasons.map((reason) => [reason.code, reason.severity])).toEqual([['per-claim-limit-exceeded', 'review']]);
    // 申請の理由の重さは判定を軽くしない（最も重い理由で決まる）。
    expect(judgment.verdict).toBe('returned');
  });

  it('例外: 変更不可のコードへの上書き（createExpensePolicy を通らない値）は無視して既定の重さ', () => {
    // 保存時に拒否されるが、判定側でも「amount-missing を要確認に下げる」ことはできないことを固定する。
    const tampered: ExpensePolicy = { ...POLICY, severityOverrides: { 'amount-missing': 'review', 'claim-empty': 'off', 'payee-missing': 'off' } as ExpensePolicy['severityOverrides'] };
    expect(reasonOf(judge({ policy: tampered, items: [item({ facts: { amount: undefined, payeeName: undefined } })] }), 'amount-missing')?.severity).toBe('return');
    // payee-missing の adjustable に off は無い → 既定の review のまま出る。
    expect(reasonOf(judge({ policy: tampered, items: [item({ facts: { payeeName: undefined } })] }), 'payee-missing')?.severity).toBe('review');
    expect(judge({ policy: tampered, items: [] }).claimReasons.map((reason) => reason.code)).toEqual(['claim-empty']);
  });

  it('正常: 弱い鍵（支払先なし）の申請内重複は、重さを return にしていても常に review（weak を差し込む）', () => {
    const policy = policyWith({ severityOverrides: { 'duplicate-in-claim': 'return' } });
    const judgment = judge({ policy, items: [item({ id: 'i1', facts: { payeeName: undefined, description: '一件目' } }), item({ id: 'i2', facts: { payeeName: undefined } })] });
    const reason = judgment.items[0]!.reasons.find((entry) => entry.code === 'duplicate-in-claim');
    expect(reason?.severity).toBe('review');
    expect(reason?.params).toMatchObject({ otherItemId: 'i2', otherDescription: '明細 2', weak: true, description: '一件目' });
    const strong = judge({ policy, items: [item({ id: 'i1' }), item({ id: 'i2' })] });
    expect(strong.items[1]!.reasons.find((entry) => entry.code === 'duplicate-in-claim')).toMatchObject({ severity: 'return', params: { otherItemId: 'i1', weak: false } });
  });

  it('正常: 弱い鍵の申請間重複は常に review、相手が draft なら review、それ以外は規程の重さ', () => {
    const weak = reasonOf(judge({ items: [item({ facts: { payeeName: undefined } })], candidates: [candidate({ payeeKey: undefined, categoryId: 'plain' })] }), 'duplicate-across-claims');
    expect(weak).toMatchObject({ severity: 'review', params: { weak: true } });
    expect(reasonOf(judge({ candidates: [candidate({ claimStatus: 'draft' })] }), 'duplicate-across-claims')?.severity).toBe('review');
    for (const status of ['checked', 'returned', 'approved', 'settled']) {
      expect(reasonOf(judge({ candidates: [candidate({ claimStatus: status })] }), 'duplicate-across-claims')?.severity, status).toBe('return');
    }
    const lowered = policyWith({ severityOverrides: { 'duplicate-across-claims': 'review' } });
    expect(reasonOf(judge({ policy: lowered, candidates: [candidate()] }), 'duplicate-across-claims')?.severity).toBe('review');
  });

  it('正常: 申請間の候補が複数あれば最も重いものを 1 件だけ出す', () => {
    const judgment = judge({ candidates: [candidate({ claimId: 'c-draft', claimStatus: 'draft' }), candidate({ claimId: 'c-ok', claimStatus: 'settled', claimantName: 'テスト次郎' }), candidate({ claimId: 'c-late', claimStatus: 'approved' })] });
    const across = allReasons(judgment).filter((reason) => reason.code === 'duplicate-across-claims');
    expect(across).toHaveLength(1);
    expect(across[0]).toMatchObject({ severity: 'return', params: { otherClaimId: 'c-ok', otherStatus: 'settled', claimantName: 'テスト次郎', weak: false } });
  });

  it('正常: 同一画像の相手が draft なら review、そうでなければ規程の重さ。自分の申請の候補は無視する', () => {
    const hashes = new Map([['i1', SHA_A]]);
    const draft = reasonOf(judge({ receiptHashes: hashes, candidates: [candidate({ claimStatus: 'draft', amount: 5, receiptSha256: SHA_A })] }), 'duplicate-receipt-image');
    expect(draft).toMatchObject({ severity: 'review', params: { otherClaimId: 'c2', otherItemId: 'x1', otherStatus: 'draft' } });
    const own = judge({ receiptHashes: hashes, candidates: [candidate({ claimId: 'c1', receiptSha256: SHA_A })] });
    expect(codesOf(own)).not.toContain('duplicate-receipt-image');
    expect(codesOf(own)).not.toContain('duplicate-across-claims');
  });

  it('正常: 同じ画像ハッシュを共有する同一申請の明細（精算書の分割）は duplicate-in-claim にしない', () => {
    const items = [item({ id: 'i1' }), item({ id: 'i2' })];
    expect(codesOf(judge({ items, receiptHashes: new Map([['i1', SHA_A], ['i2', SHA_A]]) }))).not.toContain('duplicate-in-claim');
    expect(codesOf(judge({ items, receiptHashes: new Map([['i1', SHA_A], ['i2', SHA_B]]) }))).toContain('duplicate-in-claim');
  });
});

describe('checkClaim: 差し込み値・判定・決定性', () => {
  it('正常: 文言の差し込み値（費目文字列・読取ヒント・登録番号の生値と桁数・経過措置の割合・支払方法）', () => {
    expect(reasonOf(judge({ items: [item({ categoryId: undefined, categoryText: 'カフェ代' })] }), 'category-missing')?.params).toEqual({ description: 'サンプル商店', categoryText: 'カフェ代' });
    expect(reasonOf(judge({ items: [item({ categoryId: undefined })] }), 'category-missing')?.params).toMatchObject({ categoryText: null });
    expect(reasonOf(judge({ items: [item({ categoryId: 'retired' })] }), 'category-unknown')?.params).toMatchObject({ categoryId: 'retired' });
    expect(reasonOf(judge({ items: [item({ facts: { payeeName: undefined }, extraction: { documentKind: 'expense_report' } })] }), 'payee-missing')?.params).toEqual({ description: '明細 1', documentKind: 'expense_report', readerHint: true });
    expect(reasonOf(judge({ items: [item({ facts: { payeeName: undefined }, extraction: { documentKind: 'receipt' } })] }), 'payee-missing')?.params).toMatchObject({ readerHint: false });
    expect(reasonOf(judge({ items: [item({ facts: { payeeName: undefined } })] }), 'payee-missing')?.params).toMatchObject({ documentKind: null, readerHint: false });
    expect(reasonOf(judge({ items: [item({ categoryId: 'taxi', extraction: { rejectedRegistrationNumber: 'T12345' } })] }), 'registration-number-missing')?.params)
      .toMatchObject({ category: 'taxi', date: '2026-09-10', deductionRate: 80, raw: 'T12345', digits: 5 });
    expect(reasonOf(judge({ today: '2026-10-05', items: [item({ categoryId: 'taxi', facts: { transactionDate: '2026-10-01' }, addedOn: '2026-10-01' })] }), 'registration-number-missing')?.params)
      .toMatchObject({ deductionRate: 70, raw: null, digits: null });
    expect(reasonOf(judge({ items: [item({ facts: { paymentMethod: 'direct_debit' } })] }), 'payment-not-reimbursable')?.params).toMatchObject({ paymentMethod: 'direct_debit' });
    expect(reasonOf(judge({ items: [item({ facts: { corporatePayment: true, paymentMethod: 'cash' } })] }), 'payment-not-reimbursable')?.params).toMatchObject({ paymentMethod: 'corporate' });
    expect(reasonOf(judge({ items: [item({ extraction: { warnings: ['甲', '乙'] } })] }), 'receipt-extraction-warning')?.params).toMatchObject({ warnings: '甲 / 乙', count: 2 });
    expect(reasonOf(judge({ items: [item({ categoryId: 'lodging', facts: { amount: 24_003, unitCount: 2 } })] }), 'per-unit-limit-exceeded')?.params)
      .toMatchObject({ unitLabel: '泊', perUnit: 12_001, limit: 12_001, amount: 24_003, unitCount: 2 });
    expect(reasonOf(judge({ items: [item({ categoryId: 'lodging' })] }), 'unit-count-missing')?.params).toMatchObject({ unitLabel: '泊' });
  });

  it('正常: 参加者の記入漏れは氏名と関係を別々に差し込む', () => {
    const missing = (attendees: ReceiptFacts['attendees']) => reasonOf(judge({ items: [item({ categoryId: 'meal', facts: { attendees } })] }), 'attendee-details-missing')?.params;
    expect(missing({ count: 2, relation: '取引先' })).toMatchObject({ missingNames: true, missingRelation: false });
    expect(missing({ count: 2, names: ['A'], relation: ' ' })).toMatchObject({ missingNames: false, missingRelation: true });
    expect(missing(MEAL_ATTENDEES)).toBeUndefined();
  });

  it('正常: 明細の判定は明細ごと、申請の判定は最も重い理由（review だけなら needs-review）', () => {
    const judgment = judge({ items: [item({ id: 'ok' }), item({ id: 'review', facts: { payeeName: undefined, amount: 2 } })] });
    expect(judgment.items.map((check) => [check.itemId, check.verdict])).toEqual([['ok', 'pass'], ['review', 'needs-review']]);
    expect(judgment.verdict).toBe('needs-review');
    expect(judge({ policySaved: false }).verdict).toBe('needs-review');
  });

  it('正常: searchKeysComplete は全明細で取引日・金額・支払先が揃うときだけ true', () => {
    expect(judge({ items: [item({ id: 'a' }), item({ id: 'b', facts: { amount: 2 } })] }).searchKeysComplete).toBe(true);
    expect(judge({ items: [item({ id: 'a' }), item({ id: 'b', facts: { payeeName: ' ' } })] }).searchKeysComplete).toBe(false);
    expect(judge({ items: [item({ facts: { amount: 0 } })] }).searchKeysComplete).toBe(false);
    expect(judge({ items: [item({ facts: { transactionDate: undefined } })] }).searchKeysComplete).toBe(false);
  });

  it('正常: 検索要件に当たる理由だけが searchKey を持つ', () => {
    const judgment = judge({ items: [item({ categoryId: 'taxi', facts: { transactionDate: undefined, payeeName: undefined, amount: undefined } })] });
    expect(allReasons(judgment).filter((reason) => reason.searchKey !== undefined).map((reason) => [reason.code, reason.searchKey]))
      .toEqual([['amount-missing', 'amount'], ['date-missing', 'date'], ['payee-missing', 'payee']]);
  });

  it('正常: 同じ入力からは同じ判定が出る（決定性）', () => {
    const scenario: Scenario = { policySaved: false, items: threeTaxis(10_002), candidates: [candidate({ amount: 10_001, payeeKey: payeeKeyOf('甲交通') })] };
    expect(judge(scenario)).toEqual(judge(scenario));
    expect(JSON.stringify(judge(scenario))).toBe(JSON.stringify(judge(scenario)));
  });

  it('正常: 理由は評価順（REASON_CODES の並び）に並ぶ', () => {
    const policy = policyWith({ preApprovalRules: [{ id: 'big', name: '大口', enabled: true, categoryIds: [], minAmount: 1 }] });
    const noisy = (id: string) => item({
      id,
      categoryId: 'taxi',
      facts: { transactionDate: '2026-08-01', payeeName: undefined, amount: 20_003, corporatePayment: true, totalsByRate: [{ rate: 10, taxableAmount: 1, amountIncludesTax: true }] },
      extraction: { warnings: ['注意'] },
      addedOn: '2026-09-30',
    });
    const judgment = judge({
      policy,
      policySaved: false,
      items: [noisy('i1'), noisy('i2')],
      candidates: [candidate({ payeeKey: undefined, categoryId: 'taxi', transactionDate: '2026-08-01', amount: 20_003 })],
      receiptHashes: new Map([['i1', SHA_A]]),
    });
    const order = (code: string) => (REASON_CODES as readonly string[]).indexOf(code);
    const first = judgment.items[0]!.reasons.map((reason) => reason.code);
    expect(first).toEqual([
      'payee-missing', 'purpose-missing', 'receipt-missing', 'receipt-extraction-warning', 'receipt-amount-mismatch',
      'date-outside-period', 'submission-late', 'payment-not-reimbursable', 'registration-number-missing',
      'per-item-limit-exceeded', 'pre-approval-missing', 'duplicate-in-claim', 'duplicate-across-claims',
    ]);
    for (const check of judgment.items) {
      const indexes = check.reasons.map((reason) => order(reason.code));
      expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
    }
    expect(judgment.claimReasons.map((reason) => reason.code)).toEqual(['policy-unreviewed', 'per-claim-limit-exceeded']);
  });
});

describe('checkReceipt', () => {
  const receiptInput = (overrides: Partial<Parameters<typeof checkReceipt>[0]> = {}): Parameters<typeof checkReceipt>[0] => ({
    item: item(),
    policy: POLICY,
    duplicateCandidates: [],
    today: TODAY,
    hasReceipt: true,
    ...overrides,
  });

  it('正常: 申請に依存しない理由だけを出す（期間・提出期限・申請内重複・申請合計・policy-unreviewed は評価しない）', () => {
    const check = checkReceipt(receiptInput({ item: item({ id: 'r', categoryId: 'taxi', facts: { transactionDate: '2020-01-01', amount: 99_999 }, addedOn: '2026-09-30' }) }));
    const codes = check.reasons.map((reason) => reason.code);
    for (const code of ['date-outside-period', 'submission-late', 'duplicate-in-claim', 'per-claim-limit-exceeded', 'policy-unreviewed', 'claim-empty'] as const) expect(codes).not.toContain(code);
    expect(codes).toEqual(['purpose-missing', 'registration-number-missing', 'per-item-limit-exceeded']);
    expect(check).toMatchObject({ itemId: 'r', verdict: 'returned' });
  });

  it('正常: 添付の有無は hasReceipt で決まる（明細の receiptId は見ない）', () => {
    const taxi = item({ categoryId: 'taxi', receiptId: 'r1', facts: { purpose: '訪問', registrationNumber: 'T1234567890123' } });
    expect(checkReceipt(receiptInput({ item: taxi, hasReceipt: true })).verdict).toBe('pass');
    expect(checkReceipt(receiptInput({ item: taxi, hasReceipt: false })).reasons.map((reason) => reason.code)).toEqual(['receipt-missing']);
  });

  it('正常: 未来の日付・申請間の重複・同一画像は出す。index は文言の「明細 N」に使う', () => {
    const check = checkReceipt(receiptInput({
      item: item({ facts: { payeeName: undefined, transactionDate: '2026-09-10' } }),
      index: 2,
      receiptSha256: SHA_A,
      duplicateCandidates: [candidate({ claimId: 'c9', payeeKey: undefined, categoryId: 'plain' }), candidate({ claimId: 'c8', transactionDate: '2025-01-01', receiptSha256: SHA_A })],
    }));
    expect(check.reasons.map((reason) => reason.code)).toEqual(['payee-missing', 'duplicate-across-claims', 'duplicate-receipt-image']);
    expect(check.reasons[0]!.params).toMatchObject({ description: '明細 3' });
    expect(checkReceipt(receiptInput({ item: item({ facts: { transactionDate: '2026-10-01' } }) })).reasons.map((reason) => reason.code)).toEqual(['date-in-future']);
  });

  it('境界: index を省略すると「明細 1」、画像ハッシュが無ければ同一画像を見ない', () => {
    const check = checkReceipt(receiptInput({ item: item({ facts: { payeeName: undefined } }), duplicateCandidates: [candidate({ transactionDate: '2025-01-01', receiptSha256: SHA_A })] }));
    expect(check.reasons.map((reason) => reason.code)).toEqual(['payee-missing']);
    expect(check.reasons[0]!.params['description']).toBe('明細 1');
  });
});
