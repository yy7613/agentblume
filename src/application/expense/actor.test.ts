/**
 * 経費の操作者（`resolveExpenseActor`）のテスト。
 *
 * 守りたいのは「従業員に結べなくても操作者は作る」（結べないことは承認の拒否理由で見せるため）と、
 * 無効な従業員には結ばない（退職者のログイン ID で承認の段を押させない）こと。
 */
import { describe, expect, it, vi } from 'vitest';
import { employeeFixture, fixtureEmployees, FIXTURE_EMPLOYEE_IDS, scope, V9_AT } from '../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseEmployeeRepository } from '../../adapters/storage/in-memory-expense-people-repositories';
import { SINGLE_USER_SUBJECT } from '../../domain/security/principal';
import { isSingleUserSubject, resolveExpenseActor } from './actor';

async function directory(): Promise<InMemoryExpenseEmployeeRepository> {
  const employees = new InMemoryExpenseEmployeeRepository();
  for (const employee of fixtureEmployees()) await employees.save(employee);
  return employees;
}

describe('isSingleUserSubject', () => {
  it('正常: 単一ユーザーモードの subject だけが true', () => {
    expect(isSingleUserSubject(SINGLE_USER_SUBJECT)).toBe(true);
    expect(isSingleUserSubject('taro@example.com')).toBe(false);
    expect(isSingleUserSubject('')).toBe(false);
  });
});

describe('resolveExpenseActor', () => {
  it('正常: ログイン ID が有効な従業員に一致すれば employeeId を結び、表示名とロールを写す', async () => {
    const actor = await resolveExpenseActor(await directory(), scope, { subject: 'taro@example.com', displayName: '太郎', roles: ['editor'] }, false);
    expect(actor).toEqual({ subject: 'taro@example.com', displayName: '太郎', roles: ['editor'], singleUser: false, canApprove: false, employeeId: FIXTURE_EMPLOYEE_IDS.taro });
  });

  it('正常: 2 つ目のログイン ID でも同じ従業員に結ぶ', async () => {
    const actor = await resolveExpenseActor(await directory(), scope, { subject: 'saburo-sso', roles: [] }, true);
    expect(actor.employeeId).toBe(FIXTURE_EMPLOYEE_IDS.saburo);
    expect(actor.canApprove).toBe(true);
  });

  it('境界: 表示名が無ければキーを作らず、ロールは写し（呼び出し側の配列を共有しない）', async () => {
    const roles = ['publisher'];
    const actor = await resolveExpenseActor(await directory(), scope, { subject: 'nobody@example.com', roles }, true);
    expect(actor).not.toHaveProperty('displayName');
    expect(actor).not.toHaveProperty('employeeId');
    expect(actor.roles).toEqual(['publisher']);
    expect(actor.roles).not.toBe(roles);
  });

  it('異常: 無効な従業員のログイン ID には結ばない（操作者は作る）', async () => {
    const employees = new InMemoryExpenseEmployeeRepository();
    await employees.save(employeeFixture('emp-retired', {
      loginSubjects: ['retired@example.com'], enabled: false,
      history: [{ type: 'created', by: 'keiri@example.com', at: V9_AT }, { type: 'disabled', by: 'keiri@example.com', at: V9_AT }],
    }));
    const actor = await resolveExpenseActor(employees, scope, { subject: 'retired@example.com', roles: [] }, true);
    expect(actor).toEqual({ subject: 'retired@example.com', roles: [], singleUser: false, canApprove: true });
  });

  it('境界: 従業員マスタを渡さない構成は引かずに操作者だけを作る。単一ユーザーは singleUser', async () => {
    const actor = await resolveExpenseActor(undefined, scope, { subject: SINGLE_USER_SUBJECT, displayName: 'Local operator', roles: ['admin'] }, true);
    expect(actor).toEqual({ subject: SINGLE_USER_SUBJECT, displayName: 'Local operator', roles: ['admin'], singleUser: true, canApprove: true });
  });

  it('境界: 別のワークスペースの従業員には結ばない', async () => {
    const actor = await resolveExpenseActor(await directory(), { tenantId: 'tenant', workspaceId: 'other' }, { subject: 'taro@example.com', roles: [] }, false);
    expect(actor).not.toHaveProperty('employeeId');
  });

  it('例外: 従業員マスタの読み取りの失敗はそのまま伝える（黙って「結べない」にしない）', async () => {
    const broken = { findBySubject: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as InMemoryExpenseEmployeeRepository;
    await expect(resolveExpenseActor(broken, scope, { subject: 'taro@example.com', roles: [] }, false)).rejects.toThrow('db down');
  });
});
