/**
 * application層: 仮払の精算（事前計算と精算。docs/21 §20.1.4 / §20.2.7。UC4）。
 *
 * 差額 0 はそのまま精算済み、正は追加支給の待ち（`settling`）、負は返金の待ち（`settling`）。
 * 精算した時点で紐付く申請を精算済み（`exportFileName` = `advance:<id>`）にし、仮払と同じトランザクションで保存する
 * （途中で失敗して「仮払は精算済みなのに申請が承認済みのまま」を残さない）。
 */
import { businessDateOf } from '../../../domain/expense/business-date';
import { markSettled, type ExpenseClaim } from '../../../domain/expense/claim';
import type { ExpenseAdvance } from '../../../domain/expense/advance';
import { previewAdvanceSettlement, type AdvanceClaimRef, type AdvanceSettlementPreview } from '../../../domain/expense/money/advance-settlement';
import { settleAdvance } from '../../../domain/expense/money/advance-transitions';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';
import { linkedClaimSummaries, requireAdvance, summaryReimbursableAmount } from './manage-advances';

export class SettleExpenseAdvanceUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  private async claimRefs(scope: TenantScope, advanceId: string): Promise<readonly AdvanceClaimRef[]> {
    const [claims, { policy }] = await Promise.all([linkedClaimSummaries(this.deps, scope, advanceId), loadExpensePolicy(this.deps.repositories.policies, scope)]);
    return claims.map((claim) => ({
      id: claim.id, status: claim.status, reimbursableAmount: summaryReimbursableAmount(claim, policy), claimantName: claim.claimant.name, journalLinked: claim.journalLinked,
      ...(claim.claimant.employeeId === undefined ? {} : { employeeId: claim.claimant.employeeId }),
    }));
  }

  async preview(scope: TenantScope, advanceId: string): Promise<AdvanceSettlementPreview> {
    const advance = await requireAdvance(this.deps, scope, advanceId);
    return previewAdvanceSettlement(advance, await this.claimRefs(scope, advanceId));
  }

  async settle(scope: TenantScope, advanceId: string, by: string): Promise<{ readonly advance: ExpenseAdvance; readonly claims: readonly ExpenseClaim[] }> {
    const advance = await requireAdvance(this.deps, scope, advanceId);
    const preview = previewAdvanceSettlement(advance, await this.claimRefs(scope, advanceId));
    const now = this.deps.now();
    const at = now.toISOString();
    const settled = settleAdvance(advance, preview, businessDateOf(now, this.deps.timeZone), by, at);
    const { claims: claimRepo, receipts, advances } = this.deps.repositories;
    return this.deps.unitOfWork.withTransaction(async () => {
      const claims = await claimRepo.findByIds(scope, preview.claims.map((claim) => claim.id));
      const updated: ExpenseClaim[] = [];
      for (const claim of claims) {
        const next = markSettled(claim, by, at, `advance:${advance.id}`);
        if (next !== claim) await claimRepo.save(next, await receipts.hashesByClaim(scope, claim.id));
        updated.push(next);
      }
      await advances.save(settled);
      return { advance: settled, claims: updated };
    });
  }
}
