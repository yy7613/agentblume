/**
 * application層: 承認済み申請 → 仕訳下書き（docs/21 §8 / §20.12 / ADR-0040 §5）。
 *
 * 仕訳の保存は `JournalDraftSink` ポート越しに行い、実装は composition が仕訳の `SaveJournalEntryUseCase` を包む
 * （経費の application は仕訳の application を import しない。仕訳側のコード変更は不要）。
 *
 * 1. 作成前に全明細を検査し（`buildJournalDrafts`）、問題があれば 1 件も作らない。部門の補助軸を入れるときは、
 *    仕訳の科目マスタに値があるかも先に照合する（仕訳側が補助軸の値を検証しない可能性に備える。§20.12）。
 * 2. 作成済みでない明細だけを順に作る。途中で仕訳側に拒否されたら、作れた分を `journalLink`（complete: false）として
 *    保存してから理由付きで失敗させる（「続きを作成」で残りだけ作り、二重に作らない）。
 */
import { withJournalLink, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseJournalLinkError, ExpenseTransitionError, type ExpenseJournalLinkProblem } from '../../domain/expense/errors';
import { buildJournalDrafts, departmentDimensionFor, type ExpenseJournalDraft } from '../../domain/expense/journal-draft';
import { findDepartment } from '../../domain/expense/organization';
import { findCategory } from '../../domain/expense/policy';
import type { ExpenseClaimRepository, ExpensePolicyRepository, ExpenseReceiptRepository } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { JournalDraftRejectedError } from './errors';
import { requireClaim, saveClaim } from './manage-claims';
import { loadExpensePolicy } from './manage-policy';
import type { JournalChartReadPort, OrganizationReadPort } from './ports';

export type { ExpenseJournalDraft, ExpenseJournalDraftLine } from '../../domain/expense/journal-draft';
export { JournalDraftRejectedError } from './errors';

export interface JournalDraftSink {
  /** 仕訳の下書きを 1 件作る。科目がマスタに無い / 無効なら `JournalDraftRejectedError` を投げる。 */
  createDraft(scope: TenantScope, draft: ExpenseJournalDraft): Promise<{ readonly entryId: string }>;
}

export interface DraftJournalEntriesResult {
  readonly claim: ExpenseClaim;
  /** この実行で作った仕訳 id。 */
  readonly entryIds: readonly string[];
  readonly warnings: readonly string[];
}

export class DraftJournalEntriesUseCase {
  constructor(
    private readonly claims: ExpenseClaimRepository,
    private readonly receipts: ExpenseReceiptRepository,
    private readonly policies: ExpensePolicyRepository,
    private readonly sink: JournalDraftSink | undefined,
    private readonly now: () => Date = () => new Date(),
    /** 部門の補助軸の値を引く（省略 = 補助軸を入れない）。 */
    private readonly organization?: OrganizationReadPort,
    /** 補助軸の値が仕訳の科目マスタにあるかの照合（省略 = 照合しない）。 */
    private readonly journalChart?: JournalChartReadPort,
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly claimId: string; readonly by: string }): Promise<DraftJournalEntriesResult> {
    const claim = await requireClaim(this.claims, input.scope, input.claimId);
    if (claim.status !== 'approved' && claim.status !== 'settled') {
      throw new ExpenseTransitionError(`draft journal entries: only an approved or settled claim can be drafted (status: ${claim.status})`, { nextStep: '承認してから仕訳下書きを作成してください' });
    }
    if (claim.journalLink?.complete === true) {
      throw new ExpenseTransitionError('draft journal entries: journal drafts were already created for every item', { nextStep: '仕訳下書きは作成済みです。仕訳画面の出力タブで確定してください' });
    }
    if (this.sink === undefined) {
      throw new ExpenseTransitionError('draft journal entries: the journal is not available in this configuration', { nextStep: 'この構成では仕訳連携を使えません。精算 CSV を会計ソフトへ取り込んでください' });
    }
    const { policy } = await loadExpensePolicy(this.policies, input.scope);
    const organization = this.organization === undefined || policy.journal.departmentDimensionId === undefined ? undefined : await this.organization.get(input.scope);
    const built = buildJournalDrafts(claim, policy, organization === undefined ? {} : { organization });
    const existing = claim.journalLink?.entries ?? [];
    const problems: ExpenseJournalLinkProblem[] = [...built.problems, ...await this.dimensionProblems(input.scope, claim, policy, organization)];
    if (problems.length > 0) {
      throw new ExpenseJournalLinkError(`draft journal entries: ${problems.length} problem(s) must be fixed before creating journal drafts`, problems, existing.map((entry) => entry.entryId));
    }

    const done = new Set(existing.map((entry) => entry.itemId));
    const entries = [...existing];
    const created: string[] = [];
    const recordPartial = async (): Promise<void> => {
      if (created.length === 0) return;
      await saveClaim(this.claims, this.receipts, withJournalLink(claim, { entries, complete: false, warnings: built.warnings }, input.by, this.now().toISOString()));
    };
    for (const draft of built.drafts) {
      const itemId = draft.source.itemId ?? '';
      if (done.has(itemId)) continue;
      try {
        const { entryId } = await this.sink.createDraft(input.scope, draft);
        entries.push({ itemId, entryId });
        created.push(entryId);
      } catch (error) {
        // 作れた分は必ず記録する（記録せずに投げると、再実行で同じ明細の下書きを二重に作る）。
        await recordPartial();
        if (!(error instanceof JournalDraftRejectedError)) throw error;
        const item = claim.items.find((entry) => entry.id === itemId);
        const category = findCategory(policy, item?.categoryId);
        const accountId = category?.accountId ?? '';
        throw new ExpenseJournalLinkError(
          `draft journal entries: the journal rejected item ${itemId}: ${error.detail}`,
          [{
            itemId,
            code: 'journal-rejected',
            message: `${entries.length} 件は仕訳画面に下書きとして作成済みです。費目『${category?.name ?? item?.categoryId ?? ''}』の科目『${accountId}』（または貸方の科目）が科目マスタに無いか無効です（${error.detail}）。規程の費目で科目を選び直すか、仕訳の科目マスタで有効にしてから『続きを作成』を押してください`,
            fixTarget: 'journal-chart',
            ...(category === undefined ? {} : { categoryId: category.id }),
            ...(accountId === '' ? {} : { accountId }),
          }],
          entries.map((entry) => entry.entryId),
        );
      }
    }
    const updated = withJournalLink(claim, { entries, complete: true, warnings: built.warnings }, input.by, this.now().toISOString());
    await saveClaim(this.claims, this.receipts, updated);
    return { claim: updated, entryIds: created, warnings: built.warnings };
  }

  /** 入れる部門の補助軸の値が仕訳の科目マスタに無い・無効なら、作成前に止める（§20.12 `department-dimension-unknown`）。 */
  private async dimensionProblems(scope: TenantScope, claim: ExpenseClaim, policy: Parameters<typeof departmentDimensionFor>[1], organization: Parameters<typeof departmentDimensionFor>[2]): Promise<readonly ExpenseJournalLinkProblem[]> {
    const dimension = departmentDimensionFor(claim, policy, organization);
    if (dimension === undefined || this.journalChart === undefined) return [];
    const chart = await this.journalChart.read(scope);
    const department = organization === undefined ? undefined : findDepartment(organization, claim.claimant.departmentId);
    return Object.entries(dimension).flatMap(([dimensionId, valueId]) => {
      const value = chart.dimensions.find((entry) => entry.id === dimensionId)?.values.find((entry) => entry.id === valueId);
      if (value !== undefined && value.enabled) return [];
      return [{
        code: 'department-dimension-unknown',
        message: `部門『${department?.name ?? claim.claimant.departmentId ?? ''}』の仕訳の補助軸の値『${valueId}』が科目マスタに無いか無効です。組織の部門で値を選び直すか、仕訳の科目マスタで補助軸の値を有効にしてください`,
        fixTarget: 'organization' as const,
        ...(claim.claimant.departmentId === undefined ? {} : { departmentId: claim.claimant.departmentId }),
      }];
    });
  }
}
