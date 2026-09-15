/**
 * application層: `expense_summary` の行の供給（docs/21 §20.11.1）。
 *
 * ツールの引数（G-2 の `arguments`）の period / group_by / status を行ソースが受け取り、画面と同じ集計を行う。
 * 既定: 期間 = 今日の月までの直近 12 か月、group_by = month,category、状態 = approved,settled、基準日 = transaction。
 * 引数の形が不正なら `ExpenseDomainError`（行ソースが `DataSourceValidationError` に言い換える）。
 */
import type { Row } from '../../../domain/data/types';
import { businessDateOf } from '../../../domain/expense/business-date';
import { ExpenseDomainError } from '../../../domain/expense/errors';
import { parseSummaryGroupBy, parseSummaryPeriod, parseSummaryStatuses, summaryTableRows } from '../../../domain/expense/money/summary';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';
import type { SummarizeExpensesUseCase } from './summary';

function textArgument(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ExpenseDomainError(`${name} must be a string`, undefined, { field: name });
  return value;
}

export class ExpenseSummaryRowsProvider {
  constructor(private readonly summary: SummarizeExpensesUseCase, private readonly deps: Pick<ExpenseSystemDeps, 'now' | 'timeZone'>) {}

  async rows(scope: TenantScope, args: Readonly<Record<string, unknown>>, limit?: number): Promise<readonly Row[]> {
    const today = businessDateOf(this.deps.now(), this.deps.timeZone);
    const { from, to } = parseSummaryPeriod(textArgument(args['period'], 'period'), today);
    const groupBy = parseSummaryGroupBy(textArgument(args['group_by'], 'group_by'));
    const statuses = parseSummaryStatuses(textArgument(args['status'], 'status'));
    const result = await this.summary.execute(scope, { from, to, groupBy, statuses, basis: 'transaction' });
    const rows = summaryTableRows(result) as readonly Row[];
    return limit === undefined ? rows : rows.slice(0, limit);
  }
}
