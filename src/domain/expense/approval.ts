/**
 * ドメイン: 承認経路・承認計画・承認の記録の型（docs/21 §20.2.6。骨格。凍結）。
 *
 * - 規程の `approval`（経路と段の定義）の型と検証はここ。規程は組織のデータを持たないので、段が参照する
 *   従業員・部門・グループの**存在は検証しない**（科目 id と同じ。解決できないことはチェックの `approval-route-unresolved` で見せる）。
 * - 「誰が承認者か」の解決（`selectApprovalRoute` / `resolveApprovalPlan` / `actorStepBlockers`）は A の
 *   `domain/expense/people/approval-route.ts` が持つ。ここは解決結果の**形**（`ApprovalPlan`）と、申請へ写す記録（`ApprovalFlow`）だけ。
 * - 遷移（`claim.ts` の `approveStep`）は解決済みの計画と操作者の拒否理由を引数で受け、人の解決を知らない。
 */
import { assertNonEmpty } from '../shared/assert';
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { ExpenseDomainError } from './errors';

export const APPROVER_KINDS = ['claimant-manager', 'department-head', 'employee', 'group', 'any-approver'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

export type ApproverSpec =
  | { readonly kind: 'claimant-manager' }
  | { readonly kind: 'department-head'; readonly departmentId?: string }
  | { readonly kind: 'employee'; readonly employeeId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'any-approver' };

export interface ApprovalStepDef {
  readonly id: string;
  /** 1〜40 字。 */
  readonly name: string;
  readonly approver: ApproverSpec;
  /** 直前の段と承認者の集合が同じなら飛ばす。 */
  readonly skipWhenSameAsPrevious: boolean;
}

export interface ApprovalRouteCondition {
  /** 申請の明細のどれかの費目が含まれる（空 = 条件なし）。 */
  readonly categoryIds: readonly string[];
  /** 申請合計（`claimTotalAmount`）がこの金額以上。 */
  readonly minClaimAmount?: number;
  /** 申請者の部門（`claimant.departmentId`）が含まれる（空 = 条件なし）。 */
  readonly departmentIds: readonly string[];
}

export interface ApprovalRoute {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** AND。すべて空なら「全申請に当たる」ので、最後の経路にだけ許す。 */
  readonly when: ApprovalRouteCondition;
  readonly steps: readonly ApprovalStepDef[];
}

export interface ApprovalSettings {
  readonly routes: readonly ApprovalRoute[];
  /** どの経路にも当たらないとき（1〜5 段）。 */
  readonly defaultSteps: readonly ApprovalStepDef[];
  /** 操作者の従業員 = 申請者の従業員なら承認不可（紐付かない単一ユーザーには効かない）。 */
  readonly forbidClaimantApproval: boolean;
  /** 前の段で承認した人は後の段を承認できない。 */
  readonly requireDistinctApprovers: boolean;
  /** トークン認証で代理承認できる承認グループ（単一ユーザーモードは常に代理可）。 */
  readonly proxyGroupId?: string;
}

export const APPROVAL_MAX_ROUTES = 50;
export const APPROVAL_MAX_STEPS = 5;
export const APPROVAL_STEP_NAME_MAX = 40;
export const APPROVAL_ROUTE_NAME_MAX = 100;
export const APPROVAL_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
const AMOUNT_MAX = 100_000_000;

/** 経路を設定しない会社の既定: 1 段の「approve 権限を持つ誰でも」（MVP と同じ承認）。 */
export const DEFAULT_APPROVAL_STEPS: readonly ApprovalStepDef[] = [
  { id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false },
];

export function defaultApprovalSettings(): ApprovalSettings {
  return { routes: [], defaultSteps: DEFAULT_APPROVAL_STEPS.map((step) => ({ ...step, approver: { ...step.approver } })), forbidClaimantApproval: true, requireDistinctApprovers: false };
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !APPROVAL_ID_PATTERN.test(value)) throw fail(`${label} must match ${APPROVAL_ID_PATTERN.source}`);
  return value;
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.trim().length > max) throw fail(`${label} must be 1 to ${max} characters`);
  return value.trim();
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw fail(`${label} must be a boolean`);
  return value;
}

function stringList(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) throw fail(`${label} must be an array of non-empty strings`);
  return [...new Set((value as string[]).map((entry) => entry.trim()))];
}

export function validateApproverSpec(value: unknown, label: string): ApproverSpec {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  switch (raw['kind']) {
    case 'claimant-manager': return { kind: 'claimant-manager' };
    case 'any-approver': return { kind: 'any-approver' };
    case 'department-head': {
      const departmentId = raw['departmentId'];
      if (departmentId === undefined || departmentId === null || departmentId === '') return { kind: 'department-head' };
      return { kind: 'department-head', departmentId: requireText(departmentId, `${label}.departmentId`, 64) };
    }
    case 'employee': return { kind: 'employee', employeeId: requireText(raw['employeeId'], `${label}.employeeId`, 64) };
    case 'group': return { kind: 'group', groupId: requireText(raw['groupId'], `${label}.groupId`, 64) };
    default: throw fail(`${label}.kind must be one of ${APPROVER_KINDS.join(', ')}`);
  }
}

function validateSteps(value: unknown, label: string): readonly ApprovalStepDef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > APPROVAL_MAX_STEPS) throw fail(`${label} must have 1 to ${APPROVAL_MAX_STEPS} steps`);
  const steps = value.map((entry: unknown, index) => {
    const stepLabel = `${label}[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${stepLabel} must be an object`);
    const raw = entry as Record<string, unknown>;
    return {
      id: requireId(raw['id'], `${stepLabel}.id`),
      name: requireText(raw['name'], `${stepLabel}.name`, APPROVAL_STEP_NAME_MAX),
      approver: validateApproverSpec(raw['approver'], `${stepLabel}.approver`),
      skipWhenSameAsPrevious: raw['skipWhenSameAsPrevious'] === undefined ? false : requireBoolean(raw['skipWhenSameAsPrevious'], `${stepLabel}.skipWhenSameAsPrevious`),
    };
  });
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) throw fail(`${label}: duplicate step id: ${step.id}`);
    ids.add(step.id);
  }
  return steps;
}

/**
 * 規程の `approval` を検証する（省略・null は既定値）。`categoryIds` は規程にある費目の id（経路の条件はそれだけを参照できる）。
 */
export function validateApprovalSettings(value: unknown, categoryIds: ReadonlySet<string>, label = 'expense policy: approval'): ApprovalSettings {
  if (value === undefined || value === null) return defaultApprovalSettings();
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const defaults = defaultApprovalSettings();
  const rawRoutes = raw['routes'] ?? [];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > APPROVAL_MAX_ROUTES) throw fail(`${label}.routes must be an array of at most ${APPROVAL_MAX_ROUTES} routes`);
  const routes = rawRoutes.map((entry: unknown, index) => {
    const routeLabel = `${label}.routes[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${routeLabel} must be an object`);
    const route = entry as Record<string, unknown>;
    const when = (route['when'] ?? {}) as Record<string, unknown>;
    if (when === null || typeof when !== 'object' || Array.isArray(when)) throw fail(`${routeLabel}.when must be an object`);
    const minClaimAmount = when['minClaimAmount'];
    if (minClaimAmount !== undefined && minClaimAmount !== null && (typeof minClaimAmount !== 'number' || !Number.isInteger(minClaimAmount) || minClaimAmount < 1 || minClaimAmount > AMOUNT_MAX)) {
      throw fail(`${routeLabel}.when.minClaimAmount must be an integer between 1 and ${AMOUNT_MAX}`);
    }
    const condition: ApprovalRouteCondition = withDefined({
      categoryIds: stringList(when['categoryIds'], `${routeLabel}.when.categoryIds`),
      minClaimAmount: minClaimAmount === null ? undefined : minClaimAmount as number | undefined,
      departmentIds: stringList(when['departmentIds'], `${routeLabel}.when.departmentIds`),
    });
    const unknown = condition.categoryIds.filter((id) => !categoryIds.has(id));
    if (unknown.length > 0) throw fail(`${routeLabel}.when.categoryIds refers to categories that are not in the policy: ${unknown.join(', ')}`);
    return {
      id: requireId(route['id'], `${routeLabel}.id`),
      name: requireText(route['name'], `${routeLabel}.name`, APPROVAL_ROUTE_NAME_MAX),
      enabled: requireBoolean(route['enabled'], `${routeLabel}.enabled`),
      when: condition,
      steps: validateSteps(route['steps'], `${routeLabel}.steps`),
    };
  });
  const routeIds = new Set<string>();
  routes.forEach((route, index) => {
    if (routeIds.has(route.id)) throw fail(`${label}: duplicate route id: ${route.id}`);
    routeIds.add(route.id);
    const matchesEverything = route.when.categoryIds.length === 0 && route.when.minClaimAmount === undefined && route.when.departmentIds.length === 0;
    // 条件なしの経路を途中に置くと、後ろの経路が永久に当たらない（設定の誤りとして断る）。
    if (matchesEverything && index !== routes.length - 1) throw fail(`${label}.routes[${index}] (${route.name}) matches every claim, so it must be the last route`);
  });
  const proxy = raw['proxyGroupId'];
  return withDefined({
    routes,
    defaultSteps: raw['defaultSteps'] === undefined || raw['defaultSteps'] === null ? defaults.defaultSteps : validateSteps(raw['defaultSteps'], `${label}.defaultSteps`),
    forbidClaimantApproval: raw['forbidClaimantApproval'] === undefined ? defaults.forbidClaimantApproval : requireBoolean(raw['forbidClaimantApproval'], `${label}.forbidClaimantApproval`),
    requireDistinctApprovers: raw['requireDistinctApprovers'] === undefined ? defaults.requireDistinctApprovers : requireBoolean(raw['requireDistinctApprovers'], `${label}.requireDistinctApprovers`),
    proxyGroupId: proxy === undefined || proxy === null || proxy === '' ? undefined : requireText(proxy, `${label}.proxyGroupId`, 64),
  });
}

/* ---------------------------------------------------------------------------
 * 承認計画（解決の結果。A の resolveApprovalPlan が作る）
 * ------------------------------------------------------------------------- */

export const APPROVAL_UNRESOLVED_CAUSES = ['claimant-unlinked', 'manager-missing', 'manager-disabled', 'department-head-missing', 'group-empty', 'employee-disabled', 'only-claimant'] as const;
export type ApprovalUnresolvedCause = (typeof APPROVAL_UNRESOLVED_CAUSES)[number];

export interface ApprovalApproverRef {
  readonly employeeId: string;
  readonly name: string;
}

export interface ApprovalPlanStep {
  readonly stepId: string;
  readonly name: string;
  readonly approverKind: ApproverKind;
  /** any-approver は空。 */
  readonly approvers: readonly ApprovalApproverRef[];
  /** `skipWhenSameAsPrevious` で飛ばす段。 */
  readonly skipped: boolean;
}

/** 承認者が決まらない段 1 件。`params` は `approval-route-unresolved` の文言の差し込み値（claimant / manager / department / group / employee）。 */
export interface ApprovalUnresolved {
  readonly stepId: string;
  readonly stepName: string;
  readonly cause: ApprovalUnresolvedCause;
  readonly params: Readonly<Record<string, string | null>>;
}

export interface ApprovalPlan {
  /** `defaultSteps` なら undefined。 */
  readonly routeId?: string;
  readonly routeName: string;
  readonly steps: readonly ApprovalPlanStep[];
  readonly unresolved: readonly ApprovalUnresolved[];
}

/** 経路の名前（defaultSteps のとき）。 */
export const DEFAULT_APPROVAL_ROUTE_NAME = '既定の承認';

/**
 * MVP と同じ計画（1 段・approve 権限を持つ誰でも）。A のプランナーのスタブと、経路を設定しない会社の既定がこれを返す。
 */
export function mvpApprovalPlan(): ApprovalPlan {
  return { routeName: DEFAULT_APPROVAL_ROUTE_NAME, steps: [{ stepId: 'approve', name: '承認', approverKind: 'any-approver', approvers: [], skipped: false }], unresolved: [] };
}

/** MVP と同じ計画か（このときは承認の記録を MVP と同じ `approval` だけにし、`approvalFlow` を書かない）。 */
export function isMvpApprovalPlan(plan: ApprovalPlan): boolean {
  return plan.routeId === undefined && plan.steps.length === 1 && plan.steps[0]?.approverKind === 'any-approver' && plan.steps[0]?.skipped === false;
}

/* ---------------------------------------------------------------------------
 * 承認の記録（申請へ写す。1 段目の承認で保存し、承認取消・差し戻し・再チェックで消える）
 * ------------------------------------------------------------------------- */

export const APPROVAL_STEP_STATUSES = ['pending', 'approved', 'skipped'] as const;
export type ApprovalStepStatus = (typeof APPROVAL_STEP_STATUSES)[number];

export interface ApprovalDecision {
  readonly by: string;
  readonly employeeId?: string;
  readonly displayName?: string;
  readonly at: IsoDateTime;
  readonly comment?: string;
  /** 代理承認（単一ユーザーモード・代理承認グループ）。 */
  readonly proxy: boolean;
}

export interface ApprovalFlowStep {
  readonly stepId: string;
  readonly name: string;
  readonly approverKind: ApproverKind;
  readonly approvers: readonly ApprovalApproverRef[];
  readonly status: ApprovalStepStatus;
  readonly decision?: ApprovalDecision;
}

export interface ApprovalFlow {
  readonly routeId?: string;
  readonly routeName: string;
  readonly resolvedAt: IsoDateTime;
  readonly policyUpdatedAt: IsoDateTime;
  readonly steps: readonly ApprovalFlowStep[];
  /** 次に承認する段（全段済みなら steps.length）。 */
  readonly currentIndex: number;
}

export const APPROVAL_COMMENT_MAX = 500;

function validateApprovers(value: unknown, label: string): readonly ApprovalApproverRef[] {
  if (!Array.isArray(value) || value.length > 100) throw fail(`${label} must be an array of at most 100 approvers`);
  return value.map((entry: unknown, index) => {
    const raw = entry as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object' || typeof raw['employeeId'] !== 'string' || typeof raw['name'] !== 'string') throw fail(`${label}[${index}] must be { employeeId, name }`);
    return { employeeId: raw['employeeId'], name: raw['name'] };
  });
}

export function validateApprovalDecision(value: unknown, label: string): ApprovalDecision {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  assertNonEmpty(raw['by'], `${label}.by`, fail);
  assertIsoDateTime(raw['at'], `${label}.at`, fail);
  const optional = (key: string, max: number): string | undefined => {
    const entry = raw[key];
    if (entry === undefined || entry === null || entry === '') return undefined;
    if (typeof entry !== 'string' || entry.length > max) throw fail(`${label}.${key} must be a string of at most ${max} characters`);
    return entry;
  };
  return withDefined({
    by: raw['by'] as string,
    employeeId: optional('employeeId', 64),
    displayName: optional('displayName', 256),
    at: raw['at'] as string,
    comment: optional('comment', APPROVAL_COMMENT_MAX),
    proxy: requireBoolean(raw['proxy'], `${label}.proxy`),
  });
}

/** 保存済みの承認の記録の形と整合（段の順・現在の段）を検証する。 */
export function validateApprovalFlow(value: unknown, label = 'expense claim: approvalFlow'): ApprovalFlow {
  if (value === null || typeof value !== 'object') throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  assertIsoDateTime(raw['resolvedAt'], `${label}.resolvedAt`, fail);
  assertIsoDateTime(raw['policyUpdatedAt'], `${label}.policyUpdatedAt`, fail);
  if (!Array.isArray(raw['steps']) || raw['steps'].length < 1 || raw['steps'].length > APPROVAL_MAX_STEPS) throw fail(`${label}.steps must have 1 to ${APPROVAL_MAX_STEPS} steps`);
  const steps = raw['steps'].map((entry: unknown, index) => {
    const stepLabel = `${label}.steps[${index}]`;
    if (entry === null || typeof entry !== 'object') throw fail(`${stepLabel} must be an object`);
    const step = entry as Record<string, unknown>;
    if (!(APPROVER_KINDS as readonly unknown[]).includes(step['approverKind'])) throw fail(`${stepLabel}.approverKind must be one of ${APPROVER_KINDS.join(', ')}`);
    if (!(APPROVAL_STEP_STATUSES as readonly unknown[]).includes(step['status'])) throw fail(`${stepLabel}.status must be one of ${APPROVAL_STEP_STATUSES.join(', ')}`);
    const decision = step['decision'] === undefined ? undefined : validateApprovalDecision(step['decision'], `${stepLabel}.decision`);
    if (step['status'] === 'approved' && decision === undefined) throw fail(`${stepLabel}: an approved step must have a decision`);
    if (step['status'] !== 'approved' && decision !== undefined) throw fail(`${stepLabel}: only an approved step can have a decision`);
    return withDefined({
      stepId: requireId(step['stepId'], `${stepLabel}.stepId`),
      name: requireText(step['name'], `${stepLabel}.name`, APPROVAL_STEP_NAME_MAX),
      approverKind: step['approverKind'] as ApproverKind,
      approvers: validateApprovers(step['approvers'], `${stepLabel}.approvers`),
      status: step['status'] as ApprovalStepStatus,
      decision,
    });
  });
  const currentIndex = raw['currentIndex'];
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex) || currentIndex < 0 || currentIndex > steps.length) throw fail(`${label}.currentIndex must be an integer between 0 and ${steps.length}`);
  // 現在の段より前はすべて済み（承認か飛ばし）、現在の段とその後ろは承認されていない（段は順に進む）。
  steps.forEach((step, index) => {
    if (index < currentIndex && step.status === 'pending') throw fail(`${label}.steps[${index}] is before the current step but still pending`);
    if (index >= currentIndex && step.status === 'approved') throw fail(`${label}.steps[${index}] is approved but not before the current step`);
  });
  if (currentIndex < steps.length && steps[currentIndex]?.status !== 'pending') throw fail(`${label}: the current step must be pending`);
  const routeId = raw['routeId'];
  return withDefined({
    routeId: routeId === undefined || routeId === null ? undefined : requireId(routeId, `${label}.routeId`),
    routeName: requireText(raw['routeName'], `${label}.routeName`, APPROVAL_ROUTE_NAME_MAX),
    resolvedAt: raw['resolvedAt'] as string,
    policyUpdatedAt: raw['policyUpdatedAt'] as string,
    steps,
    currentIndex,
  });
}

/** 現在の段（全段済みなら undefined）。 */
export function currentApprovalStep(flow: Pick<ApprovalFlow, 'steps' | 'currentIndex'>): ApprovalFlowStep | undefined {
  return flow.steps[flow.currentIndex];
}

/** 計画から、まだ誰も承認していない記録を作る（飛ばす段は `skipped`、現在の段は最初の pending）。 */
export function flowFromPlan(plan: ApprovalPlan, resolvedAt: string, policyUpdatedAt: string): ApprovalFlow {
  const steps: ApprovalFlowStep[] = plan.steps.map((step) => ({ stepId: step.stepId, name: step.name, approverKind: step.approverKind, approvers: step.approvers.map((entry) => ({ ...entry })), status: step.skipped ? 'skipped' : 'pending' }));
  const first = steps.findIndex((step) => step.status === 'pending');
  return withDefined({ routeId: plan.routeId, routeName: plan.routeName, resolvedAt, policyUpdatedAt, steps, currentIndex: first < 0 ? steps.length : first });
}

/** 保存済みの流れを計画の形にする（承認中・承認済みの申請の応答で、画面が計画と同じ表で見せるため）。 */
export function planFromFlow(flow: ApprovalFlow): ApprovalPlan {
  return withDefined({
    routeId: flow.routeId,
    routeName: flow.routeName,
    steps: flow.steps.map((step) => ({ stepId: step.stepId, name: step.name, approverKind: step.approverKind, approvers: step.approvers.map((entry) => ({ ...entry })), skipped: step.status === 'skipped' })),
    unresolved: [],
  });
}

/* ---------------------------------------------------------------------------
 * 承認の拒否理由の擬似コード（§20.5.1。理由コードではない）
 * ------------------------------------------------------------------------- */

export const APPROVAL_BLOCKER_CODES = [
  'approval-route-unresolved', 'approval-not-current-approver', 'approval-actor-unlinked', 'approval-claimant-self',
  'approval-same-approver', 'approval-step-changed', 'approval-proxy-comment-missing',
] as const;
export type ApprovalBlockerCode = (typeof APPROVAL_BLOCKER_CODES)[number];
