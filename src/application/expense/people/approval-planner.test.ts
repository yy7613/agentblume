/** 承認経路のプランナー（docs/21 §20.2.6。組織と要る従業員だけを引いて domain の解決へ渡す）。 */
import { describe, expect, it, vi } from 'vitest';
import { PEOPLE_NOW, peopleTestDeps, policyWithApproval, seedPeople, TWO_STEP_APPROVAL } from '../../../adapters/storage/expense-people-deps.fixtures';
import { claimFixture } from '../../../adapters/storage/expense-repository.fixtures';
import { scope } from '../../../adapters/storage/expense-v9.fixtures';
import { flowFromPlan, mvpApprovalPlan, validateApprovalSettings } from '../../../domain/expense/approval';
import { defaultExpensePolicy } from '../../../domain/expense/default-policy';
import { loadApprovalEmployees, PeopleApprovalPlanner } from './approval-planner';

const taroClaim = (overrides = {}) => claimFixture('c1', { claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' }, ...overrides });

describe('PeopleApprovalPlanner', () => {
  it('正常: 経路が無い規程では MVP と同じ 1 段で、従業員を 1 人も引かない', async () => {
    const deps = peopleTestDeps();
    const findByIds = vi.spyOn(deps.repositories.employees, 'findByIds');
    const planner = new PeopleApprovalPlanner(deps);
    expect(await planner.plan(scope, claimFixture('c1'), defaultExpensePolicy())).toEqual(mvpApprovalPlan());
    expect(findByIds).not.toHaveBeenCalled();
  });

  it('正常: 2 段の経路は申請者の上長 → 経理グループのメンバーに解決する', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const plan = await new PeopleApprovalPlanner(deps).plan(scope, taroClaim(), policyWithApproval(TWO_STEP_APPROVAL));
    expect(plan).toMatchObject({ routeId: 'two-step', routeName: '上長と経理', unresolved: [] });
    expect(plan.steps.map((step) => step.approvers.map((ref) => ref.name))).toEqual([['テスト花子'], ['テスト三郎', 'テスト次郎']]);
  });

  it('異常: 申請者が見つからない・紐付かないときは原因つきで未解決にする', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const planner = new PeopleApprovalPlanner(deps);
    const policy = policyWithApproval(TWO_STEP_APPROVAL);
    expect((await planner.plan(scope, claimFixture('c1'), policy)).unresolved.map((entry) => entry.cause)).toEqual(['claimant-unlinked']);
    expect((await planner.plan(scope, taroClaim({ claimant: { name: 'x', employeeId: 'emp-ghost' } }), policy)).unresolved.map((entry) => entry.cause)).toEqual(['claimant-unlinked']);
    const jiro = await planner.planFor(scope, { categoryIds: [], totalAmount: 1, claimantEmployeeId: 'emp-jiro' }, policy.approval);
    expect(jiro.unresolved[0]).toMatchObject({ stepId: 'manager', cause: 'manager-missing', params: { claimant: 'テスト次郎' } });
  });

  it('正常: 操作者の拒否理由は組織の代理承認グループを見て決める（単一ユーザーは代理）', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const planner = new PeopleApprovalPlanner(deps);
    const policy = policyWithApproval({ ...TWO_STEP_APPROVAL, proxyGroupId: 'group-accounting' });
    const claim = taroClaim({ status: 'checked' });
    const flow = flowFromPlan(await planner.plan(scope, claim, policy), PEOPLE_NOW, policy.updatedAt);
    const actor = (subject: string, employeeId?: string) => ({ subject, roles: [], singleUser: subject === 'single-user', canApprove: true, ...(employeeId === undefined ? {} : { employeeId }) });
    expect(await planner.actorBlockers(scope, { claim, policy, flow, actor: actor('hanako@example.com', 'emp-hanako') })).toEqual({ blockers: [], proxy: false });
    expect(await planner.actorBlockers(scope, { claim, policy, flow, actor: actor('jiro@example.com', 'emp-jiro'), comment: '部長不在' })).toEqual({ blockers: [], proxy: true });
    expect(await planner.actorBlockers(scope, { claim, policy, flow, actor: actor('single-user') })).toMatchObject({ blockers: [{ code: 'approval-proxy-comment-missing' }], proxy: true });
  });

  it('正常: 現在の段の承認者は checked なら計画の最初の段、in-approval なら保存済みの流れ、それ以外は空', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const planner = new PeopleApprovalPlanner(deps);
    const policy = policyWithApproval(TWO_STEP_APPROVAL);
    expect(await planner.currentApprovers(scope, taroClaim({ status: 'checked' }), policy)).toEqual(['emp-hanako']);
    const flow = flowFromPlan(await planner.plan(scope, taroClaim(), policy), PEOPLE_NOW, policy.updatedAt);
    const moved = { ...flow, steps: [{ ...flow.steps[0]!, status: 'approved' as const, decision: { by: 'hanako@example.com', at: PEOPLE_NOW, proxy: false } }, flow.steps[1]!], currentIndex: 1 };
    expect(await planner.currentApprovers(scope, { ...taroClaim({ status: 'checked' }), status: 'in-approval', approvalFlow: moved }, policy)).toEqual(['emp-saburo', 'emp-jiro']);
    expect(await planner.currentApprovers(scope, taroClaim(), policy)).toEqual([]);
  });

  it('正常: loadApprovalEmployees は申請者が居なくても段の参照先だけを引く', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const approval = validateApprovalSettings({ routes: [{ id: 'g', name: 'g', enabled: true, when: {}, steps: [{ id: 'g', name: 'g', approver: { kind: 'group', groupId: 'group-accounting' } }] }] }, new Set());
    const employees = await loadApprovalEmployees(deps.employeeDirectory, scope, { categoryIds: [], totalAmount: 0 }, approval, await deps.organization.get(scope));
    expect(employees.map((employee) => employee.id)).toEqual(['emp-saburo', 'emp-jiro']);
  });
});
