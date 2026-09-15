/**
 * 承認経路の当て方・承認者の解決・操作者の拒否理由（docs/21 §20.2.6 / §20.5.1）。
 * domain のテストは adapters のフィクスチャを使えないので、従業員と組織はここで組む。
 */
import { describe, expect, it } from 'vitest';
import { flowFromPlan, mvpApprovalPlan, validateApprovalSettings, type ApprovalFlow, type ApprovalSettings, type ApproverSpec } from '../approval';
import type { ExpenseItem } from '../claim';
import { createExpenseOrganization } from '../organization';
import {
  actorStepBlockers, approvalEmployeeIdsToLoad, approvalSubjectOf, currentApproverIds, firstPendingPlanStep, resolveApprovalPlan, resolveApprovalPlanFor,
  routeMatches, selectApprovalRoute, type ApprovalEmployee, type ApprovalRouteSubject,
} from './approval-route';

const AT = '2026-09-15T00:00:00.000Z';
const approval = (raw: unknown): ApprovalSettings => validateApprovalSettings(raw, new Set(['meal.entertainment', 'transport.taxi', 'misc']));
const step = (id: string, approver: ApproverSpec, skipWhenSameAsPrevious = false) => ({ id, name: `段${id}`, approver, skipWhenSameAsPrevious });
const route = (id: string, steps: readonly ReturnType<typeof step>[], when: Record<string, unknown> = { departmentIds: ['sales'] }, enabled = true) => ({ id, name: `経路${id}`, enabled, when, steps });

const employees: readonly ApprovalEmployee[] = [
  { id: 'taro', name: 'テスト太郎', enabled: true, managerEmployeeId: 'hanako', departmentId: 'sales' },
  { id: 'hanako', name: 'テスト花子', enabled: true, managerEmployeeId: 'jiro', departmentId: 'sales' },
  { id: 'jiro', name: 'テスト次郎', enabled: true, departmentId: 'admin' },
  { id: 'saburo', name: 'テスト三郎', enabled: true, managerEmployeeId: 'shiro', departmentId: 'accounting' },
  { id: 'shiro', name: 'テスト四郎', enabled: false, departmentId: 'sales' },
  { id: 'orphan', name: '上長不明', enabled: true, managerEmployeeId: 'ghost' },
  { id: 'nodept', name: '部門なし', enabled: true },
];

const organization = createExpenseOrganization({
  departments: [
    { id: 'admin', name: '管理本部', headEmployeeId: 'jiro', enabled: true },
    { id: 'sales', name: '営業部', parentId: 'admin', headEmployeeId: 'hanako', enabled: true },
    { id: 'accounting', name: '経理部', parentId: 'admin', enabled: true },
  ],
  approverGroups: [
    { id: 'accounting', name: '経理', memberEmployeeIds: ['saburo', 'jiro'], enabled: true },
    { id: 'empty', name: '空', memberEmployeeIds: ['shiro'], enabled: true },
    { id: 'off', name: '停止', memberEmployeeIds: ['jiro'], enabled: false },
    { id: 'self', name: '本人だけ', memberEmployeeIds: ['taro'], enabled: true },
  ],
  updatedAt: AT,
});

const subject = (overrides: Partial<ApprovalRouteSubject> = {}): ApprovalRouteSubject => ({ categoryIds: ['meal.entertainment'], totalAmount: 60000, departmentId: 'sales', claimantEmployeeId: 'taro', ...overrides });

function onlyStep(approver: ApproverSpec, subjectOverrides: Partial<ApprovalRouteSubject> = {}, settings: Record<string, unknown> = {}) {
  return resolveApprovalPlanFor(subject(subjectOverrides), approval({ routes: [route('r', [step('a', approver)], {})], ...settings }), organization, employees);
}

describe('selectApprovalRoute / routeMatches', () => {
  const settings = approval({
    routes: [
      route('disabled', [step('x', { kind: 'any-approver' })], { departmentIds: ['sales'] }, false),
      route('big-meal', [step('a', { kind: 'claimant-manager' }), step('b', { kind: 'group', groupId: 'accounting' })], { categoryIds: ['meal.entertainment'], minClaimAmount: 50000, departmentIds: ['sales'] }),
      route('sales', [step('c', { kind: 'claimant-manager' })], { departmentIds: ['sales'] }),
    ],
  });

  it('正常: 有効な経路を上から見て、条件（費目・金額以上・部門の AND）を満たす最初の経路を選ぶ', () => {
    expect(selectApprovalRoute(subject(), settings).route?.id).toBe('big-meal');
    expect(selectApprovalRoute(subject({ categoryIds: ['transport.taxi'] }), settings).route?.id).toBe('sales');
  });

  it('境界: 最低金額はちょうどなら当たり、1 円足りなければ次の経路', () => {
    expect(selectApprovalRoute(subject({ totalAmount: 50000 }), settings).route?.id).toBe('big-meal');
    expect(selectApprovalRoute(subject({ totalAmount: 49999 }), settings).route?.id).toBe('sales');
  });

  it('正常: どれにも当たらなければ既定の段（経路名は既定の承認、route なし）。無効な経路は当てない', () => {
    const selected = selectApprovalRoute(subject({ departmentId: 'accounting' }), settings);
    expect(selected).toEqual({ routeName: '既定の承認', steps: settings.defaultSteps });
    expect(routeMatches({ when: { categoryIds: [], departmentIds: ['sales'] } }, subject({ departmentId: undefined }))).toBe(false);
    expect(routeMatches({ when: { categoryIds: [], departmentIds: [] } }, subject({ categoryIds: [] }))).toBe(true);
  });

  it('正常: approvalSubjectOf は明細の費目・合計・申請者の部門と従業員を取り出し、紐付かない申請はキーを作らない', () => {
    const items = [
      { id: 'i1', categoryId: 'meal.entertainment', facts: { amount: 30000 }, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] }, addedOn: '2026-09-14' },
      { id: 'i2', facts: { amount: 20000 }, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] }, addedOn: '2026-09-14' },
    ] as unknown as ExpenseItem[];
    expect(approvalSubjectOf({ items, claimant: { name: 'テスト太郎', employeeId: 'taro', departmentId: 'sales' } })).toEqual({ categoryIds: ['meal.entertainment'], totalAmount: 50000, departmentId: 'sales', claimantEmployeeId: 'taro' });
    expect(approvalSubjectOf({ items: [], claimant: { name: '手入力' } })).toEqual({ categoryIds: [], totalAmount: 0 });
  });
});

describe('resolveApprovalPlan', () => {
  it('正常: 経路が無ければ MVP と同じ 1 段（approve 権限を持つ誰でも）の計画', () => {
    expect(resolveApprovalPlanFor(subject(), approval(undefined), organization, employees)).toEqual(mvpApprovalPlan());
    expect(resolveApprovalPlan({ items: [], claimant: { name: 'x' } }, { approval: approval({}) }, organization, [])).toEqual(mvpApprovalPlan());
  });

  it('正常: 上長 → 部門長（同じ人なら飛ばす）→ 承認グループ → 指定の従業員を順に解決する', () => {
    const plan = resolveApprovalPlanFor(subject(), approval({
      routes: [route('multi', [
        step('manager', { kind: 'claimant-manager' }),
        step('head', { kind: 'department-head' }, true),
        step('group', { kind: 'group', groupId: 'accounting' }),
        step('boss', { kind: 'employee', employeeId: 'jiro' }, true),
      ])],
    }), organization, employees);
    expect(plan.routeId).toBe('multi');
    expect(plan.unresolved).toEqual([]);
    expect(plan.steps.map((entry) => [entry.stepId, entry.approvers.map((ref) => ref.employeeId), entry.skipped])).toEqual([
      ['manager', ['hanako'], false],
      ['head', ['hanako'], true],
      ['group', ['saburo', 'jiro'], false],
      ['boss', ['jiro'], false],
    ]);
    expect(firstPendingPlanStep(plan)?.stepId).toBe('manager');
  });

  it('正常: 承認権限を持つ誰でもが続く段は飛ばせる。直前の段が決まらなければ飛ばさない', () => {
    const anyTwice = resolveApprovalPlanFor(subject(), approval({ routes: [route('r', [step('a', { kind: 'any-approver' }), step('b', { kind: 'any-approver' }, true)], {})] }), organization, employees);
    expect(anyTwice.steps.map((entry) => entry.skipped)).toEqual([false, true]);
    const afterFailure = resolveApprovalPlanFor(subject(), approval({ routes: [route('r', [step('a', { kind: 'group', groupId: 'empty' }), step('b', { kind: 'group', groupId: 'empty' }, true)], {})] }), organization, employees);
    expect(afterFailure.steps.map((entry) => entry.skipped)).toEqual([false, false]);
    expect(firstPendingPlanStep({ steps: [{ ...anyTwice.steps[0]!, skipped: true }] })).toBeUndefined();
  });

  it('正常: 部門長が空・無効なら親の部門長へたどり、段の部門の指定は申請者の部門より優先する', () => {
    expect(onlyStep({ kind: 'department-head' }, { departmentId: 'accounting', claimantEmployeeId: 'saburo' }).steps[0]?.approvers).toEqual([{ employeeId: 'jiro', name: 'テスト次郎' }]);
    expect(onlyStep({ kind: 'department-head', departmentId: 'admin' }).steps[0]?.approvers).toEqual([{ employeeId: 'jiro', name: 'テスト次郎' }]);
    const disabledHead = createExpenseOrganization({ departments: [...organization.departments.map((entry) => (entry.id === 'sales' ? { ...entry, headEmployeeId: 'shiro' } : entry))], approverGroups: [], updatedAt: AT });
    const plan = resolveApprovalPlanFor(subject(), approval({ routes: [route('r', [step('a', { kind: 'department-head' })], {})] }), disabledHead, employees);
    expect(plan.steps[0]?.approvers.map((ref) => ref.employeeId)).toEqual(['jiro']);
    // 申請の写しに部門が無ければ、紐付いた従業員の部門から辿る。
    expect(onlyStep({ kind: 'department-head' }, { departmentId: undefined, claimantEmployeeId: 'saburo' }).steps[0]?.approvers.map((ref) => ref.employeeId)).toEqual(['jiro']);
  });

  it('境界: 部門長は 10 段上までしかたどらない（11 段上の部門長は見つからない扱い）', () => {
    const chain = (headAt: number) => createExpenseOrganization({
      departments: Array.from({ length: 12 }, (_, index) => ({ id: `d${index}`, name: `部門${index}`, ...(index < 11 ? { parentId: `d${index + 1}` } : {}), ...(index === headAt ? { headEmployeeId: 'jiro' } : {}), enabled: true })),
      approverGroups: [],
      updatedAt: AT,
    });
    const settings = approval({ routes: [route('r', [step('a', { kind: 'department-head' })], {})] });
    expect(resolveApprovalPlanFor(subject({ departmentId: 'd0' }), settings, chain(10), employees).unresolved).toEqual([]);
    expect(resolveApprovalPlanFor(subject({ departmentId: 'd0' }), settings, chain(11), employees).unresolved).toEqual([
      { stepId: 'a', stepName: '段a', cause: 'department-head-missing', params: { department: '部門0', departmentId: 'd0' } },
    ]);
  });

  it('異常: 承認者が決まらない原因を段ごとに返す（上長・部門長・指定の従業員・グループ・申請者未紐付け）', () => {
    const cause = (approver: ApproverSpec, overrides: Partial<ApprovalRouteSubject> = {}) => onlyStep(approver, overrides).unresolved[0];
    expect(cause({ kind: 'claimant-manager' }, { claimantEmployeeId: undefined })).toMatchObject({ cause: 'claimant-unlinked' });
    expect(cause({ kind: 'claimant-manager' }, { claimantEmployeeId: 'jiro' })).toMatchObject({ cause: 'manager-missing', params: { claimant: 'テスト次郎', employeeId: 'jiro' } });
    expect(cause({ kind: 'claimant-manager' }, { claimantEmployeeId: 'saburo' })).toMatchObject({ cause: 'manager-disabled', params: { claimant: 'テスト三郎', manager: 'テスト四郎', employeeId: 'saburo' } });
    expect(cause({ kind: 'claimant-manager' }, { claimantEmployeeId: 'orphan' })).toMatchObject({ cause: 'manager-disabled', params: { manager: 'ghost' } });
    expect(cause({ kind: 'department-head' }, { departmentId: undefined, claimantEmployeeId: undefined })).toMatchObject({ cause: 'claimant-unlinked' });
    expect(cause({ kind: 'department-head' }, { departmentId: undefined, claimantEmployeeId: 'nodept' })).toMatchObject({ cause: 'department-head-missing', params: { department: null, employeeId: 'nodept' } });
    expect(cause({ kind: 'department-head' }, { departmentId: 'ghost' })).toMatchObject({ cause: 'department-head-missing', params: { department: 'ghost', departmentId: 'ghost' } });
    expect(cause({ kind: 'employee', employeeId: 'shiro' })).toMatchObject({ cause: 'employee-disabled', params: { employee: 'テスト四郎', employeeId: 'shiro' } });
    expect(cause({ kind: 'employee', employeeId: 'ghost' })).toMatchObject({ cause: 'employee-disabled', params: { employee: 'ghost' } });
    expect(cause({ kind: 'group', groupId: 'empty' })).toMatchObject({ cause: 'group-empty', params: { group: '空', groupId: 'empty' } });
    expect(cause({ kind: 'group', groupId: 'off' })).toMatchObject({ cause: 'group-empty', params: { group: '停止' } });
    expect(cause({ kind: 'group', groupId: 'missing' })).toMatchObject({ cause: 'group-empty', params: { group: 'missing' } });
    expect(cause({ kind: 'any-approver' })).toBeUndefined();
  });

  it('正常: 本人の承認を禁止する規程では申請者を承認者から除き、それで空なら only-claimant。禁止しなければ本人も承認者', () => {
    expect(onlyStep({ kind: 'group', groupId: 'accounting' }, { claimantEmployeeId: 'saburo' }).steps[0]?.approvers.map((ref) => ref.employeeId)).toEqual(['jiro']);
    expect(onlyStep({ kind: 'group', groupId: 'self' }).unresolved[0]).toMatchObject({ cause: 'only-claimant', params: { employeeId: 'taro' } });
    expect(onlyStep({ kind: 'group', groupId: 'self' }, {}, { forbidClaimantApproval: false }).steps[0]?.approvers.map((ref) => ref.employeeId)).toEqual(['taro']);
  });

  it('正常: approvalEmployeeIdsToLoad は申請者・上長・部門長の鎖・グループのメンバー・指定の従業員を集める', () => {
    const settings = approval({ routes: [route('r', [step('m', { kind: 'claimant-manager' }), step('h', { kind: 'department-head' }), step('g', { kind: 'group', groupId: 'accounting' }), step('e', { kind: 'employee', employeeId: 'shiro' }), step('a', { kind: 'any-approver' })], {})] });
    expect([...approvalEmployeeIdsToLoad(subject(), settings, organization, employees[0])].sort()).toEqual(['hanako', 'jiro', 'saburo', 'shiro', 'taro']);
    expect([...approvalEmployeeIdsToLoad(subject({ claimantEmployeeId: undefined, departmentId: undefined }), settings, organization)].sort()).toEqual(['jiro', 'saburo', 'shiro']);
    expect(approvalEmployeeIdsToLoad(subject({ claimantEmployeeId: undefined }), approval({ routes: [route('g', [step('g', { kind: 'group', groupId: 'missing' })], {})] }), organization)).toEqual([]);
  });
});

describe('actorStepBlockers', () => {
  const settings = approval({
    routes: [route('two', [step('manager', { kind: 'claimant-manager' }), step('accounting', { kind: 'group', groupId: 'accounting' })], {})],
    proxyGroupId: 'accounting',
    requireDistinctApprovers: true,
  });
  const policy = { approval: settings };
  const claim = { claimant: { name: 'テスト太郎', employeeId: 'taro' } };
  const plan = resolveApprovalPlanFor(subject(), settings, organization, employees);
  const flow = flowFromPlan(plan, AT, AT);
  const approvedFirst: ApprovalFlow = {
    ...flow,
    steps: [{ ...flow.steps[0]!, status: 'approved', decision: { by: 'hanako@example.com', employeeId: 'hanako', at: AT, proxy: false } }, flow.steps[1]!],
    currentIndex: 1,
  };
  const token = (subjectName: string, employeeId?: string) => ({ subject: subjectName, singleUser: false, ...(employeeId === undefined ? {} : { employeeId }) });

  it('正常: 現在の段の承認者は代理でなく押せる', () => {
    expect(actorStepBlockers(flow, token('hanako@example.com', 'hanako'), claim, policy, organization)).toEqual({ blockers: [], proxy: false });
  });

  it('正常: 単一ユーザーと代理承認グループのメンバーは代理（コメント必須）で押せる', () => {
    const single = { subject: 'single-user', singleUser: true };
    expect(actorStepBlockers(flow, single, claim, policy, organization)).toEqual({ blockers: [{ code: 'approval-proxy-comment-missing', params: { stepName: '段manager' } }], proxy: true });
    expect(actorStepBlockers(flow, single, claim, policy, organization, '部長不在のため代理')).toEqual({ blockers: [], proxy: true });
    expect(actorStepBlockers(flow, token('jiro@example.com', 'jiro'), claim, policy, organization, '  ')).toMatchObject({ blockers: [{ code: 'approval-proxy-comment-missing' }], proxy: true });
    expect(actorStepBlockers(flow, token('jiro@example.com', 'jiro'), claim, policy, organization, '代理')).toEqual({ blockers: [], proxy: true });
  });

  it('異常: 承認者でも代理グループでもなければ not-current-approver（承認者名つき）、従業員に結ばれていなければ actor-unlinked', () => {
    const disabledProxy = createExpenseOrganization({ departments: organization.departments, approverGroups: organization.approverGroups.map((group) => (group.id === 'accounting' ? { ...group, enabled: false } : group)), updatedAt: AT });
    expect(actorStepBlockers(flow, token('jiro@example.com', 'jiro'), claim, policy, disabledProxy, 'x')).toEqual({ blockers: [{ code: 'approval-not-current-approver', params: { stepName: '段manager', approvers: 'テスト花子', routeId: 'two' } }], proxy: false });
    expect(actorStepBlockers(flow, token('stranger'), claim, policy, organization)).toEqual({ blockers: [{ code: 'approval-actor-unlinked', params: { subject: 'stranger', stepName: '段manager' } }], proxy: false });
    expect(actorStepBlockers(approvedFirst, token('x', 'saburo'), claim, { approval: approval({ routes: settings.routes }) }, organization)).toEqual({ blockers: [], proxy: false });
  });

  it('異常: 申請者本人は承認できない（規程で禁止しているとき）', () => {
    const decision = actorStepBlockers(flow, token('taro@example.com', 'taro'), claim, policy, organization);
    expect(decision.blockers.map((entry) => entry.code)).toEqual(['approval-claimant-self', 'approval-not-current-approver']);
    expect(actorStepBlockers(flow, token('taro@example.com', 'taro'), claim, { approval: { ...settings, forbidClaimantApproval: false } }, organization).blockers.map((entry) => entry.code)).toEqual(['approval-not-current-approver']);
  });

  it('異常: 前の段を承認した人（従業員か subject が同じ）は次の段を押せない。規程で許せば押せ、単一ユーザーには効かない', () => {
    expect(actorStepBlockers(approvedFirst, token('hanako@example.com', 'hanako'), claim, policy, organization).blockers.map((entry) => entry.code)).toEqual(['approval-same-approver', 'approval-not-current-approver']);
    expect(actorStepBlockers(approvedFirst, token('hanako@example.com', 'hanako'), claim, policy, organization).blockers[0]).toEqual({ code: 'approval-same-approver', params: { previousStep: '段manager', routeId: 'two' } });
    const bySubject: ApprovalFlow = { ...approvedFirst, steps: [{ ...approvedFirst.steps[0]!, decision: { by: 'saburo@example.com', at: AT, proxy: true, comment: '代理' } }, approvedFirst.steps[1]!] };
    expect(actorStepBlockers(bySubject, token('saburo@example.com', 'saburo'), claim, policy, organization).blockers.map((entry) => entry.code)).toEqual(['approval-same-approver']);
    expect(actorStepBlockers(bySubject, token('saburo@example.com', 'saburo'), claim, { approval: { ...settings, requireDistinctApprovers: false } }, organization)).toEqual({ blockers: [], proxy: false });
    const bySingle: ApprovalFlow = { ...approvedFirst, steps: [{ ...approvedFirst.steps[0]!, decision: { by: 'single-user', at: AT, proxy: true, comment: '代理' } }, approvedFirst.steps[1]!] };
    expect(actorStepBlockers(bySingle, { subject: 'single-user', singleUser: true }, claim, policy, organization, '代理')).toEqual({ blockers: [], proxy: true });
  });

  it('境界: approve 権限を持つ誰でもの段は誰でも代理でなく押せ、全段が済んだ流れには何も返さない', () => {
    const mvpFlow = flowFromPlan(mvpApprovalPlan(), AT, AT);
    expect(actorStepBlockers(mvpFlow, token('anyone'), claim, { approval: approval(undefined) }, organization)).toEqual({ blockers: [], proxy: false });
    expect(actorStepBlockers({ ...approvedFirst, currentIndex: 2 }, token('anyone'), claim, policy, organization)).toEqual({ blockers: [], proxy: false });
  });
});

describe('currentApproverIds', () => {
  const settings = approval({ routes: [route('r', [step('a', { kind: 'claimant-manager' }), step('b', { kind: 'department-head' }, true), step('c', { kind: 'group', groupId: 'accounting' })], {})] });
  const plan = resolveApprovalPlanFor(subject(), settings, organization, employees);

  it('正常: checked は計画の最初の段、in-approval は保存済みの流れの現在の段、それ以外は空', () => {
    expect(currentApproverIds({ status: 'checked' }, plan)).toEqual(['hanako']);
    const flow = flowFromPlan(plan, AT, AT);
    const moved: ApprovalFlow = { ...flow, steps: flow.steps.map((entry, index) => (index === 0 ? { ...entry, status: 'approved', decision: { by: 'h', at: AT, proxy: false } } : entry)), currentIndex: 2 };
    expect(currentApproverIds({ status: 'in-approval', approvalFlow: moved }, undefined)).toEqual(['saburo', 'jiro']);
    expect(currentApproverIds({ status: 'checked' }, undefined)).toEqual([]);
    expect(currentApproverIds({ status: 'draft' }, plan)).toEqual([]);
    expect(currentApproverIds({ status: 'in-approval' }, plan)).toEqual([]);
    expect(currentApproverIds({ status: 'in-approval', approvalFlow: { ...moved, currentIndex: 3 } }, undefined)).toEqual([]);
  });
});
