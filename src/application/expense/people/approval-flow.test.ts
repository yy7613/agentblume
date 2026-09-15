/** 承認の流れの表示と経路の試算（docs/21 §20.9.2 / §20.10.1）。 */
import { describe, expect, it } from 'vitest';
import { PEOPLE_NOW, peopleTestDeps, policyWithApproval, seedPeople, TWO_STEP_APPROVAL } from '../../../adapters/storage/expense-people-deps.fixtures';
import { AT, claimFixture, itemFixture } from '../../../adapters/storage/expense-repository.fixtures';
import { scope } from '../../../adapters/storage/expense-v9.fixtures';
import { flowFromPlan, mvpApprovalPlan, planFromFlow } from '../../../domain/expense/approval';
import { claimFingerprint, withJudgment, type ExpenseClaim } from '../../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseDomainError } from '../../../domain/expense/errors';
import type { ExpenseActor } from '../actor';
import { judgeClaim } from '../check-claims';
import { DescribeExpenseApprovalFlowUseCase, PreviewApprovalRouteUseCase } from './approval-flow';
import { PeopleApprovalPlanner } from './approval-planner';

const actor = (subject: string, employeeId?: string, canApprove = true): ExpenseActor => ({ subject, roles: [], singleUser: subject === 'single-user', canApprove, ...(employeeId === undefined ? {} : { employeeId }) });
const passing = itemFixture('i1', { transactionDate: '2026-09-02', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', description: '霞ケ関→大手町' }, { categoryId: 'transport.public' });

async function setup() {
  const deps = peopleTestDeps();
  await seedPeople(deps);
  const policy = policyWithApproval(TWO_STEP_APPROVAL);
  await deps.repositories.policies.save(scope, policy);
  const planner = new PeopleApprovalPlanner(deps);
  const claimant = { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' };
  const draft = claimFixture('c-draft', { claimant, items: [passing] });
  const { judgment } = await judgeClaim(deps.repositories.claims, deps.repositories.receipts, draft, policy, true, '2026-09-30', []);
  const judged = withJudgment(draft, { ...judgment, policyUpdatedAt: policy.updatedAt, itemsFingerprint: claimFingerprint(draft), checkedAt: AT }, AT);
  const checked: ExpenseClaim = { ...judged, id: 'c-checked' };
  const plan = await planner.plan(scope, checked, policy);
  const started = flowFromPlan(plan, PEOPLE_NOW, policy.updatedAt);
  const inApproval: ExpenseClaim = {
    ...judged, id: 'c-in-approval', status: 'in-approval',
    approvalFlow: { ...started, steps: [{ ...started.steps[0]!, status: 'approved', decision: { by: 'hanako@example.com', employeeId: 'emp-hanako', at: PEOPLE_NOW, proxy: false } }, started.steps[1]!], currentIndex: 1 },
  };
  const approvedMvp = claimFixture('c-approved', { claimant, status: 'approved', approval: { by: 'boss', at: AT } });
  const approvedFlow: ExpenseClaim = { ...inApproval, id: 'c-approved-flow', status: 'approved', approval: { by: 'saburo@example.com', at: PEOPLE_NOW }, approvalFlow: { ...inApproval.approvalFlow!, currentIndex: 2, steps: [inApproval.approvalFlow!.steps[0]!, { ...inApproval.approvalFlow!.steps[1]!, status: 'approved', decision: { by: 'saburo@example.com', at: PEOPLE_NOW, proxy: false } }] } };
  for (const claim of [draft, checked, inApproval, approvedMvp, approvedFlow]) await deps.repositories.claims.save(claim, new Map());
  return { deps, planner, use: new DescribeExpenseApprovalFlowUseCase(deps, planner) };
}

describe('DescribeExpenseApprovalFlowUseCase', () => {
  it('正常: 下書きはチェックした後の予定を見せるだけで押せない', async () => {
    const { use } = await setup();
    const view = await use.execute(scope, 'c-draft', actor('hanako@example.com', 'emp-hanako'));
    expect(view).toMatchObject({ canAct: false, proxy: false, blockers: [], plan: { routeId: 'two-step' } });
    expect(view).not.toHaveProperty('flow');
    expect(view.plan.steps.map((step) => step.approvers.map((ref) => ref.employeeId))).toEqual([['emp-hanako'], ['emp-saburo', 'emp-jiro']]);
  });

  it('正常: checked は現在の段と承認者を示し、承認者本人は押せる。承認者でない人は拒否理由つき、承認権限が無ければ押せない', async () => {
    const { use } = await setup();
    const hanako = await use.execute(scope, 'c-checked', actor('hanako@example.com', 'emp-hanako'));
    expect(hanako).toMatchObject({ canAct: true, proxy: false, blockers: [], current: { index: 0, stepId: 'manager', stepName: '上長', approvers: [{ employeeId: 'emp-hanako', name: 'テスト花子' }] } });
    expect(hanako).not.toHaveProperty('flow');
    const jiro = await use.execute(scope, 'c-checked', actor('jiro@example.com', 'emp-jiro'));
    expect(jiro.canAct).toBe(false);
    expect(jiro.blockers.map((blocker) => blocker.code)).toEqual(['approval-not-current-approver']);
    expect((await use.execute(scope, 'c-checked', actor('hanako@example.com', 'emp-hanako', false))).canAct).toBe(false);
  });

  it('正常: 単一ユーザーは代理承認（proxy=true）として押せる。コメントの不足は押す前の妨げにしない', async () => {
    const { use } = await setup();
    expect(await use.execute(scope, 'c-checked', actor('single-user'))).toMatchObject({ canAct: true, proxy: true, blockers: [] });
  });

  it('正常: 承認中は保存済みの流れと 2 段目の承認者を返す', async () => {
    const { use } = await setup();
    const view = await use.execute(scope, 'c-in-approval', actor('saburo@example.com', 'emp-saburo'));
    expect(view).toMatchObject({ canAct: true, proxy: false, current: { index: 1, stepId: 'accounting', stepName: '経理' } });
    expect(view.flow?.steps[0]?.decision).toMatchObject({ by: 'hanako@example.com' });
    expect(view.plan).toEqual(planFromFlow(view.flow!));
  });

  it('正常: 承認済みは保存済みの流れ（MVP の 1 段で承認したものは既定の計画）を見せるだけ。無い申請は 404', async () => {
    const { use } = await setup();
    expect(await use.execute(scope, 'c-approved', actor('x'))).toEqual({ plan: mvpApprovalPlan(), canAct: false, proxy: false, blockers: [] });
    const withFlow = await use.execute(scope, 'c-approved-flow', actor('x'));
    expect(withFlow).toMatchObject({ canAct: false, flow: { currentIndex: 2 } });
    await expect(use.execute(scope, 'c-ghost', actor('x'))).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });
});

describe('PreviewApprovalRouteUseCase', () => {
  it('正常: 保存していない承認設定でも部門・費目・金額・申請者から経路と承認者を解決し、最初の段を返す', async () => {
    const { planner } = await setup();
    const preview = await new PreviewApprovalRouteUseCase(planner).execute(scope, { approval: TWO_STEP_APPROVAL, policyCategoryIds: [], subject: { categoryIds: [], totalAmount: 1000, departmentId: 'dept-sales', claimantEmployeeId: 'emp-taro' } });
    expect(preview).toMatchObject({ firstStepId: 'manager', plan: { routeId: 'two-step', unresolved: [] } });
    const unlinked = await new PreviewApprovalRouteUseCase(planner).execute(scope, { approval: TWO_STEP_APPROVAL, policyCategoryIds: [], subject: { categoryIds: [], totalAmount: 1000 } });
    expect(unlinked.plan.unresolved.map((entry) => entry.cause)).toEqual(['claimant-unlinked']);
  });

  it('異常: 検証を通らない承認設定（条件なしの経路が最後でない・規程に無い費目）は 400', async () => {
    const { planner } = await setup();
    const preview = new PreviewApprovalRouteUseCase(planner);
    const everything = { id: 'all', name: '全部', enabled: true, when: {}, steps: [{ id: 's', name: 's', approver: { kind: 'any-approver' } }] };
    await expect(preview.execute(scope, { approval: { routes: [everything, { ...everything, id: 'late', when: { minClaimAmount: 1 } }] }, policyCategoryIds: [], subject: { categoryIds: [], totalAmount: 0 } })).rejects.toBeInstanceOf(ExpenseDomainError);
    await expect(preview.execute(scope, { approval: { routes: [{ ...everything, when: { categoryIds: ['nope'] } }] }, policyCategoryIds: ['misc'], subject: { categoryIds: [], totalAmount: 0 } })).rejects.toThrow(/not in the policy/u);
  });
});
