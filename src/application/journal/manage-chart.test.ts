import { describe, expect, it } from 'vitest';
import { InMemoryChartOfAccountsRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { JournalDomainError } from '../../domain/journal/errors';
import { DEFAULT_CHART_UPDATED_AT } from '../../domain/journal/default-chart';
import { GetChartOfAccountsUseCase, ResetChartOfAccountsUseCase, SaveChartOfAccountsUseCase } from './manage-chart';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

const minimalChart = {
  accounts: [{ id: 'expense.supplies', name: '消耗品費', category: 'expense' as const, defaultTaxCode: 'JP-IN-10-S', aliases: [], enabled: true, sortOrder: 10 }],
  dimensions: [{ id: 'sub_account', name: '補助科目', values: [] }],
  taxCategories: [{ code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in' as const, rate: 10, enabled: true }],
};

describe('GetChartOfAccountsUseCase', () => {
  it('正常: 保存済みのマスタを返す', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    await new SaveChartOfAccountsUseCase(charts, clock).execute({ scope, ...minimalChart });
    const chart = await new GetChartOfAccountsUseCase(charts).execute(scope);
    expect(chart.accounts).toHaveLength(1);
    expect(chart.updatedAt).toBe(NOW.toISOString());
  });

  it('境界: 未保存なら標準セットを返すが、**保存はしない**（参照が書き込みを起こさない）', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    const chart = await new GetChartOfAccountsUseCase(charts).execute(scope);
    expect(chart.accounts.length).toBeGreaterThan(50);
    expect(chart.updatedAt).toBe(DEFAULT_CHART_UPDATED_AT);
    expect(await charts.get(scope)).toBeNull();
  });

  it('境界: 返した標準セットを呼び出し側が書き換えても、次の取得に影響しない', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    const usecase = new GetChartOfAccountsUseCase(charts);
    const first = await usecase.execute(scope);
    (first.accounts as unknown as { name: string }[])[0]!.name = '書き換え';
    const second = await usecase.execute(scope);
    expect(second.accounts[0]?.name).not.toBe('書き換え');
  });
});

describe('SaveChartOfAccountsUseCase', () => {
  it('正常: 全体を置き換え、updatedAt に保存時刻を入れる', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    const saved = await new SaveChartOfAccountsUseCase(charts, clock).execute({ scope, ...minimalChart });
    expect(saved.updatedAt).toBe(NOW.toISOString());
    expect((await charts.get(scope))?.accounts).toHaveLength(1);
  });

  it('例外: 科目 id が重複していれば JournalDomainError（createChartOfAccounts の検証を通す）', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    const usecase = new SaveChartOfAccountsUseCase(charts, clock);
    await expect(usecase.execute({
      ...minimalChart, scope,
      accounts: [minimalChart.accounts[0]!, { ...minimalChart.accounts[0]! }],
    })).rejects.toThrow(JournalDomainError);
    // 失敗した保存は何も残さない。
    expect(await charts.get(scope)).toBeNull();
  });

  it('例外: 実在しない税区分を既定にしている科目は弾く', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    await expect(new SaveChartOfAccountsUseCase(charts, clock).execute({
      ...minimalChart, scope,
      accounts: [{ ...minimalChart.accounts[0]!, defaultTaxCode: 'JP-NOPE' }],
    })).rejects.toThrow(/unknown tax category/);
  });
});

describe('ResetChartOfAccountsUseCase', () => {
  it('正常: 標準セットを保存して返す（以後の取得も標準セット）', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    await new SaveChartOfAccountsUseCase(charts, clock).execute({ scope, ...minimalChart });
    const reset = await new ResetChartOfAccountsUseCase(charts, clock).execute(scope);
    expect(reset.accounts.length).toBeGreaterThan(50);
    expect(reset.updatedAt).toBe(NOW.toISOString());
    expect((await charts.get(scope))?.accounts.length).toBeGreaterThan(50);
  });

  it('境界: 他のワークスペースのマスタには触らない', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    const other = { tenantId: 't', workspaceId: 'other' };
    await new SaveChartOfAccountsUseCase(charts, clock).execute({ scope: other, ...minimalChart });
    await new ResetChartOfAccountsUseCase(charts, clock).execute(scope);
    expect((await charts.get(other))?.accounts).toHaveLength(1);
  });
});