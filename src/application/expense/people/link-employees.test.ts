/**
 * 既存の申請の紐付け候補と、人による確定（docs/21 §20.1.1）。
 * 名前だけで自動では結ばない・承認中は 1 件でもあれば何も書かない・状態ごとの扱い（draft へ戻す / 写しだけ足す）。
 */
import { describe, expect, it } from 'vitest';
import { peopleTestDeps, seedPeople } from '../../../adapters/storage/expense-people-deps.fixtures';
import { AT, claimFixture } from '../../../adapters/storage/expense-repository.fixtures';
import { scope } from '../../../adapters/storage/expense-v9.fixtures';
import type { ExpenseClaim } from '../../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseDomainError, ExpenseEmployeeNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { ConfirmExpenseEmployeeLinksUseCase, ListExpenseEmployeeLinksUseCase } from './link-employees';

const flow = { routeName: '経路', resolvedAt: AT, policyUpdatedAt: AT, steps: [{ stepId: 'a', name: '段', approverKind: 'any-approver' as const, approvers: [], status: 'pending' as const }], currentIndex: 0 };

async function setup() {
  const deps = peopleTestDeps();
  await seedPeople(deps);
  const claims: ExpenseClaim[] = [
    claimFixture('c-code', { claimant: { name: '別の表記', employeeCode: 'E001' }, status: 'checked' }),
    claimFixture('c-name', { claimant: { name: 'テスト花子' } }),
    claimFixture('c-none', { claimant: { name: '山田 一郎' } }),
    claimFixture('c-linked', { claimant: { name: 'テスト次郎', employeeId: 'emp-jiro', departmentId: 'dept-admin' } }),
    claimFixture('c-approved', { claimant: { name: 'テスト三郎' }, status: 'approved', approval: { by: 'boss', at: AT } }),
    claimFixture('c-in-approval', { claimant: { name: 'テスト太郎' }, status: 'in-approval', approvalFlow: flow }),
  ];
  for (const claim of claims) await deps.repositories.claims.save(claim, new Map());
  return { deps, list: new ListExpenseEmployeeLinksUseCase(deps), confirm: new ConfirmExpenseEmployeeLinksUseCase(deps) };
}

describe('ListExpenseEmployeeLinksUseCase', () => {
  it('正常: 未紐付けの申請ごとに社員番号 → 氏名の順で候補を示し、部門名を添える（紐付き済みは出さない）', async () => {
    const { list } = await setup();
    const links = Object.fromEntries((await list.execute(scope)).map((link) => [link.claimId, link]));
    expect(Object.keys(links).sort()).toEqual(['c-approved', 'c-code', 'c-in-approval', 'c-name', 'c-none']);
    expect(links['c-code']).toMatchObject({ status: 'checked', match: 'exact-code', candidates: [{ id: 'emp-taro', name: 'テスト太郎', code: 'E001', department: '営業部' }] });
    expect(links['c-name']).toMatchObject({ match: 'unique-name', candidates: [{ id: 'emp-hanako', department: '営業部' }] });
    expect(links['c-approved']?.candidates).toEqual([{ id: 'emp-saburo', name: 'テスト三郎', department: '経理部' }]);
    expect(links['c-none']).toMatchObject({ match: 'none', candidates: [] });
    expect((await list.execute(scope, { status: 'checked' })).map((link) => link.claimId)).toEqual(['c-code']);
  });
});

describe('ConfirmExpenseEmployeeLinksUseCase', () => {
  it('正常: 選んだ組だけを書き、チェック済みは下書きへ戻し（再チェック）、承認済みは状態を変えずに参照だけ足す', async () => {
    const { deps, confirm } = await setup();
    const result = await confirm.execute(scope, [{ claimId: 'c-code', employeeId: 'emp-taro' }, { claimId: 'c-name', employeeId: 'emp-hanako' }, { claimId: 'c-approved', employeeId: 'emp-saburo' }], 'keiri@example.com');
    expect(result).toEqual({ linked: 3, movedToDraft: 1, skipped: [] });
    const code = (await deps.repositories.claims.findById(scope, 'c-code'))!;
    expect(code).toMatchObject({ status: 'draft', claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' } });
    expect(code.history.at(-1)).toMatchObject({ type: 'employee-linked', by: 'keiri@example.com', note: 'emp-taro' });
    expect((await deps.repositories.claims.findById(scope, 'c-approved'))).toMatchObject({ status: 'approved', claimant: { name: 'テスト三郎', employeeId: 'emp-saburo', departmentId: 'dept-accounting' } });
    expect(deps.transactions.count).toBe(1);
  });

  it('境界: 既に同じ従業員に紐付いた申請は書かずに skipped（already-linked）', async () => {
    const { confirm } = await setup();
    expect(await confirm.execute(scope, [{ claimId: 'c-linked', employeeId: 'emp-jiro' }], 'k')).toEqual({ linked: 0, movedToDraft: 0, skipped: [{ claimId: 'c-linked', reason: 'already-linked' }] });
  });

  it('異常: 承認中の申請が 1 件でもあれば、どの申請かを付けた 409 で何も保存しない', async () => {
    const { deps, confirm } = await setup();
    const error = await confirm.execute(scope, [{ claimId: 'c-code', employeeId: 'emp-taro' }, { claimId: 'c-in-approval', employeeId: 'emp-taro' }], 'k').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ExpenseTransitionError);
    expect((error as ExpenseTransitionError).claims).toEqual([{ id: 'c-in-approval', status: 'in-approval' }]);
    expect((error as ExpenseTransitionError).nextStep).toContain('何も保存していません');
    expect((await deps.repositories.claims.findById(scope, 'c-code'))?.status).toBe('checked');
  });

  it('異常: 同じ申請の二重指定は 400、無い申請・無い従業員は 404、無効な従業員は 400', async () => {
    const { confirm } = await setup();
    await expect(confirm.execute(scope, [{ claimId: 'c-name', employeeId: 'emp-taro' }, { claimId: 'c-name', employeeId: 'emp-hanako' }], 'k')).rejects.toBeInstanceOf(ExpenseDomainError);
    await expect(confirm.execute(scope, [{ claimId: 'c-ghost', employeeId: 'emp-taro' }], 'k')).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
    await expect(confirm.execute(scope, [{ claimId: 'c-name', employeeId: 'emp-ghost' }], 'k')).rejects.toBeInstanceOf(ExpenseEmployeeNotFoundError);
    await expect(confirm.execute(scope, [{ claimId: 'c-name', employeeId: 'emp-shiro' }], 'k')).rejects.toMatchObject({ details: { field: 'claimant.employeeId' } });
  });
});
