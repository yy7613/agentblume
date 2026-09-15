import { describe, expect, it } from 'vitest';
import { moneyTestContext, type MoneyTestContext } from '../../../adapters/storage/expense-money-deps.fixtures';
import { claimFixture, itemFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { advanceFixture, cardImportFixture, cardTransactionFixture, FIXTURE_DEPARTMENT_IDS, FIXTURE_EMPLOYEE_IDS, fixtureCardSettings, fixtureOrganization } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { DataSourceValidationError } from '../../data-source/manage-data-sources';
import type { RowSourceResolver, RowSourceRowsInput } from '../../data-source/row-sources';
import { expenseMoneyRowSources } from './row-sources';
import { SummarizeExpensesUseCase } from './summary';

const approval = (at: string) => ({ by: 'shonin', at });
const TARO = { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro, departmentId: FIXTURE_DEPARTMENT_IDS.sales, department: '営業部' };

async function setup(): Promise<MoneyTestContext> {
  const ctx = moneyTestContext();
  await ctx.settings.save(scope, 'organization', fixtureOrganization());
  await ctx.claims.save(claimFixture('c-sep', { claimant: TARO, status: 'approved', approval: approval('2026-09-30T15:00:00.000Z'), items: [itemFixture('item-1', { amount: 3000 }), itemFixture('item-2', { amount: 2000, corporatePayment: true }, { categoryId: 'meal.entertainment' })] }), new Map());
  await ctx.claims.save(claimFixture('c-aug', { claimant: { name: 'テスト花子' }, status: 'settled', approval: approval('2026-08-20T00:00:00.000Z'), settlement: { settledAt: '2026-08-25T00:00:00.000Z', by: 'k' }, items: [itemFixture('item-1', { transactionDate: '2026-08-10', amount: 1000 })] }), new Map());
  await ctx.claims.save(claimFixture('c-draft', { items: [itemFixture('item-1', { amount: 9999 })] }), new Map());
  return ctx;
}

const input = (config: Record<string, unknown> = {}, args: Record<string, unknown> = {}): RowSourceRowsInput => ({ scope, config, attachments: [], documents: [], arguments: args });

function resolver(sources: readonly RowSourceResolver[], nodeType: string): RowSourceResolver {
  const found = sources.find((source) => source.nodeType === nodeType);
  if (found === undefined || found.rows === undefined) throw new Error(`missing ${nodeType}`);
  return found;
}

describe('SummarizeExpensesUseCase', () => {
  it('正常: 取引日の月・費目名・部門名で集計し、CSV でも同じ数字を出す', async () => {
    const ctx = await setup();
    const summary = new SummarizeExpensesUseCase(ctx.deps);
    const result = await summary.execute(scope, { from: '2026-08', to: '2026-09', groupBy: ['month', 'department', 'category'], statuses: ['approved', 'settled'], basis: 'transaction' });
    expect(result.rows.map((row) => [row.month, row.department, row.categoryId, row.amount, row.corporateAmount])).toEqual([
      ['2026-08', 'unknown', 'transport.taxi', 1000, 0],
      // 同じ月・部門の中は費目名の昇順（タクシー < 交際費（接待の飲食））。
      ['2026-09', '営業部', 'transport.taxi', 3000, 0],
      ['2026-09', '営業部', 'meal.entertainment', 2000, 2000],
    ]);
    // 費目名は現在の規程から引く（id のままではない）。
    expect(result.rows.every((row) => row.category !== null && row.category !== row.categoryId)).toBe(true);
    expect(result.totals).toMatchObject({ claimCount: 2, amount: 6000, reimbursableAmount: 4000, corporateAmount: 2000 });
    const csv = await summary.export(scope, { from: '2026-08', to: '2026-09', groupBy: ['month'], statuses: [], basis: 'transaction' });
    expect(csv.content).toContain('2026-09,,,,,,,,1,2,5000,3000,2000,transaction,2026-08,2026-09,month');
  });

  it('境界: 承認日の基準は日本時間で月を決める（9/30 15:00 UTC は 10 月）', async () => {
    const ctx = await setup();
    const result = await new SummarizeExpensesUseCase(ctx.deps).execute(scope, { from: '2026-10', to: '2026-10', groupBy: ['month'], statuses: ['approved', 'settled'], basis: 'approved' });
    expect(result.rows.map((row) => [row.month, row.claimCount])).toEqual([['2026-10', 1]]);
  });

  it('異常: 期間の不正は入力エラー。明細が上限に達したら一部で集計した警告を出す', async () => {
    const ctx = await setup();
    await expect(new SummarizeExpensesUseCase(ctx.deps).execute(scope, { from: '2026-10', to: '2026-09', groupBy: [], statuses: [], basis: 'transaction' })).rejects.toThrow(ExpenseDomainError);
    const limited = await new SummarizeExpensesUseCase(ctx.deps, 1).execute(scope, { from: '2026-01', to: '2026-12', groupBy: ['month'], statuses: [], basis: 'settled' });
    expect(limited.warnings.at(-1)).toContain('1 件を超えた');
  });
});

describe('expenseMoneyRowSources', () => {
  it('正常: 3 つのノード型を文脈に依らない行ソースとして宣言する', async () => {
    const sources = expenseMoneyRowSources((await setup()).deps);
    expect(sources.map((source) => [source.nodeType, source.requirement])).toEqual([['expense-summary', 'none'], ['expense-advances', 'none'], ['expense-card-transactions', 'none']]);
  });

  it('正常: expense-summary は引数省略で直近 12 か月・month,category・承認済みと精算済み、引数で粒度・期間・状態を変える', async () => {
    const summary = resolver(expenseMoneyRowSources((await setup()).deps), 'expense-summary');
    const defaults = await summary.rows?.(input());
    expect(defaults?.map((row) => [row['month'], row['category_id'], row['amount'], row['group_by'], row['period_from'], row['period_to']])).toEqual([
      ['2026-08', 'transport.taxi', 1000, 'month,category', '2025-10', '2026-09'],
      ['2026-09', 'transport.taxi', 3000, 'month,category', '2025-10', '2026-09'],
      ['2026-09', 'meal.entertainment', 2000, 'month,category', '2025-10', '2026-09'],
    ]);
    const byClaimant = await summary.rows?.(input({ limit: 1 }, { period: '2026-09', group_by: 'claimant', status: 'all', department: null }));
    // 状態 all で下書きの申請（従業員に未紐付け）も入り、同じ氏名でも従業員の有無で別の行。未紐付けが先に並ぶ。limit で 1 行に切る。
    expect(byClaimant).toEqual([expect.objectContaining({ claimant: 'テスト太郎', employee_id: null, month: null, amount: 9999, claim_count: 1 })]);
    const all = await summary.rows?.(input({}, { period: '2026-09', group_by: 'claimant', status: 'all' }));
    expect(all?.map((row) => [row['employee_id'], row['amount']])).toEqual([[null, 9999], [FIXTURE_EMPLOYEE_IDS.taro, 5000]]);
  });

  it('異常: 不正な引数・設定はモデルが直せる文言の検証エラーにする', async () => {
    const summary = resolver(expenseMoneyRowSources((await setup()).deps), 'expense-summary');
    await expect(summary.rows?.(input({}, { group_by: 'payee' }))).rejects.toThrow(new DataSourceValidationError('group_by must be a comma-separated list of month, department, category, claimant, status'));
    await expect(summary.rows?.(input({}, { period: 202609 }))).rejects.toThrow('period must be a string');
    await expect(summary.rows?.(input({ limit: 0 }))).rejects.toThrow('expense summary source has invalid settings');
  });

  it('例外: 入力エラー以外の失敗は言い換えずに伝える', async () => {
    const ctx = await setup();
    const broken = { ...ctx.deps, repositories: { ...ctx.deps.repositories, claims: { ...ctx.deps.repositories.claims, listItemFacts: async () => { throw new Error('db locked'); } } } };
    await expect(resolver(expenseMoneyRowSources(broken), 'expense-summary').rows?.(input())).rejects.toThrow('db locked');
  });

  it('正常: expense-advances は精算前の差額を null、精算済みは差額を返し、口座番号の列を持たない', async () => {
    const ctx = await setup();
    await ctx.advances.save(advanceFixture('adv-paid', 'paid'));
    await ctx.advances.save(advanceFixture('adv-settled', 'settled'));
    const rows = await resolver(expenseMoneyRowSources(ctx.deps), 'expense-advances').rows?.(input({ limit: 500 }));
    const paid = rows?.find((row) => row['advance_id'] === 'adv-paid');
    expect(paid).toMatchObject({ employee: 'テスト花子', department: '営業部', status: 'paid', paid_on: '2026-09-03', difference: null, refund: null, additional_payment: null, settled_on: null, linked_claim_count: 0 });
    expect(rows?.find((row) => row['advance_id'] === 'adv-settled')).toMatchObject({ difference: 0, settled_on: '2026-09-20', department: '経理部' });
    expect(Object.keys(paid ?? {}).join(',')).not.toMatch(/account|bank/u);
    await expect(resolver(expenseMoneyRowSources(ctx.deps), 'expense-advances').rows?.(input({ limit: 501 }))).rejects.toThrow(DataSourceValidationError);
  });

  it('正常: expense-card-transactions は保存済みの照合結果を行にする', async () => {
    const ctx = await setup();
    await ctx.settings.save(scope, 'cards', fixtureCardSettings());
    await ctx.cards.saveImport(cardImportFixture('import-1'), [
      cardTransactionFixture('tx-1', { status: 'matched', match: { claimId: 'c-sep', itemId: 'item-1', kind: 'reimbursement-item', strength: 'weak', dateDiffDays: -1, amountDiff: 0, manual: false, at: '2026-09-15T00:00:00.000Z' } }),
      cardTransactionFixture('tx-2', { usedOn: '2026-09-11', amount: -500, status: 'excluded', exclusion: { reason: '返金', by: 'k', at: '2026-09-15T00:00:00.000Z' } }),
    ]);
    const rows = await resolver(expenseMoneyRowSources(ctx.deps), 'expense-card-transactions').rows?.(input({ limit: 1 }));
    expect(rows).toHaveLength(1);
    const all = await resolver(expenseMoneyRowSources(ctx.deps), 'expense-card-transactions').rows?.(input());
    expect(all?.find((row) => row['transaction_id'] === 'tx-1')).toMatchObject({ card_label: '営業用カード', card_last4: '1111', match_kind: 'reimbursement-item', match_strength: 'weak', claim_id: 'c-sep', claimant: 'テスト太郎', claim_status: 'approved', date_diff_days: -1, exclusion_reason: null, import_file: 'card-statement-generic.csv' });
    expect(all?.find((row) => row['transaction_id'] === 'tx-2')).toMatchObject({ amount: -500, status: 'excluded', exclusion_reason: '返金', match_kind: null, claimant: null });
  });
});
