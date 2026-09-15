/**
 * application層: 承認の流れの表示（`GET /expense/claims/:id/approval-flow`）と、規程タブの経路の試算（docs/21 §20.9.2 / §20.10.1。系統 A）。
 *
 * - 表示: 計画（`checked` は解決の予定、`in-approval` / 承認済みは保存済みの流れ、下書き・差し戻しは「チェックしたらこうなる」の予定）、
 *   現在の段と承認者、見ている人が押せるか（`canAct`）、代理承認になるか（`proxy`。コメント必須）、押せない理由（§20.5.1）。
 *   拒否理由の組み立ては骨格の `DescribeExpenseApprovalUseCase` と同じ（判定の入口を増やさない）。
 * - 試算: 保存していない承認設定でも、部門・費目・金額・申請者から経路と承認者を解決して見せる（保存しない）。
 */
import { currentApprovalStep, flowFromPlan, mvpApprovalPlan, planFromFlow, validateApprovalSettings, type ApprovalFlow, type ApprovalPlan } from '../../../domain/expense/approval';
import type { ExpenseBlockingReason } from '../../../domain/expense/errors';
import { firstPendingPlanStep, type ApprovalRouteSubject } from '../../../domain/expense/people/approval-route';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseActor } from '../actor';
import { requireClaim } from '../manage-claims';
import { loadExpensePolicy } from '../manage-policy';
import { DescribeExpenseApprovalUseCase } from '../review-claims';
import type { ExpenseSystemDeps } from '../system-deps';
import type { PeopleApprovalPlanner } from './approval-planner';

export interface ExpenseApprovalFlowView {
  readonly plan: ApprovalPlan;
  readonly flow?: ApprovalFlow;
  readonly current?: { readonly index: number; readonly stepId: string; readonly stepName: string; readonly approvers: readonly { readonly employeeId: string; readonly name: string }[] };
  /** 見ている人がいま承認を押せるか（代理はコメントを書けば押せるので true）。 */
  readonly canAct: boolean;
  readonly proxy: boolean;
  readonly blockers: readonly ExpenseBlockingReason[];
}

export class DescribeExpenseApprovalFlowUseCase {
  constructor(
    private readonly deps: ExpenseSystemDeps,
    private readonly planner: PeopleApprovalPlanner,
  ) {}

  async execute(scope: TenantScope, claimId: string, actor: ExpenseActor): Promise<ExpenseApprovalFlowView> {
    const claim = await requireClaim(this.deps.repositories.claims, scope, claimId);
    const { policy } = await loadExpensePolicy(this.deps.repositories.policies, scope);
    const acting = claim.status === 'checked' || claim.status === 'in-approval';
    if (!acting) {
      const plan = claim.approvalFlow !== undefined
        ? planFromFlow(claim.approvalFlow)
        : claim.status === 'approved' || claim.status === 'settled' ? mvpApprovalPlan() : await this.planner.plan(scope, claim, policy);
      return { plan, ...(claim.approvalFlow === undefined ? {} : { flow: claim.approvalFlow }), canAct: false, proxy: false, blockers: [] };
    }
    const described = await new DescribeExpenseApprovalUseCase(this.deps.repositories.policies, this.planner, this.deps.now).execute(scope, claim, actor);
    const plan = described.plan ?? mvpApprovalPlan();
    const flow: ApprovalFlow = claim.status === 'in-approval' && claim.approvalFlow !== undefined ? claim.approvalFlow : flowFromPlan(plan, this.deps.now().toISOString(), policy.updatedAt);
    const decision = await this.planner.actorBlockers(scope, { claim, policy, flow, actor, comment: 'preview' });
    const step = currentApprovalStep(flow);
    return {
      plan,
      ...(claim.status === 'in-approval' && claim.approvalFlow !== undefined ? { flow: claim.approvalFlow } : {}),
      ...(step === undefined ? {} : { current: { index: flow.currentIndex, stepId: step.stepId, stepName: step.name, approvers: step.approvers } }),
      canAct: actor.canApprove && described.blockers.length === 0,
      proxy: decision.proxy,
      blockers: described.blockers,
    };
  }
}

export interface ApprovalRoutePreviewInput {
  /** 規程の承認設定（保存していない下書きでよい）。 */
  readonly approval: unknown;
  /** 経路の条件に使える費目 id（規程の下書きの費目）。 */
  readonly policyCategoryIds: readonly string[];
  readonly subject: ApprovalRouteSubject;
}

export interface ApprovalRoutePreview {
  readonly plan: ApprovalPlan;
  /** 最初に承認する段（全段飛ばしなら undefined）。 */
  readonly firstStepId?: string;
}

export class PreviewApprovalRouteUseCase {
  constructor(private readonly planner: PeopleApprovalPlanner) {}

  async execute(scope: TenantScope, input: ApprovalRoutePreviewInput): Promise<ApprovalRoutePreview> {
    const approval = validateApprovalSettings(input.approval, new Set(input.policyCategoryIds));
    const plan = await this.planner.planFor(scope, input.subject, approval);
    const first = firstPendingPlanStep(plan);
    return { plan, ...(first === undefined ? {} : { firstStepId: first.stepId }) };
  }
}
