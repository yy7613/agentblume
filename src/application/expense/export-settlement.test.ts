import { beforeEach, describe, expect, it } from 'vitest';
import { AT, claimFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import type { CreateExpenseClaimProps } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseTransitionError } from '../../domain/expense/errors';
import { NoopUnitOfWork } from '../persistence/unit-of-work';
import { ExportExpenseSettlementUseCase, SettleExpenseClaimsUseCase } from './export-settlement';

const NOW = new Date('2026-09-30T23:30:00.000Z');
const approval = { by: 'boss', at: AT };

let claims: InMemoryExpenseClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;

beforeEach(async () => {
  claims = new InMemoryExpenseClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
});

async function seed(id: string, createdAt: string, overrides: Partial<CreateExpenseClaimProps>): Promise<void> {
  await claims.save(claimFixture(id, { createdAt, updatedAt: createdAt, ...overrides }), new Map());
}

describe('ExportExpenseSettlementUseCase', () => {
  beforeEach(async () => {
    await seed('old', '2026-09-01T00:00:00.000Z', { status: 'approved', approval });
    await seed('new', '2026-09-02T00:00:00.000Z', { status: 'approved', approval, period: { from: '2026-10-01', to: '2026-10-31' } });
    await seed('done', '2026-09-03T00:00:00.000Z', { status: 'settled', approval, settlement: { settledAt: AT, by: 'acct' } });
    await seed('draft', '2026-09-04T00:00:00.000Z', {});
  });

  it('正常: 既定は承認済みを古い申請から並べ、出力しても状態を変えない', async () => {
    const before = await claims.findByIds(scope, ['old', 'new', 'done', 'draft']);
    const result = await new ExportExpenseSettlementUseCase(claims, policies, () => NOW).execute({ scope, format: 'payout' });
    expect(result.claimCount).toBe(2);
    expect(result.content.split('\r\n').slice(1, 3).map((line) => line.split(',')[0])).toEqual(['old', 'new']);
    // 出力日は業務タイムゾーン（UTC 23:30 = JST 翌日）
    expect(result.fileName).toBe('expense-payout-2026-10-01.csv');
    expect(await claims.findByIds(scope, ['old', 'new', 'done', 'draft'])).toEqual(before);
  });

  it('正常: status settled と期間の重なりで絞り込む', async () => {
    const useCase = new ExportExpenseSettlementUseCase(claims, policies, () => NOW);
    expect((await useCase.execute({ scope, format: 'detail', status: 'settled' })).claimCount).toBe(1);
    const october = await useCase.execute({ scope, format: 'payout', from: '2026-10-01', to: '2026-10-31' });
    expect(october.content).toContain('\r\nnew,');
    expect(october.claimCount).toBe(1);
  });
});

describe('SettleExpenseClaimsUseCase', () => {
  const settle = () => new SettleExpenseClaimsUseCase(claims, receipts, new NoopUnitOfWork(), () => NOW);

  it('正常: 承認済みを精算済みにしてファイル名を残し、同じ id の重複は 1 回にする', async () => {
    await seed('a', AT, { status: 'approved', approval });
    const settled = await settle().execute({ scope, claimIds: ['a', 'a'], exportFileName: 'payout.csv', by: 'acct' });
    expect(settled).toHaveLength(1);
    expect((await claims.findById(scope, 'a'))!.settlement).toEqual({ settledAt: NOW.toISOString(), by: 'acct', exportFileName: 'payout.csv' });
  });

  it('境界: 精算済みは冪等（最初の精算日時を残す）', async () => {
    await seed('s', AT, { status: 'settled', approval, settlement: { settledAt: AT, by: 'first' } });
    await settle().execute({ scope, claimIds: ['s'], by: 'acct' });
    expect((await claims.findById(scope, 's'))!.settlement).toEqual({ settledAt: AT, by: 'first' });
  });

  it('異常: 承認済み以外が混ざると全体を 409 で断り、その申請と状態を並べる', async () => {
    await seed('a', AT, { status: 'approved', approval });
    await seed('d', AT, {});
    await seed('c', AT, { status: 'checked' });
    const promise = settle().execute({ scope, claimIds: ['a', 'd', 'c'], by: 'acct' });
    await expect(promise).rejects.toBeInstanceOf(ExpenseTransitionError);
    await expect(promise).rejects.toMatchObject({ claims: [{ id: 'd', status: 'draft' }, { id: 'c', status: 'checked' }] });
    expect((await claims.findById(scope, 'a'))!.status).toBe('approved');
  });

  it('異常: 存在しない id は 404', async () => {
    await seed('a', AT, { status: 'approved', approval });
    await expect(settle().execute({ scope, claimIds: ['a', 'none'], by: 'acct' })).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });
});

describe('既定の時刻', () => {
  it('正常: now を省略すると現在時刻で出力日と精算日時を決める', async () => {
    const before = Date.now();
    await seed('a', AT, { status: 'approved', approval });
    const result = await new ExportExpenseSettlementUseCase(claims, policies).execute({ scope, format: 'payout' });
    expect(result.fileName).toMatch(/^expense-payout-\d{4}-\d{2}-\d{2}\.csv$/u);
    const [settled] = await new SettleExpenseClaimsUseCase(claims, receipts, new NoopUnitOfWork()).execute({ scope, claimIds: ['a'], by: 'acct' });
    expect(Date.parse(settled!.settlement!.settledAt)).toBeGreaterThanOrEqual(before);
  });
});
