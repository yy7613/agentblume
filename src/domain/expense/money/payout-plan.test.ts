import { describe, expect, it } from 'vitest';
import type { BankAccount } from '../bank-account';
import type { ExpenseEmployee } from '../employee';
import { createExpensePayoutSettings, type ExpensePayoutBatch, type ExpensePayoutSettings } from '../payout';
import { planPayout, unacknowledgedWarnings, type PayoutAdvanceRef, type PayoutClaimRef, type PayoutPlanInput } from './payout-plan';

const NOW = new Date('2026-09-20T03:00:00.000Z');
const sealed = (digits: string) => ({ v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'aXY=', tag: 'dGFn', data: Buffer.from(digits).toString('base64'), hint: digits.slice(-4) });

function bank(holderKana: string, overrides: Partial<BankAccount> = {}): BankAccount {
  return { bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0000001'), holderKana, changedAt: '2026-01-01T00:00:00.000Z', changedBy: 'keiri', ...overrides };
}

/** planPayout が見る項目だけの従業員（点検の境界を作るため create* を通さない）。 */
function employee(id: string, name: string, overrides: Partial<ExpenseEmployee> = {}): ExpenseEmployee {
  return { id, name, bankAccount: bank('テスト タロウ'), history: [], loginSubjects: [], commuterPasses: [], enabled: true, ...overrides } as unknown as ExpenseEmployee;
}

function settings(overrides: Partial<Parameters<typeof createExpensePayoutSettings>[0]> = {}): ExpensePayoutSettings {
  return createExpensePayoutSettings({
    source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: sealed('0000009') }, requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ',
    updatedAt: '2026-09-15T00:00:00.000Z', ...overrides,
  });
}

const claim = (id: string, overrides: Partial<PayoutClaimRef> = {}): PayoutClaimRef => ({ id, status: 'approved', employeeId: 'emp-taro', claimantName: 'テスト太郎', amount: 1000, journalLinked: 'complete', ...overrides });
const advance = (id: string, overrides: Partial<PayoutAdvanceRef> = {}): PayoutAdvanceRef => ({ id, employeeId: 'emp-hanako', employeeName: 'テスト花子', status: 'approved', amount: 30000, paid: false, ...overrides });

function input(overrides: Partial<PayoutPlanInput> = {}): PayoutPlanInput {
  return {
    settings: settings(), transferDate: '2026-09-25', today: '2026-09-20', now: NOW, claims: [], advancePayments: [], advanceAdditionals: [],
    employees: [employee('emp-taro', 'テスト太郎'), employee('emp-hanako', 'テスト花子', { bankAccount: bank('テスト ハナコ') })], activeBatches: [], ...overrides,
  };
}

const codes = (problems: readonly { code: string }[]) => problems.map((problem) => problem.code);

describe('planPayout: 行の組み立て', () => {
  it('正常: 同じ従業員の申請は 1 行に合算し、仮払の支払・追加支給は出所の種類を分けて持つ', () => {
    const plan = planPayout(input({
      claims: [claim('c1', { amount: 3000 }), claim('c2', { amount: 2180 })],
      advancePayments: [advance('adv-pay')],
      advanceAdditionals: [advance('adv-extra', { employeeId: 'emp-taro', status: 'settling', paid: true, additionalPayment: { amount: 2000, status: 'pending' } })],
    }));
    expect(plan.problems).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.lines.map((line) => [line.employeeId, line.amount, line.holderKanaConverted, line.sources.map((source) => `${source.kind}:${source.id}:${source.amount}`)])).toEqual([
      ['emp-hanako', 30000, 'ﾃｽﾄ ﾊﾅｺ', ['advance-payment:adv-pay:30000']],
      ['emp-taro', 7180, 'ﾃｽﾄ ﾀﾛｳ', ['claim:c1:3000', 'claim:c2:2180', 'advance-additional:adv-extra:2000']],
    ]);
    expect(plan).toMatchObject({ recordCount: 2, totalAmount: 37180 });
  });

  it('正常: 返金（差額が負）は相殺しない。返金待ちの仮払は振込の対象にならず、同じ人の申請の額はそのまま', () => {
    const refund = advance('adv-refund', { employeeId: 'emp-taro', status: 'settling', paid: true });
    const plan = planPayout(input({ claims: [claim('c1', { amount: 5000 })], advanceAdditionals: [refund] }));
    expect(plan.lines.map((line) => [line.employeeId, line.amount])).toEqual([['emp-taro', 5000]]);
    expect(plan.problems).toEqual([expect.objectContaining({ code: 'payout-claim-not-approved', advanceId: 'adv-refund' })]);
  });

  it('境界: 金額 0 の申請は行を作らない', () => {
    expect(planPayout(input({ claims: [claim('c1', { amount: 0 })] })).lines).toEqual([]);
  });
});

describe('planPayout: 止める理由（§20.5.2）', () => {
  it('異常: 振込元の口座・依頼人コード・依頼人名のどれかが無ければ payout-source-missing（直す欄つき）', () => {
    const noSource = createExpensePayoutSettings({ requesterCode: '0000000001', requesterNameKana: 'ｻﾝﾌﾟﾙ', updatedAt: '2026-09-15T00:00:00.000Z' });
    expect(planPayout(input({ settings: noSource, claims: [claim('c1')] })).problems).toEqual([expect.objectContaining({ code: 'payout-source-missing', field: 'source', fixTarget: 'payout-settings' })]);
    expect(planPayout(input({ settings: settings({ requesterCode: undefined }) })).problems[0]?.field).toBe('requesterCode');
    expect(planPayout(input({ settings: settings({ requesterNameKana: undefined }) })).problems[0]?.field).toBe('requesterNameKana');
  });

  it('異常: 未承認・仮払で精算する申請・申請者が未紐付け（マスタに居ない）は、申請ごとに理由を出して行に入れない', () => {
    const plan = planPayout(input({ claims: [claim('c-checked', { status: 'checked' }), claim('c-advance', { advanceId: 'adv-1' }), claim('c-unlinked', { employeeId: undefined }), claim('c-gone', { employeeId: 'emp-gone' })] }));
    expect(plan.problems.map((problem) => [problem.code, problem.claimId])).toEqual([
      ['payout-employee-unlinked', 'c-unlinked'], ['payout-employee-unlinked', 'c-gone'], ['payout-claim-not-approved', 'c-checked'], ['payout-claim-not-approved', 'c-advance'],
    ]);
    expect(plan.lines).toEqual([]);
    expect(plan.problems.find((problem) => problem.claimId === 'c-unlinked')?.fixTarget).toBe('claim-claimant');
  });

  it('異常: 既に取消されていない振込データに入っている申請・仮払は payout-already-exported（取消済みのバッチは数えない）', () => {
    const batch = (id: string, status: ExpensePayoutBatch['status'], kind: 'claim' | 'advance-payment' | 'advance-additional', sourceId: string) => ({ id, status, createdAt: '2026-09-18T00:00:00.000Z', lines: [{ sources: [{ kind, id: sourceId, amount: 1 }] }] }) as unknown as ExpensePayoutBatch;
    const plan = planPayout(input({
      claims: [claim('c1'), claim('c2', { payoutBatchId: 'batch-old' }), claim('c3')],
      advancePayments: [advance('adv-pay')],
      advanceAdditionals: [advance('adv-extra', { status: 'settling', additionalPayment: { amount: 1, status: 'pending' } })],
      activeBatches: [batch('batch-1', 'exported', 'claim', 'c1'), batch('batch-2', 'confirmed', 'advance-payment', 'adv-pay'), batch('batch-3', 'exported', 'advance-additional', 'adv-extra'), batch('batch-x', 'cancelled', 'claim', 'c3')],
    }));
    expect(plan.problems.map((problem) => [problem.code, problem.params?.['batchId'], problem.claimId ?? problem.advanceId])).toEqual([
      ['payout-already-exported', 'batch-1', 'c1'], ['payout-already-exported', 'batch-old', 'c2'], ['payout-already-exported', 'batch-2', 'adv-pay'], ['payout-already-exported', 'batch-3', 'adv-extra'],
    ]);
    expect(plan.lines.map((line) => line.sources.map((source) => source.id))).toEqual([['c3']]);
  });

  it('異常: 支払済み・未承認の仮払の支払、支払待ちでない追加支給、マスタに居ない従業員の仮払は対象にしない', () => {
    const plan = planPayout(input({
      advancePayments: [advance('adv-paid', { paid: true, status: 'paid' }), advance('adv-requested', { status: 'requested' }), advance('adv-gone', { employeeId: 'emp-gone' })],
      advanceAdditionals: [advance('adv-exported', { status: 'settling', additionalPayment: { amount: 1, status: 'exported', payoutBatchId: 'b' } }), advance('adv-extra-gone', { employeeId: 'emp-gone', status: 'settling', additionalPayment: { amount: 1, status: 'pending' } })],
    }));
    expect(plan.problems.map((problem) => [problem.code, problem.advanceId])).toEqual([
      ['payout-employee-unlinked', 'adv-gone'], ['payout-employee-unlinked', 'adv-extra-gone'],
      ['payout-claim-not-approved', 'adv-paid'], ['payout-claim-not-approved', 'adv-requested'], ['payout-claim-not-approved', 'adv-exported'],
    ]);
  });

  it('異常: 口座の未登録・名義の禁止文字は従業員の口座欄への導線つきで止め、その人の行を作らない', () => {
    const plan = planPayout(input({
      claims: [claim('c1'), claim('c2', { employeeId: 'emp-hanako' })],
      employees: [employee('emp-taro', 'テスト太郎', { bankAccount: undefined }), employee('emp-hanako', 'テスト花子', { bankAccount: bank('テスト・ハナコ') })],
    }));
    expect(plan.problems.map((problem) => [problem.code, problem.employeeId, problem.fixTarget])).toEqual([
      ['payout-bank-account-missing', 'emp-taro', 'employee-bank-account'], ['payout-holder-kana-invalid', 'emp-hanako', 'employee-bank-account'],
    ]);
    expect(plan.lines).toEqual([]);
  });

  it('境界: 名義は変換後 30 バイトまで通し、31 バイト（濁点も 1 バイト）は切り詰めずに payout-holder-kana-too-long で止める', () => {
    const thirty = 'ｱ'.repeat(28) + 'ｶﾞ';
    const ok = planPayout(input({ claims: [claim('c1')], employees: [employee('emp-taro', 'テスト太郎', { bankAccount: bank(thirty) })] }));
    expect(ok.problems).toEqual([]);
    expect(ok.lines[0]?.holderKanaConverted).toBe(thirty);
    const over = planPayout(input({ claims: [claim('c1')], employees: [employee('emp-taro', 'テスト太郎', { bankAccount: bank('ｱ'.repeat(29) + 'ｶﾞ') })] }));
    expect(over.problems).toEqual([expect.objectContaining({ code: 'payout-holder-kana-too-long', employeeId: 'emp-taro', field: 'bankAccount.holderKana', fixTarget: 'employee-bank-account', params: expect.objectContaining({ bytes: 31 }) })]);
    expect(over.lines).toEqual([]);
  });

  it('境界: 1 人の振込額は 9,999,999,999 円まで。超えたら payout-amount-too-large で止める', () => {
    expect(planPayout(input({ claims: [claim('c1', { amount: 9_999_999_999 })] })).problems).toEqual([]);
    const over = planPayout(input({ claims: [claim('c1', { amount: 9_999_999_999 }), claim('c2', { amount: 1 })] }));
    expect(codes(over.problems)).toEqual(['payout-amount-too-large']);
    expect(over.lines).toEqual([]);
  });

  it('境界: 振込件数は設定の上限まで。超えたら payout-too-many-records', () => {
    const two = { claims: [claim('c1'), claim('c2', { employeeId: 'emp-hanako' })] };
    expect(planPayout(input({ ...two, settings: settings({ format: { maxRecords: 2 } }) })).problems).toEqual([]);
    expect(planPayout(input({ ...two, settings: settings({ format: { maxRecords: 1 } }) })).problems).toEqual([expect.objectContaining({ code: 'payout-too-many-records', params: { count: 2, max: 1 } })]);
  });

  it('境界: 振込日は今日なら通し、昨日なら payout-transfer-date-invalid（土日の警告は出さない）', () => {
    expect(planPayout(input({ claims: [claim('c1')], transferDate: '2026-09-22', today: '2026-09-22' })).problems).toEqual([]);
    const past = planPayout(input({ claims: [claim('c1')], transferDate: '2026-09-19', today: '2026-09-22' }));
    expect(codes(past.problems)).toEqual(['payout-transfer-date-invalid']);
    expect(past.warnings).toEqual([]);
  });

  it('正常: 止める理由は §20.5.2 の順に並べ、最初の 1 件で止めずに全部集める', () => {
    const plan = planPayout(input({
      settings: settings({ source: undefined }), transferDate: '2026-09-01',
      claims: [claim('c-checked', { status: 'checked' }), claim('c1')], employees: [employee('emp-taro', 'テスト太郎', { bankAccount: undefined })],
    }));
    expect(codes(plan.problems)).toEqual(['payout-source-missing', 'payout-bank-account-missing', 'payout-claim-not-approved', 'payout-transfer-date-invalid']);
  });
});

describe('planPayout: 確認必須の警告', () => {
  it('正常: 土日の振込日・名義の書式の変換・仕訳下書きの無い申請は警告（止めない）で、行は作る', () => {
    const plan = planPayout(input({
      transferDate: '2026-09-26', claims: [claim('c1', { journalLinked: 'partial' }), claim('c2', { journalLinked: 'none' })],
      employees: [employee('emp-taro', 'テスト太郎', { bankAccount: bank('テスト タロー') })],
    }));
    expect(plan.problems).toEqual([]);
    expect(codes(plan.warnings)).toEqual(['payout-transfer-date-weekend', 'payout-holder-kana-converted', 'payout-no-journal']);
    expect(plan.warnings.find((warning) => warning.code === 'payout-no-journal')?.params).toEqual({ count: 2 });
    expect(plan.lines[0]?.holderKanaConverted).toBe('ﾃｽﾄ ﾀﾛ-');
    expect(unacknowledgedWarnings(plan.warnings, ['payout-transfer-date-weekend'])).toEqual(['payout-holder-kana-converted', 'payout-no-journal']);
    expect(unacknowledgedWarnings(plan.warnings, codes(plan.warnings))).toEqual([]);
  });

  it('境界: 口座の変更はちょうど 30 日前までを警告し、30 日と 1 ミリ秒前は警告しない', () => {
    const changedAt = (at: string) => [employee('emp-taro', 'テスト太郎', { history: [{ type: 'bank-account-changed', by: 'editor@example.com', at }] as ExpenseEmployee['history'] })];
    const boundary = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
    const justOver = new Date(NOW.getTime() - 30 * 86_400_000 - 1).toISOString();
    expect(planPayout(input({ claims: [claim('c1')], employees: changedAt(boundary) })).warnings).toEqual([expect.objectContaining({ code: 'payout-bank-account-recently-changed', employeeId: 'emp-taro', fixTarget: 'employee-history', params: expect.objectContaining({ changedBy: 'editor@example.com' }) })]);
    expect(planPayout(input({ claims: [claim('c1')], employees: changedAt(justOver) })).warnings).toEqual([]);
  });
});
