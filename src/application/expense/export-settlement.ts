/**
 * application層: 精算 CSV の出力と精算済みの印（docs/21 §9）。
 *
 * 出力は**状態を変えない**（仕訳の `markExported` と違い、精算済みの印は別の POST にする。支払いが済んだかは
 * CSV を作った瞬間には分からないため）。精算済みの印は、承認済み以外が混ざれば全体を断る（一部だけ印が付くと
 * 「どれに付いたか」を画面で追うことになる）。
 */
import { businessDateOf, DEFAULT_BUSINESS_TIME_ZONE } from '../../domain/expense/business-date';
import { markSettled, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseTransitionError } from '../../domain/expense/errors';
import type { ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import { buildSettlementCsv, type SettlementCsvResult, type SettlementFormat } from '../../domain/expense/settlement-csv';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { loadExpensePolicy } from './manage-policy';

export interface ExportExpenseSettlementInput {
  readonly scope: TenantScope;
  readonly format: SettlementFormat;
  /** 既定は承認済み。 */
  readonly status?: 'approved' | 'settled';
  /** 申請期間の重なり。 */
  readonly from?: string;
  readonly to?: string;
}

export class ExportExpenseSettlementUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly timeZone: string = DEFAULT_BUSINESS_TIME_ZONE,
  ) {}

  async execute(input: ExportExpenseSettlementInput): Promise<SettlementCsvResult> {
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const summaries = await this.claims.list(input.scope, {
      status: input.status ?? 'approved',
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
    // 一覧は新しい順なので、CSV は古い申請から並べる（振込の突き合わせは時系列の方が追いやすい）。
    const claims = await this.claims.findByIds(input.scope, [...summaries].reverse().map((summary) => summary.id));
    return buildSettlementCsv({ format: input.format, claims, policy, today: businessDateOf(this.now(), this.timeZone), timeZone: this.timeZone });
  }
}

export class SettleExpenseClaimsUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimIds: readonly string[]; readonly exportFileName?: string; readonly by: string }): Promise<readonly ExpenseClaim[]> {
    const ids = [...new Set(input.claimIds)];
    const found = await this.claims.findByIds(input.scope, ids);
    const missing = ids.find((id) => !found.some((claim) => claim.id === id));
    if (missing !== undefined) throw new ExpenseClaimNotFoundError(`expense claim not found: ${missing}`);
    const blocked = found.filter((claim) => claim.status !== 'approved' && claim.status !== 'settled');
    if (blocked.length > 0) {
      throw new ExpenseTransitionError(`settle expense claims: only approved claims can be settled (${blocked.map((claim) => `${claim.id}: ${claim.status}`).join(', ')})`, {
        claims: blocked.map((claim) => ({ id: claim.id, status: claim.status })),
        nextStep: '承認済みでない申請が含まれています。対象から外すか、先に承認してください',
      });
    }
    const at = this.now().toISOString();
    const settled = found.map((claim) => markSettled(claim, input.by, at, input.exportFileName));
    await this.unitOfWork.withTransaction(async () => {
      for (const claim of settled) await this.claims.save(claim, await this.receipts.hashesByClaim(input.scope, claim.id));
    });
    return settled;
  }
}
