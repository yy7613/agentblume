/**
 * application層: 仮払の仕訳下書き（支払 / 精算。docs/21 §20.12。UC4）。
 *
 * 仕訳の保存は `JournalDraftSink`（composition が仕訳の `SaveJournalEntryUseCase` を包む）越しに行い、仕訳のコードは変えない。
 * 作成前に全部検査し（科目が仕訳の科目マスタに有効であるか・精算なら紐付く申請の明細の下書きが作成済みか）、問題があれば 1 件も作らない。
 */
import type { ExpenseAdvance } from '../../../domain/expense/advance';
import { ExpenseJournalLinkError, type ExpenseJournalLinkProblem } from '../../../domain/expense/errors';
import { buildAdvanceJournalDraft, type AdvanceJournalStage } from '../../../domain/expense/money/advance-journal';
import { withAdvanceJournalEntry } from '../../../domain/expense/money/advance-transitions';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { JournalDraftRejectedError } from '../errors';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';
import { linkedClaimSummaries, requireAdvance } from './manage-advances';

export interface AdvanceJournalDraftsResult {
  readonly advance: ExpenseAdvance;
  readonly entryIds: readonly string[];
  readonly warnings: readonly string[];
}

export class DraftAdvanceJournalEntriesUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(input: { readonly scope: TenantScope; readonly advanceId: string; readonly stage: AdvanceJournalStage; readonly by: string }): Promise<AdvanceJournalDraftsResult> {
    const { scope, stage } = input;
    const advance = await requireAdvance(this.deps, scope, input.advanceId);
    const sink = this.deps.journalDrafts;
    if (sink === undefined) {
      throw new ExpenseJournalLinkError('advance journal drafts: the journal is not connected', [
        { code: 'journal-unavailable', fixTarget: 'policy-journal', message: '仕訳連携が使えない構成です。仕訳の機能が有効なサーバーで操作してください' },
      ]);
    }
    const { policy } = await loadExpensePolicy(this.deps.repositories.policies, scope);
    const problems: ExpenseJournalLinkProblem[] = [];
    if (stage === 'settlement') {
      for (const claim of await linkedClaimSummaries(this.deps, scope, advance.id)) {
        if (claim.journalLinked === 'complete') continue;
        problems.push({ code: 'advance-claim-journal-missing', fixTarget: 'item', message: `紐付く申請 ${claim.id}（${claim.claimant.name}）の明細の仕訳下書きを先に作ってください。精算出力タブで作成できます` });
      }
    }
    const chart = this.deps.journalChart === undefined ? undefined : await this.deps.journalChart.read(scope);
    const known = chart === undefined ? undefined : new Set(chart.accounts.filter((account) => account.enabled).map((account) => account.id));
    const built = buildAdvanceJournalDraft(advance, policy, stage, known);
    problems.push(...built.problems);
    if (problems.length > 0 || built.draft === undefined) {
      throw new ExpenseJournalLinkError(`advance journal drafts: ${problems.length} problem(s) must be fixed before drafting`, problems);
    }
    let entryId: string;
    try {
      entryId = (await sink.createDraft(scope, built.draft)).entryId;
    } catch (error) {
      if (!(error instanceof JournalDraftRejectedError)) throw error;
      throw new ExpenseJournalLinkError(error.message, [{ code: 'journal-rejected', fixTarget: 'journal-chart', message: `仕訳側が下書きを拒否しました（${error.detail}）。仕訳の科目マスタで科目を確かめてください` }]);
    }
    const updated = withAdvanceJournalEntry(advance, stage, entryId, [], input.by, this.deps.now().toISOString());
    await this.deps.repositories.advances.save(updated);
    return { advance: updated, entryIds: [entryId], warnings: [] };
  }
}
