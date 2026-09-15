import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimFixture, itemFixture, policyFixture, scope } from '../../../adapters/storage/expense-repository.fixtures';
import { FIXTURE_EMPLOYEE_IDS, fixtureEmployees, fixtureFareTable } from '../../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseEmployeeRepository } from '../../../adapters/storage/in-memory-expense-people-repositories';
import { InMemoryExpenseSettingsRepository } from '../../../adapters/storage/in-memory-expense-settings-repository';
import { createExpensePolicy } from '../../../domain/expense/policy';
import { ExpenseSettingsStore } from '../settings-store';
import { InputCheckFactsProvider } from './check-facts';

describe('InputCheckFactsProvider', () => {
  let store: ExpenseSettingsStore;
  let employees: InMemoryExpenseEmployeeRepository;
  let provider: InputCheckFactsProvider;
  const policy = policyFixture();
  const transportItem = itemFixture('item-1', { transactionDate: '2026-09-10', amount: 200 }, { categoryId: 'transport.public' });

  beforeEach(async () => {
    store = new ExpenseSettingsStore(new InMemoryExpenseSettingsRepository());
    employees = new InMemoryExpenseEmployeeRepository();
    for (const employee of fixtureEmployees()) await employees.save(employee);
    provider = new InputCheckFactsProvider({ settings: store, employeeDirectory: employees });
  });

  it('正常: 区間の設定がある費目の明細が無ければ、設定も従業員も読まずに何も返さない', async () => {
    const load = vi.spyOn(store, 'load');
    expect(await provider.gather(scope, claimFixture('c1', { items: [itemFixture('item-1', {}, { categoryId: 'misc' })] }), policy, '2026-09-15')).toEqual({});
    const noRoutes = createExpensePolicy({ ...policy, categories: policy.categories.map(({ route: _route, ...category }) => category) });
    expect(await provider.gather(scope, claimFixture('c2', { items: [transportItem] }), noRoutes, '2026-09-15')).toEqual({});
    expect(load).not.toHaveBeenCalled();
  });

  it('境界: 運賃マスタが未保存・申請者が紐付いていなければ、空の運賃と空の定期', async () => {
    expect(await provider.gather(scope, claimFixture('c1', { items: [transportItem] }), policy, '2026-09-15')).toEqual({
      input: { fareTableSaved: false, fareRoutes: [], stationAliases: [], commuterPasses: [] },
    });
  });

  it('正常: 保存済みの運賃マスタと、紐付いた有効な従業員の通勤定期を集める', async () => {
    const table = fixtureFareTable();
    await store.save(scope, 'fares', table);
    const claim = claimFixture('c1', { items: [transportItem], claimant: { name: 'テスト太郎', employeeId: FIXTURE_EMPLOYEE_IDS.taro } });
    const facts = await provider.gather(scope, claim, policy, '2026-09-15');
    expect(facts.input).toEqual({ fareTableSaved: true, fareRoutes: table.routes, stationAliases: table.stationAliases, commuterPasses: fixtureEmployees()[0]!.commuterPasses });
  });

  it('境界: 無効な従業員・見つからない従業員の定期は使わない', async () => {
    for (const employeeId of [FIXTURE_EMPLOYEE_IDS.shiro, 'emp-none']) {
      const claim = claimFixture('c1', { items: [transportItem], claimant: { name: 'x', employeeId } });
      expect((await provider.gather(scope, claim, policy, '2026-09-15')).input?.commuterPasses).toEqual([]);
    }
  });
});
