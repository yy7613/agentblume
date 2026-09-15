/**
 * application層: 段階 2（人の確認）と承認（docs/21 §7 / §20.2.12 / ADR-0040 §2 / ADR-0043 §4〜5）。
 *
 * 要確認の理由を確認済みにする・差し戻す・承認する・承認を取り消す。**LLM は関与しない**
 * （経費の確認は個々の支出を認めるかの判断で、資産にならず、責任の所在を曖昧にするだけなので）。
 * 拒否条件は domain の遷移関数が持つ。ここは読み込み・承認経路の解決（A のプランナー）・保存だけ。
 *
 * 承認経路のプランナーを渡さない構成（テスト・既存の配線）は MVP と同じ 1 段の承認になる。
 */
import { flowFromPlan, mvpApprovalPlan, planFromFlow, type ApprovalFlow, type ApprovalPlan } from '../../domain/expense/approval';
import { acknowledge, approvalBlockers, approveStep, returnClaim, unapproveClaim, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseTransitionError, type ExpenseBlockingReason } from '../../domain/expense/errors';
import type { ExpenseAdvanceRepository, ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { isSingleUserSubject, type ExpenseActor } from './actor';
import { requireClaim, saveClaim } from './manage-claims';
import { loadExpensePolicy } from './manage-policy';
import type { ApprovalRoutePlanner } from './ports';
import { buildReturnMessage } from './reason-messages';

/** プランナーを配線しない構成の承認経路（MVP と同じ 1 段。操作者を妨げない）。 */
export const MVP_APPROVAL_PLANNER: ApprovalRoutePlanner = {
  plan: async () => mvpApprovalPlan(),
  actorBlockers: async () => ({ blockers: [], proxy: false }),
  currentApprovers: async () => [],
};

/** 操作者が渡されないとき（ツール・既存の呼び出し）の操作者。approve 権限の検査は api の認可が済ませている。 */
function fallbackActor(by: string, displayName?: string): ExpenseActor {
  return { subject: by, ...(displayName === undefined ? {} : { displayName }), roles: [], singleUser: isSingleUserSubject(by), canApprove: true };
}

export class AcknowledgeExpenseReasonUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly itemId?: string; readonly code: string; readonly note: string; readonly by: string }): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const updated = acknowledge(claim, { ...(input.itemId === undefined ? {} : { itemId: input.itemId }), code: input.code, note: input.note }, input.by, this.now().toISOString());
    await saveClaim(this.claims, this.receipts, updated);
    return updated;
  }
}

/** 差し戻し文言の下書き（保存しない）。 */
export class GetReturnDraftUseCase {
  constructor(private readonly claims: ExpenseClaimRepository) {}

  async execute(scope: TenantScope, claimId: string): Promise<string> {
    const claim = await requireClaim(this.claims, scope, claimId);
    if (claim.status !== 'checked' && claim.status !== 'in-approval') {
      throw new ExpenseTransitionError(`return draft: only a checked claim can be returned (status: ${claim.status})`, { nextStep: 'チェック済みの申請だけを差し戻せます。先にチェックしてください' });
    }
    return buildReturnMessage(claim);
  }
}

export class ReturnExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly message: string; readonly by: string }): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const updated = returnClaim(claim, input.message, input.by, this.now().toISOString());
    await saveClaim(this.claims, this.receipts, updated);
    return updated;
  }
}

export interface ApproveExpenseClaimInput {
  readonly scope: TenantScope;
  readonly claimId: string;
  readonly by: string;
  readonly displayName?: string;
  readonly comment?: string;
  /** 画面が見ていた段（承認中に別の人が先に進めたら 409 `approval-step-changed`）。 */
  readonly stepId?: string;
  /** 操作者（api が Principal と従業員マスタから作る）。省略時は `by` だけの操作者。 */
  readonly actor?: ExpenseActor;
}

export class ApproveExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly planner: ApprovalRoutePlanner = MVP_APPROVAL_PLANNER,
  ) {}

  async execute(input: ApproveExpenseClaimInput): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const at = this.now().toISOString();
    const actor = input.actor ?? fallbackActor(input.by, input.displayName);
    // 承認者は checked の時点では毎回解決し直し（マスタを直せば拒否が消える）、in-approval では申請へ写した承認者に固定する。
    const plan: ApprovalPlan = claim.status === 'checked' ? await this.planner.plan(input.scope, claim, policy) : mvpApprovalPlan();
    const flow: ApprovalFlow | undefined = claim.status === 'checked' ? flowFromPlan(plan, at, policy.updatedAt) : claim.approvalFlow;
    const decision = flow === undefined
      ? { blockers: [], proxy: false }
      : await this.planner.actorBlockers(input.scope, { claim, policy, flow, actor, ...(input.comment === undefined ? {} : { comment: input.comment }) });
    const updated = approveStep(claim, policy, plan, decision.blockers, input.by, at, {
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      ...(input.comment === undefined ? {} : { comment: input.comment }),
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      ...(actor.employeeId === undefined ? {} : { employeeId: actor.employeeId }),
      proxy: decision.proxy,
    });
    const approvers = await this.planner.currentApprovers(input.scope, updated, policy);
    await saveClaim(this.claims, this.receipts, updated, approvers);
    return updated;
  }
}

export class UnapproveExpenseClaimUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly now: () => Date = () => new Date(),
    /** 仮払で精算済みの申請の承認取消を断るため（省略 = 仮払を見ない）。 */
    private readonly advances?: ExpenseAdvanceRepository,
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly note: string; readonly by: string }): Promise<ExpenseClaim> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    const advance = claim.advanceId === undefined || this.advances === undefined ? null : await this.advances.findById(input.scope, claim.advanceId);
    const updated = unapproveClaim(claim, input.by, this.now().toISOString(), input.note, { advanceSettled: advance?.status === 'settled' });
    await saveClaim(this.claims, this.receipts, updated);
    return updated;
  }
}

export interface ExpenseApprovalDescription {
  /** `checked` なら解決の予定、`in-approval` / `approved` なら保存済みの流れ（MVP の 1 段で承認した申請は undefined）。 */
  readonly plan?: ApprovalPlan;
  /** 見ている人が承認するとしたら妨げになる理由（`checked` / `in-approval` 以外は空）。 */
  readonly blockers: readonly ExpenseBlockingReason[];
}

/** 申請の応答に添える承認の見通し（§20.9.1 の `approvalPlan` / `approvalBlockers`）。保存しない。 */
export class DescribeExpenseApprovalUseCase {
  constructor(
    private readonly policies: ExpensePolicyRepository,
    private readonly planner: ApprovalRoutePlanner = MVP_APPROVAL_PLANNER,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, claim: ExpenseClaim, actor?: ExpenseActor): Promise<ExpenseApprovalDescription> {
    if (claim.status !== 'checked' && claim.status !== 'in-approval') {
      return claim.approvalFlow === undefined ? { blockers: [] } : { plan: planFromFlow(claim.approvalFlow), blockers: [] };
    }
    const { policy } = await loadExpensePolicy(this.policies, scope);
    const blockers: ExpenseBlockingReason[] = [...approvalBlockers(claim, policy, actor?.subject)];
    let plan: ApprovalPlan;
    let flow: ApprovalFlow;
    if (claim.status === 'checked') {
      plan = await this.planner.plan(scope, claim, policy);
      for (const unresolved of plan.unresolved) {
        blockers.push({ code: 'approval-route-unresolved', params: { routeName: plan.routeName, stepId: unresolved.stepId, stepName: unresolved.stepName, cause: unresolved.cause, ...unresolved.params } });
      }
      flow = flowFromPlan(plan, this.now().toISOString(), policy.updatedAt);
    } else {
      flow = claim.approvalFlow as ApprovalFlow;
      plan = planFromFlow(flow);
    }
    if (actor !== undefined) {
      const decision = await this.planner.actorBlockers(scope, { claim, policy, flow, actor });
      // 代理でコメントが無い、は押す前には妨げにしない（コメント欄に書けば通る。押したときに domain が断る）。
      blockers.push(...decision.blockers.filter((entry) => entry.code !== 'approval-proxy-comment-missing'));
    }
    return { plan, blockers };
  }
}
