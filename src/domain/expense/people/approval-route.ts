/**
 * ドメイン: 承認経路の当て方・承認者の解決・操作者が段を承認できるか（docs/21 §20.2.6 / §20.5.1。系統 A。純関数）。
 *
 * 型（`ApprovalSettings` / `ApprovalPlan` / `ApprovalFlow`）は骨格の `approval.ts`。ここは「誰が承認者か」を決めるだけで、
 * 遷移（`approveStep`）は骨格の `claim.ts` が計画と拒否理由を受けて行う。
 *
 * ## ローカル単独利用で詰まらない規則（§20.1.2）
 * - 経路が無ければ既定の 1 段「approve 権限を持つ誰でも」（`mvpApprovalPlan` と同じ計画）。
 * - 単一ユーザーモードは、指定の承認者でない段を**代理承認**（コメント必須）で押せる。
 * - `forbidClaimantApproval` は「操作者の従業員 = 申請者の従業員」のときだけ効く（紐付かない単一ユーザーは妨げない）。
 * - `requireDistinctApprovers` は単一ユーザーには効かせない（1 人しかいない主体が 2 段目以降を永久に押せなくなるため。
 *   単一ユーザーの承認は必ず代理の印とコメントが残る）。
 */
import {
  currentApprovalStep, DEFAULT_APPROVAL_ROUTE_NAME, type ApprovalApproverRef, type ApprovalFlow, type ApprovalPlan, type ApprovalPlanStep,
  type ApprovalRoute, type ApprovalSettings, type ApprovalStepDef, type ApprovalUnresolved, type ApprovalUnresolvedCause,
} from '../approval';
import { claimTotalAmount, type ExpenseClaim } from '../claim';
import type { ExpenseEmployee } from '../employee';
import type { ExpenseBlockingReason } from '../errors';
import { DEPARTMENT_HEAD_MAX_DEPTH, findApproverGroup, findDepartment, type ExpenseOrganization } from '../organization';
import type { ExpensePolicy } from '../policy';

/** 経路の条件に当てる申請の値（画面の試算は申請を作らずにこれだけを渡す）。 */
export interface ApprovalRouteSubject {
  /** 明細の費目 id（重複可）。 */
  readonly categoryIds: readonly string[];
  /** 申請合計（`claimTotalAmount`）。 */
  readonly totalAmount: number;
  /** 申請者の部門 id（申請の写し `claimant.departmentId`）。 */
  readonly departmentId?: string;
  /** 申請者の従業員 id。 */
  readonly claimantEmployeeId?: string;
}

/** 解決に使う従業員の形（リポジトリの全項目は要らない）。 */
export type ApprovalEmployee = Pick<ExpenseEmployee, 'id' | 'name' | 'enabled' | 'managerEmployeeId' | 'departmentId'>;

export type ApprovalOrganization = Pick<ExpenseOrganization, 'departments' | 'approverGroups'>;

export function approvalSubjectOf(claim: Pick<ExpenseClaim, 'items' | 'claimant'>): ApprovalRouteSubject {
  return {
    categoryIds: claim.items.flatMap((item) => (item.categoryId === undefined ? [] : [item.categoryId])),
    totalAmount: claimTotalAmount(claim),
    ...(claim.claimant.departmentId === undefined ? {} : { departmentId: claim.claimant.departmentId }),
    ...(claim.claimant.employeeId === undefined ? {} : { claimantEmployeeId: claim.claimant.employeeId }),
  };
}

/** 経路の条件（AND。空の配列・省略は条件なし）を満たすか。 */
export function routeMatches(route: Pick<ApprovalRoute, 'when'>, subject: ApprovalRouteSubject): boolean {
  const { categoryIds, minClaimAmount, departmentIds } = route.when;
  if (categoryIds.length > 0 && !subject.categoryIds.some((id) => categoryIds.includes(id))) return false;
  if (minClaimAmount !== undefined && subject.totalAmount < minClaimAmount) return false;
  if (departmentIds.length > 0 && (subject.departmentId === undefined || !departmentIds.includes(subject.departmentId))) return false;
  return true;
}

export interface SelectedApprovalRoute {
  /** 当たった経路（`defaultSteps` なら undefined）。 */
  readonly route?: ApprovalRoute;
  readonly routeName: string;
  readonly steps: readonly ApprovalStepDef[];
}

/** 有効な経路を上から見て最初に当たったもの。無ければ `defaultSteps`。 */
export function selectApprovalRoute(subject: ApprovalRouteSubject, approval: ApprovalSettings): SelectedApprovalRoute {
  const route = approval.routes.find((candidate) => candidate.enabled && routeMatches(candidate, subject));
  return route === undefined ? { routeName: DEFAULT_APPROVAL_ROUTE_NAME, steps: approval.defaultSteps } : { route, routeName: route.name, steps: route.steps };
}

interface StepResolution {
  readonly approvers: readonly ApprovalApproverRef[];
  readonly unresolved?: { readonly cause: ApprovalUnresolvedCause; readonly params: Readonly<Record<string, string | null>> };
}

function refOf(employee: ApprovalEmployee): ApprovalApproverRef {
  return { employeeId: employee.id, name: employee.name };
}

/** 部門長（部門長が空・無効・見つからなければ親へ。最大 10 段）。 */
function enabledDepartmentHead(organization: ApprovalOrganization, departmentId: string, byId: ReadonlyMap<string, ApprovalEmployee>): ApprovalEmployee | undefined {
  let current = findDepartment(organization, departmentId);
  for (let depth = 0; current !== undefined && depth <= DEPARTMENT_HEAD_MAX_DEPTH; depth += 1) {
    const head = current.headEmployeeId === undefined ? undefined : byId.get(current.headEmployeeId);
    if (head?.enabled === true) return head;
    current = findDepartment(organization, current.parentId);
  }
  return undefined;
}

function resolveStep(step: ApprovalStepDef, subject: ApprovalRouteSubject, organization: ApprovalOrganization, byId: ReadonlyMap<string, ApprovalEmployee>): StepResolution {
  const claimant = subject.claimantEmployeeId === undefined ? undefined : byId.get(subject.claimantEmployeeId);
  const claimantName = claimant?.name ?? null;
  switch (step.approver.kind) {
    case 'any-approver':
      return { approvers: [] };
    case 'claimant-manager': {
      if (claimant === undefined) return { approvers: [], unresolved: { cause: 'claimant-unlinked', params: { employeeId: subject.claimantEmployeeId ?? null } } };
      if (claimant.managerEmployeeId === undefined) return { approvers: [], unresolved: { cause: 'manager-missing', params: { claimant: claimantName, employeeId: claimant.id } } };
      const manager = byId.get(claimant.managerEmployeeId);
      if (manager === undefined || !manager.enabled) {
        return { approvers: [], unresolved: { cause: 'manager-disabled', params: { claimant: claimantName, manager: manager?.name ?? claimant.managerEmployeeId, employeeId: claimant.id } } };
      }
      return { approvers: [refOf(manager)] };
    }
    case 'department-head': {
      const departmentId = step.approver.departmentId ?? subject.departmentId ?? claimant?.departmentId;
      if (departmentId === undefined) {
        // 申請者の部門から辿る段で、申請者も部門も分からない。
        if (claimant === undefined) return { approvers: [], unresolved: { cause: 'claimant-unlinked', params: { employeeId: subject.claimantEmployeeId ?? null } } };
        return { approvers: [], unresolved: { cause: 'department-head-missing', params: { department: null, departmentId: null, employeeId: claimant.id } } };
      }
      const head = enabledDepartmentHead(organization, departmentId, byId);
      if (head === undefined) {
        return { approvers: [], unresolved: { cause: 'department-head-missing', params: { department: findDepartment(organization, departmentId)?.name ?? departmentId, departmentId } } };
      }
      return { approvers: [refOf(head)] };
    }
    case 'employee': {
      const employee = byId.get(step.approver.employeeId);
      if (employee === undefined || !employee.enabled) {
        return { approvers: [], unresolved: { cause: 'employee-disabled', params: { employee: employee?.name ?? step.approver.employeeId, employeeId: step.approver.employeeId } } };
      }
      return { approvers: [refOf(employee)] };
    }
    case 'group': {
      const group = findApproverGroup(organization, step.approver.groupId);
      const members = group === undefined || !group.enabled
        ? []
        : group.memberEmployeeIds.map((id) => byId.get(id)).filter((member): member is ApprovalEmployee => member?.enabled === true);
      if (members.length === 0) return { approvers: [], unresolved: { cause: 'group-empty', params: { group: group?.name ?? step.approver.groupId, groupId: step.approver.groupId } } };
      return { approvers: members.map(refOf) };
    }
  }
}

/**
 * 解決に要る従業員 id（申請者を読んだ後に、上長・指定の承認者・グループのメンバー・部門長をまとめて引くため）。
 * 申請者の従業員（`claimant`）が分かっていればその上長と部門も辿る。
 */
export function approvalEmployeeIdsToLoad(subject: ApprovalRouteSubject, approval: ApprovalSettings, organization: ApprovalOrganization, claimant?: ApprovalEmployee): readonly string[] {
  const ids = new Set<string>();
  if (subject.claimantEmployeeId !== undefined) ids.add(subject.claimantEmployeeId);
  if (claimant?.managerEmployeeId !== undefined) ids.add(claimant.managerEmployeeId);
  const departmentHeads = (departmentId: string | undefined): void => {
    let current = findDepartment(organization, departmentId);
    for (let depth = 0; current !== undefined && depth <= DEPARTMENT_HEAD_MAX_DEPTH; depth += 1) {
      if (current.headEmployeeId !== undefined) ids.add(current.headEmployeeId);
      current = findDepartment(organization, current.parentId);
    }
  };
  for (const step of selectApprovalRoute(subject, approval).steps) {
    switch (step.approver.kind) {
      case 'employee': ids.add(step.approver.employeeId); break;
      case 'group': for (const id of findApproverGroup(organization, step.approver.groupId)?.memberEmployeeIds ?? []) ids.add(id); break;
      case 'department-head': departmentHeads(step.approver.departmentId ?? subject.departmentId ?? claimant?.departmentId); break;
      default: break;
    }
  }
  return [...ids];
}

function sameApprovers(left: readonly ApprovalApproverRef[], right: readonly ApprovalApproverRef[]): boolean {
  const key = (refs: readonly ApprovalApproverRef[]) => JSON.stringify(refs.map((ref) => ref.employeeId).sort());
  return key(left) === key(right);
}

/**
 * 経路の解決（申請の値・規程の承認設定・組織・従業員から）。段ごとに有効な従業員の集合を作り、空なら `unresolved`。
 * `forbidClaimantApproval` なら申請者本人を集合から除き、それで空になれば `only-claimant`。
 * `skipWhenSameAsPrevious` かつ直前の段（解決できた段）と集合が同じなら飛ばす。
 */
export function resolveApprovalPlanFor(subject: ApprovalRouteSubject, approval: ApprovalSettings, organization: ApprovalOrganization, employees: readonly ApprovalEmployee[]): ApprovalPlan {
  const byId = new Map(employees.map((employee) => [employee.id, employee] as const));
  const selected = selectApprovalRoute(subject, approval);
  const steps: ApprovalPlanStep[] = [];
  const unresolved: ApprovalUnresolved[] = [];
  let previous: { readonly kind: string; readonly approvers: readonly ApprovalApproverRef[] } | undefined;
  for (const step of selected.steps) {
    const resolution = resolveStep(step, subject, organization, byId);
    let approvers = resolution.approvers;
    let failure = resolution.unresolved;
    if (failure === undefined && approval.forbidClaimantApproval && subject.claimantEmployeeId !== undefined && approvers.length > 0) {
      approvers = approvers.filter((ref) => ref.employeeId !== subject.claimantEmployeeId);
      if (approvers.length === 0) failure = { cause: 'only-claimant', params: { employeeId: subject.claimantEmployeeId } };
    }
    if (failure !== undefined) unresolved.push({ stepId: step.id, stepName: step.name, cause: failure.cause, params: failure.params });
    const skipped = failure === undefined && step.skipWhenSameAsPrevious && previous !== undefined
      && previous.kind === (step.approver.kind === 'any-approver' ? 'any' : 'named') && sameApprovers(previous.approvers, approvers);
    steps.push({ stepId: step.id, name: step.name, approverKind: step.approver.kind, approvers, skipped });
    previous = failure === undefined ? { kind: step.approver.kind === 'any-approver' ? 'any' : 'named', approvers } : undefined;
  }
  return { ...(selected.route === undefined ? {} : { routeId: selected.route.id }), routeName: selected.routeName, steps, unresolved };
}

/** §20.2.6 の `resolveApprovalPlan(claim, policy, organization, employees)`。 */
export function resolveApprovalPlan(claim: Pick<ExpenseClaim, 'items' | 'claimant'>, policy: Pick<ExpensePolicy, 'approval'>, organization: ApprovalOrganization, employees: readonly ApprovalEmployee[]): ApprovalPlan {
  return resolveApprovalPlanFor(approvalSubjectOf(claim), policy.approval, organization, employees);
}

/** 計画の最初に承認する段（飛ばす段を除く）。全段が飛ばしなら undefined。 */
export function firstPendingPlanStep(plan: Pick<ApprovalPlan, 'steps'>): ApprovalPlanStep | undefined {
  return plan.steps.find((step) => !step.skipped);
}

/** 操作者（application の `ExpenseActor` と同形。domain は application を import しないので形だけを置く）。 */
export interface ApprovalActor {
  readonly subject: string;
  readonly singleUser: boolean;
  readonly employeeId?: string;
}

export interface ActorStepDecision {
  readonly blockers: readonly ExpenseBlockingReason[];
  /** 代理承認として記録するか（コメント必須）。 */
  readonly proxy: boolean;
}

/**
 * 操作者が `flow` の現在の段を承認できるか（§20.5.1）。拒否理由は擬似コードと差し込み値
 * （`stepName` / `approvers`〈「、」連結〉/ `subject` / `previousStep`）で返す。全段が済んでいれば何も返さない。
 */
export function actorStepBlockers(
  flow: ApprovalFlow,
  actor: ApprovalActor,
  claim: Pick<ExpenseClaim, 'claimant'>,
  policy: Pick<ExpensePolicy, 'approval'>,
  organization: Pick<ExpenseOrganization, 'approverGroups'>,
  comment?: string,
): ActorStepDecision {
  const step = currentApprovalStep(flow);
  if (step === undefined) return { blockers: [], proxy: false };
  const approval = policy.approval;
  const blockers: ExpenseBlockingReason[] = [];
  const routeRef: Record<string, string> = flow.routeId === undefined ? {} : { routeId: flow.routeId };

  if (approval.forbidClaimantApproval && actor.employeeId !== undefined && actor.employeeId === claim.claimant.employeeId) {
    blockers.push({ code: 'approval-claimant-self', params: { ...routeRef } });
  }
  if (approval.requireDistinctApprovers && !actor.singleUser) {
    const earlier = flow.steps.slice(0, flow.currentIndex).find((entry) => entry.decision !== undefined
      && (entry.decision.by === actor.subject || (actor.employeeId !== undefined && entry.decision.employeeId === actor.employeeId)));
    if (earlier !== undefined) blockers.push({ code: 'approval-same-approver', params: { previousStep: earlier.name, ...routeRef } });
  }

  let proxy = false;
  if (step.approverKind !== 'any-approver' && !step.approvers.some((ref) => ref.employeeId === actor.employeeId)) {
    const proxyGroup = approval.proxyGroupId === undefined ? undefined : findApproverGroup(organization, approval.proxyGroupId);
    const inProxyGroup = actor.employeeId !== undefined && proxyGroup?.enabled === true && proxyGroup.memberEmployeeIds.includes(actor.employeeId);
    if (actor.singleUser || inProxyGroup) proxy = true;
    else if (actor.employeeId === undefined) blockers.push({ code: 'approval-actor-unlinked', params: { subject: actor.subject, stepName: step.name } });
    else blockers.push({ code: 'approval-not-current-approver', params: { stepName: step.name, approvers: step.approvers.map((ref) => ref.name).join('、'), ...routeRef } });
  }
  if (proxy && (comment === undefined || comment.trim() === '')) blockers.push({ code: 'approval-proxy-comment-missing', params: { stepName: step.name } });
  return { blockers, proxy };
}

/** 現在の段の承認者の従業員 id（`in-approval` は保存済みの流れ、`checked` は計画の最初の段。それ以外は空）。 */
export function currentApproverIds(claim: Pick<ExpenseClaim, 'status' | 'approvalFlow'>, plan: ApprovalPlan | undefined): readonly string[] {
  if (claim.status === 'in-approval' && claim.approvalFlow !== undefined) return (currentApprovalStep(claim.approvalFlow)?.approvers ?? []).map((ref) => ref.employeeId);
  if (claim.status === 'checked' && plan !== undefined) return (firstPendingPlanStep(plan)?.approvers ?? []).map((ref) => ref.employeeId);
  return [];
}
