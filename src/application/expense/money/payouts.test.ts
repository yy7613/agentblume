import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, bankAccountFixture, FIXTURE_EMPLOYEE_IDS, fixtureEmployees, fixturePayoutSettings, V9_AT } from '../../../adapters/storage/expense-v9.fixtures';
import { createExpenseAdvance } from '../../../domain/expense/advance';
import { ExpenseAdvanceNotFoundError, ExpenseClaimNotFoundError, ExpenseDomainError, ExpensePayoutBlockedError, ExpensePayoutNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { approveAdvance } from '../../../domain/expense/money/advance-transitions';
import { createExpensePayoutSettings } from '../../../domain/expense/payout';
import { ExpensePayoutsUseCase } from './payouts';

const approval = { by: 'shonin', at: '2026-09-15T00:00:00.000Z' };
const complete = { entries: [{ itemId: 'item-1', entryId: 'je-x' }], complete: true, draftedAt: approval.at, by: 'k', warnings: [] };
const TARO = { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro };
const FRIDAY = '2026-09-25';

async function setup(options: { readonly journalLinked?: boolean; readonly settings?: boolean } = {}): Promise<{ ctx: MoneyTestContext; payouts: ExpensePayoutsUseCase }> {
  const ctx = moneyTestContext();
  for (const employee of fixtureEmployees()) await ctx.employees.save(employee);
  if (options.settings !== false) await ctx.settings.save(scope, 'payout', fixturePayoutSettings());
  await ctx.claims.save(claimFixture('c-taro', { claimant: TARO, status: 'approved', approval, ...(options.journalLinked === false ? {} : { journalLink: complete }) }), new Map());
  let sequence = 0;
  return { ctx, payouts: new ExpensePayoutsUseCase(ctx.deps, () => { sequence += 1; return `batch${String(sequence).padStart(4, '0')}abcdefgh`; }) };
}

async function blockedOf(work: Promise<unknown>): Promise<ExpensePayoutBlockedError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ExpensePayoutBlockedError) return error;
    throw error;
  }
  throw new Error('expected ExpensePayoutBlockedError');
}

const records = (base64: string): readonly string[] => {
  const text = Buffer.from(base64, 'base64').toString('latin1');
  return Array.from({ length: text.length / 122 }, (_, index) => text.slice(index * 122, index * 122 + 120));
};

describe('ExpensePayoutsUseCase.preview', () => {
  it('正常: 対象を省略すると承認済みの申請・支払待ちの仮払を候補にし、行の口座は伏せ字（口座番号を含めない）', async () => {
    const { ctx, payouts } = await setup();
    await ctx.claims.save(claimFixture('c-advance', { claimant: TARO, status: 'approved', approval, advanceId: 'adv-x' }), new Map());
    await ctx.claims.save(claimFixture('c-checked', { claimant: TARO, status: 'checked' }), new Map());
    await ctx.advances.save(approveAdvance(advanceFixture('adv-approved', 'requested'), { subject: 's' }, V9_AT));
    const preview = await payouts.preview(scope, { transferDate: FRIDAY });
    expect(preview.candidates.claims.map((entry) => entry.id)).toEqual(['c-taro']);
    expect(preview.candidates.advancePayments.map((entry) => entry.id)).toEqual(['adv-approved']);
    expect(preview).toMatchObject({ problems: [], warnings: [], recordCount: 1, totalAmount: 33200 });
    expect(preview.lines[0]).toMatchObject({ employeeId: FIXTURE_EMPLOYEE_IDS.taro, holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank: { accountNumberLast4: '0001' } });
    expect(JSON.stringify(preview)).not.toMatch(/"accountNumber"/u);
  });

  it('異常: 指定の申請・仮払が無ければ 404', async () => {
    const { payouts } = await setup();
    await expect(payouts.preview(scope, { transferDate: FRIDAY, claimIds: ['c-missing'] })).rejects.toThrow(ExpenseClaimNotFoundError);
    await expect(payouts.preview(scope, { transferDate: FRIDAY, advanceIds: ['adv-missing'] })).rejects.toThrow(ExpenseAdvanceNotFoundError);
  });
});

describe('ExpensePayoutsUseCase.create', () => {
  it('正常: 口座番号を開封して全銀協ファイルを作り、バッチの保存と申請の振込の印を同じトランザクションで行う', async () => {
    const { ctx, payouts } = await setup();
    const { batch, file } = await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin');
    expect(batch).toMatchObject({ id: 'batch0001abcdefgh', status: 'exported', transferDate: FRIDAY, recordCount: 1, totalAmount: 3200, fileName: 'zengin-sofuri-20260925-batch000.txt' });
    expect(batch.lines[0]?.bank).toMatchObject({ accountNumberLast4: '0001' });
    expect(JSON.stringify(batch)).not.toMatch(/"accountNumber"/u);
    expect(file).toMatchObject({ fileName: batch.fileName, byteLength: 4 * 122, sha256: batch.fileSha256 });
    const [header, data, trailer] = records(file.contentBase64);
    expect(header?.slice(96, 103)).toBe('0000009');
    expect(data?.slice(43, 50)).toBe('0000001');
    expect(data?.slice(80, 90)).toBe('0000003200');
    expect(trailer?.slice(0, 19)).toBe('8000001000000003200');
    expect((await ctx.claims.findById(scope, 'c-taro'))?.payout).toEqual({ batchId: batch.id, exportedAt: '2026-09-20T03:00:00.000Z' });
    expect(ctx.unitOfWork.transactions).toBe(1);
    // 二重に入れない。
    expect((await blockedOf(payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin'))).problems.map((problem) => problem.code)).toEqual(['payout-already-exported']);
  });

  it('異常: 止める理由があれば全件を返してファイルを作らず、何も保存しない', async () => {
    const { ctx, payouts } = await setup({ settings: false });
    const error = await blockedOf(payouts.create(scope, { transferDate: '2026-09-01', claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin'));
    expect(error.problems.map((problem) => problem.code)).toEqual(['payout-source-missing', 'payout-transfer-date-invalid']);
    expect(await ctx.deps.repositories.payouts.list(scope)).toEqual([]);
    expect((await ctx.claims.findById(scope, 'c-taro'))?.payout).toBeUndefined();
  });

  it('異常→正常: 確認必須の警告は全コードを確認済みにして送るまで作らない', async () => {
    const { payouts } = await setup({ journalLinked: false });
    const error = await blockedOf(payouts.create(scope, { transferDate: '2026-09-26', claimIds: ['c-taro'], acknowledgedWarnings: ['payout-no-journal'] }, 'shonin'));
    expect(error.problems).toEqual([]);
    expect(error.warnings.map((warning) => warning.code)).toEqual(['payout-transfer-date-weekend', 'payout-no-journal']);
    const created = await payouts.create(scope, { transferDate: '2026-09-26', claimIds: ['c-taro'], acknowledgedWarnings: ['payout-no-journal', 'payout-transfer-date-weekend'] }, 'shonin');
    expect(created.batch.acknowledgedWarnings).toEqual(['payout-no-journal', 'payout-transfer-date-weekend']);
  });

  it('異常: 対象が 1 件も無ければ作らない', async () => {
    const { payouts } = await setup();
    expect((await blockedOf(payouts.create(scope, { transferDate: FRIDAY, claimIds: [], acknowledgedWarnings: [] }, 'shonin'))).problems[0]?.code).toBe('payout-claim-not-approved');
  });

  it('例外: 鍵で口座番号を開封できなければ、直す欄つきの入力エラーにする（従業員の口座 / 振込元）', async () => {
    const { ctx, payouts } = await setup();
    const foreign = { v: 1 as const, alg: 'aes-256-gcm' as const, iv: 'b3RoZXI=', tag: 'b3RoZXI=', data: 'eA==', hint: '0001' };
    const [taro] = fixtureEmployees();
    await ctx.employees.save({ ...taro!, bankAccount: bankAccountFixture('0000001', 'テスト タロウ', { accountNumber: foreign }) });
    await expect(payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin')).rejects.toMatchObject({ details: { field: 'bankAccount.accountNumber' } });
    await ctx.employees.save(taro!);
    await ctx.settings.save(scope, 'payout', createExpensePayoutSettings({ ...fixturePayoutSettings(), source: { ...fixturePayoutSettings().source!, accountNumber: foreign } }));
    const error = await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpenseDomainError);
    expect((error as ExpenseDomainError).details?.field).toBe('source.accountNumber');
    expect((error as ExpenseDomainError).message).not.toMatch(/\d{7}/u);
  });
});

describe('ExpensePayoutsUseCase: 再ダウンロード・確定・取消', () => {
  async function withAdvances() {
    const { ctx, payouts } = await setup();
    await ctx.advances.save(approveAdvance(advanceFixture('adv-approved', 'requested'), { subject: 's' }, V9_AT));
    const paid = advanceFixture('adv-extra', 'paid');
    await ctx.advances.save(createExpenseAdvance({ ...paid, status: 'settling', settlement: { computedAt: V9_AT, claimIds: [], claimsTotal: 32000, difference: 2000, additionalPayment: { amount: 2000, status: 'pending' } } }));
    const { batch, file } = await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], advanceIds: ['adv-approved', 'adv-extra'], acknowledgedWarnings: [] }, 'shonin');
    return { ctx, payouts, batch, file };
  }

  it('正常: 再ダウンロードは写しの口座番号を開封して同じバイト列（同じ SHA-256）を作る。無い・取消済みは断る', async () => {
    const { payouts, batch, file } = await withAdvances();
    expect(await payouts.file(scope, batch.id)).toEqual(file);
    expect((await payouts.list(scope)).map((entry) => entry.id)).toEqual([batch.id]);
    await expect(payouts.file(scope, 'batch-missing')).rejects.toThrow(ExpensePayoutNotFoundError);
    await payouts.cancel(scope, batch.id, '日付を誤った', 'keiri');
    await expect(payouts.file(scope, batch.id)).rejects.toThrow(ExpenseTransitionError);
  });

  it('正常: 作成で追加支給に印を付け、確定で申請を精算済み・仮払の支払と追加支給を支払済み（payoutBatchId 付き）にする', async () => {
    const { ctx, payouts, batch } = await withAdvances();
    expect((await ctx.advances.findById(scope, 'adv-extra'))?.settlement?.additionalPayment).toMatchObject({ status: 'exported', payoutBatchId: batch.id });
    const result = await payouts.confirm(scope, batch.id, 'keiri');
    expect(result.batch).toMatchObject({ status: 'confirmed', confirmedBy: 'keiri' });
    expect(result.claims.map((claim) => [claim.id, claim.status, claim.settlement?.exportFileName])).toEqual([['c-taro', 'settled', batch.fileName]]);
    expect((await ctx.advances.findById(scope, 'adv-approved'))).toMatchObject({ status: 'paid', payment: { paidOn: FRIDAY, method: 'transfer', payoutBatchId: batch.id } });
    expect((await ctx.advances.findById(scope, 'adv-extra'))).toMatchObject({ status: 'settled', settlement: { additionalPayment: { status: 'paid', payoutBatchId: batch.id } } });
    expect(result.warnings).toEqual([]);
    expect(ctx.journal.drafts).toEqual([]);
    await expect(payouts.confirm(scope, batch.id, 'keiri')).rejects.toThrow(ExpenseTransitionError);
    await expect(payouts.cancel(scope, batch.id, '取消', 'keiri')).rejects.toMatchObject({ nextStep: expect.stringContaining('組戻し') });
  });

  it('正常: 取消で申請の印と追加支給の印を外し、同じ対象で作り直せる。理由が無ければ断る', async () => {
    const { ctx, payouts, batch } = await withAdvances();
    await expect(payouts.cancel(scope, batch.id, '  ', 'keiri')).rejects.toThrow(ExpenseTransitionError);
    const cancelled = await payouts.cancel(scope, batch.id, '振込日を変える', 'keiri');
    expect(cancelled).toMatchObject({ status: 'cancelled', cancel: { note: '振込日を変える' } });
    expect((await ctx.claims.findById(scope, 'c-taro'))?.payout).toBeUndefined();
    expect((await ctx.advances.findById(scope, 'adv-extra'))?.settlement?.additionalPayment).toEqual({ amount: 2000, status: 'pending' });
    await expect(payouts.cancel(scope, batch.id, '再度', 'keiri')).rejects.toThrow(ExpenseTransitionError);
    await expect(payouts.confirm(scope, batch.id, 'keiri')).rejects.toThrow(ExpenseTransitionError);
    expect((await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin')).batch.status).toBe('exported');
  });

  it('正常: 振込元の設定で支払仕訳が on なら確定時に下書きを作り、仕訳側の拒否は警告にして確定は止めない', async () => {
    const { ctx, payouts } = await setup();
    await ctx.settings.save(scope, 'payout', createExpensePayoutSettings({ ...fixturePayoutSettings(), journal: { createPaymentEntry: true, sourceAccountId: 'asset.ordinary_deposit' } }));
    const first = await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro'], acknowledgedWarnings: [] }, 'shonin');
    const confirmed = await payouts.confirm(scope, first.batch.id, 'keiri');
    expect(confirmed.batch.journalEntryId).toBe('je-1');
    expect(ctx.journal.drafts[0]?.draft).toMatchObject({ source: { kind: 'payout', id: first.batch.id }, tags: ['expense', `expense-payout:${first.batch.id}`] });

    await ctx.claims.save(claimFixture('c-taro-2', { claimant: TARO, status: 'approved', approval, journalLink: complete }), new Map());
    const second = await payouts.create(scope, { transferDate: FRIDAY, claimIds: ['c-taro-2'], acknowledgedWarnings: [] }, 'shonin');
    ctx.journal.reject = '科目が無効です';
    const rejected = await payouts.confirm(scope, second.batch.id, 'keiri');
    expect(rejected.batch.status).toBe('confirmed');
    expect(rejected.batch.journalEntryId).toBeUndefined();
    expect(rejected.warnings).toEqual([expect.stringContaining('科目が無効です')]);
  });
});
