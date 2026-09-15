/**
 * application層: 経費の集計（画面の表・CSV 出力。docs/21 §20.3.7 / §20.9.3。UC6）。
 *
 * 明細の索引行（`listItemFacts`）を読み、domain の `summarizeExpenses` に渡す。申請の record_json は読まない。
 * 取引日の基準では「取引日の無い明細」を unknown に数えるため、取引日で絞らずに状態だけで引く。
 * 承認日・精算日の基準では、業務のタイムゾーンで月の境界がずれる分（前後 1 か月）を広めに引き、月の判定は domain が行う。
 */
import type { ClaimStatus } from '../../../domain/expense/claim';
import { findDepartment } from '../../../domain/expense/organization';
import { findCategory } from '../../../domain/expense/policy';
import type { ExpenseItemFactQuery } from '../../../domain/expense/repositories';
import { summaryToCsv } from '../../../domain/expense/money/summary-csv';
import { shiftMonth, summarizeExpenses, validateSummaryRange, type ExpenseSummaryResult, type SummaryBasis, type SummaryGroupKey } from '../../../domain/expense/money/summary';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { loadExpensePolicy } from '../manage-policy';
import type { ExpenseSystemDeps } from '../system-deps';

/** 集計の入力に読む明細の上限（超えたら警告を出す）。 */
export const SUMMARY_FACT_LIMIT = 100_000;

export interface SummaryQuery {
  readonly from: string;
  readonly to: string;
  readonly groupBy: readonly SummaryGroupKey[];
  readonly statuses: readonly ClaimStatus[];
  readonly basis: SummaryBasis;
}

export class SummarizeExpensesUseCase {
  constructor(private readonly deps: ExpenseSystemDeps, private readonly factLimit: number = SUMMARY_FACT_LIMIT) {}

  async execute(scope: TenantScope, query: SummaryQuery): Promise<ExpenseSummaryResult> {
    const { from, to } = validateSummaryRange(query.from, query.to);
    const wideFrom = `${shiftMonth(from, -1)}-01`;
    const wideTo = `${shiftMonth(to, 1)}-99`;
    const factQuery: ExpenseItemFactQuery = {
      limit: this.factLimit,
      ...(query.statuses.length === 0 ? {} : { statuses: query.statuses }),
      ...(query.basis === 'approved' ? { approvedFrom: wideFrom, approvedTo: wideTo } : {}),
      ...(query.basis === 'settled' ? { settledFrom: wideFrom, settledTo: wideTo } : {}),
    };
    const [facts, { policy }, organization] = await Promise.all([
      this.deps.repositories.claims.listItemFacts(scope, factQuery),
      loadExpensePolicy(this.deps.repositories.policies, scope),
      this.deps.organization.get(scope),
    ]);
    const result = summarizeExpenses(facts, { from, to, groupBy: query.groupBy, statuses: query.statuses, basis: query.basis }, {
      categoryName: (id) => findCategory(policy, id)?.name,
      departmentName: (id) => findDepartment(organization, id)?.name,
      timeZone: this.deps.timeZone,
    });
    if (facts.length < this.factLimit) return result;
    return { ...result, warnings: [...result.warnings, `明細が ${this.factLimit.toLocaleString('en-US')} 件を超えたため、一部だけで集計しています。期間か状態を絞ってください`] };
  }

  async export(scope: TenantScope, query: SummaryQuery): Promise<{ readonly content: string; readonly fileName: string }> {
    return summaryToCsv(await this.execute(scope, query));
  }
}
