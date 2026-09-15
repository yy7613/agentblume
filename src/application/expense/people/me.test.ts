/** 見ている人・「実用機能の準備」の状況・組織の読み書き（docs/21 §20.9.2 / §20.10.1）。 */
import { describe, expect, it } from 'vitest';
import { PEOPLE_NOW, peopleTestDeps, seedPeople } from '../../../adapters/storage/expense-people-deps.fixtures';
import { fixtureOrganization, fixturePayoutSettings, scope } from '../../../adapters/storage/expense-v9.fixtures';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { createExpensePayoutSettings } from '../../../domain/expense/payout';
import { GetExpenseOrganizationUseCase, SaveExpenseOrganizationUseCase } from './manage-organization';
import { GetExpenseMeUseCase, GetExpensePeopleReadinessUseCase } from './me';

describe('GetExpenseMeUseCase', () => {
  it('正常: ログイン ID で結ばれた従業員の要約を添え、結ばれていなければ付けない', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const me = new GetExpenseMeUseCase(deps);
    expect(await me.execute(scope, { subject: 'taro@example.com', displayName: '太郎', roles: ['editor'], singleUser: false, canApprove: false, employeeId: 'emp-taro' })).toEqual({
      subject: 'taro@example.com', displayName: '太郎', singleUser: false, canApprove: false, employee: { id: 'emp-taro', name: 'テスト太郎', departmentId: 'dept-sales' },
    });
    expect(await me.execute(scope, { subject: 'single-user', roles: [], singleUser: true, canApprove: true })).toEqual({ subject: 'single-user', singleUser: true, canApprove: true });
    expect(await me.execute(scope, { subject: 'x', roles: [], singleUser: false, canApprove: true, employeeId: 'emp-ghost' })).not.toHaveProperty('employee');
  });
});

describe('GetExpensePeopleReadinessUseCase', () => {
  it('正常: 何も設定していなければすべて未設定（失敗ではない）', async () => {
    expect(await new GetExpensePeopleReadinessUseCase(peopleTestDeps()).execute(scope)).toEqual({
      employees: { configured: false, enabledCount: 0 },
      organization: { saved: false, departmentCount: 0, approverGroupCount: 0 },
      payout: { configured: false, saved: false },
    });
  });

  it('正常: 有効な従業員が居れば従業員は設定済み、振込元は口座・依頼人コード・依頼人名が揃って保存されていれば設定済み', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const readiness = new GetExpensePeopleReadinessUseCase(deps);
    await deps.repositories.settings.save(scope, 'payout', createExpensePayoutSettings({ requesterCode: '0000000001', requesterNameKana: 'ｻﾝﾌﾟﾙ', updatedAt: PEOPLE_NOW }));
    expect(await readiness.execute(scope)).toEqual({
      employees: { configured: true, enabledCount: 4 },
      organization: { saved: true, departmentCount: 3, approverGroupCount: 1 },
      payout: { configured: false, saved: true },
    });
    await deps.repositories.settings.save(scope, 'payout', fixturePayoutSettings());
    expect((await readiness.execute(scope)).payout).toEqual({ configured: true, saved: true });
  });
});

describe('組織', () => {
  it('正常: 未保存なら空の組織を saved=false で返し、保存すると更新日時を今にして保存する', async () => {
    const deps = peopleTestDeps();
    const get = new GetExpenseOrganizationUseCase(deps);
    expect(await get.execute(scope)).toMatchObject({ saved: false, organization: { departments: [], approverGroups: [] } });
    const organization = fixtureOrganization();
    const saved = await new SaveExpenseOrganizationUseCase(deps).execute(scope, { departments: organization.departments, approverGroups: organization.approverGroups });
    expect(saved.updatedAt).toBe(PEOPLE_NOW);
    expect(await get.execute(scope)).toEqual({ saved: true, organization: saved });
  });

  it('異常: 有効な部門の名前の重複・親の循環は保存しない（400）', async () => {
    const save = new SaveExpenseOrganizationUseCase(peopleTestDeps());
    await expect(save.execute(scope, { departments: [{ id: 'a', name: '営業', enabled: true }, { id: 'b', name: '営業', enabled: true }], approverGroups: [] })).rejects.toBeInstanceOf(ExpenseDomainError);
    await expect(save.execute(scope, { departments: [{ id: 'a', name: 'A', parentId: 'b', enabled: true }, { id: 'b', name: 'B', parentId: 'a', enabled: true }], approverGroups: [] })).rejects.toThrow(/loops back/u);
  });
});
