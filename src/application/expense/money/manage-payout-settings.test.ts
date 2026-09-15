import { describe, expect, it } from 'vitest';
import { moneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { scope } from '../../../adapters/storage/expense-repository.fixtures';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { openAccountNumber } from '../bank-account-secrets';
import { ManagePayoutSettingsUseCase, maskPayoutSettings } from './manage-payout-settings';
import { GetExpenseMoneyReadinessUseCase } from './money-readiness';

const source = { bankCode: '9999', branchCode: '998', accountType: 'ordinary' as const, accountNumber: '12345' };

describe('ManagePayoutSettingsUseCase', () => {
  it('正常: 未保存なら振込元なし・既定の書式を saved=false で返す（保存しない）', async () => {
    const ctx = moneyTestContext();
    const { settings, saved } = await new ManagePayoutSettingsUseCase(ctx.deps).get(scope);
    expect(saved).toBe(false);
    expect(settings.source).toBeUndefined();
    expect(settings.format).toMatchObject({ lineEnding: 'crlf', charset: 'strict', maxRecords: 9999 });
    expect(await ctx.settings.get(scope, 'payout')).toBeNull();
  });

  it('正常: 口座番号は 7 桁にして封緘して保存し、応答は末尾 4 桁だけ。省略すると既存の口座番号を保ち、null で振込元を外す', async () => {
    const ctx = moneyTestContext();
    const usecase = new ManagePayoutSettingsUseCase(ctx.deps);
    const saved = await usecase.save(scope, { source, requesterCode: '0000000001', requesterNameKana: 'サンプルシヨウジ', format: { includeBankNames: false, maxRecords: 500 }, journal: { createPaymentEntry: true } });
    expect(saved.source).toEqual({ bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumberLast4: '2345' });
    expect(JSON.stringify(saved)).not.toMatch(/"accountNumber"|0012345/u);
    const stored = await ctx.settings.get(scope, 'payout');
    expect(await openAccountNumber(ctx.deps.cipher, stored!.source!.accountNumber)).toBe('0012345');
    expect(stored).toMatchObject({ format: { maxRecords: 500, lineEnding: 'crlf' }, journal: { createPaymentEntry: true, sourceAccountId: 'asset.ordinary_deposit' }, updatedAt: '2026-09-20T03:00:00.000Z' });

    const kept = await usecase.save(scope, { source: { ...source, accountNumber: undefined, branchCode: '997' } });
    expect(kept.source).toMatchObject({ branchCode: '997', accountNumberLast4: '2345' });
    expect(kept).toMatchObject({ requesterCode: '0000000001', format: { maxRecords: 500 } });
    expect((await usecase.get(scope)).saved).toBe(true);
    expect((await usecase.save(scope, { source: null })).source).toBeUndefined();
  });

  it('異常: 口座番号の無い新しい振込元・依頼人コードの桁違い・名義に使えない文字は保存しない', async () => {
    const usecase = new ManagePayoutSettingsUseCase(moneyTestContext().deps);
    await expect(usecase.save(scope, { source: { ...source, accountNumber: undefined } })).rejects.toThrow(ExpenseDomainError);
    await expect(usecase.save(scope, { requesterCode: '123' })).rejects.toMatchObject({ details: { field: 'requesterCode' } });
    await expect(usecase.save(scope, { requesterNameKana: 'サンプル・商事' })).rejects.toMatchObject({ details: { field: 'requesterNameKana' } });
  });

  it('正常: 準備状況の payout は口座・依頼人コード・依頼人名がそろったときだけ true', async () => {
    const ctx = moneyTestContext();
    const usecase = new ManagePayoutSettingsUseCase(ctx.deps);
    const readiness = new GetExpenseMoneyReadinessUseCase(ctx.deps);
    await usecase.save(scope, { source, requesterCode: '0000000001' });
    expect((await readiness.execute(scope)).payout).toBe(false);
    await usecase.save(scope, { requesterNameKana: 'サンプルシヨウジ' });
    expect((await readiness.execute(scope)).payout).toBe(true);
    expect(maskPayoutSettings((await ctx.settings.get(scope, 'payout'))!).source?.accountNumberLast4).toBe('2345');
  });
});
