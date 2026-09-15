/**
 * application層: 運賃マスタの CSV 出力・取込（docs/21 §20.2.10 / §20.9.4。UC8）。
 *
 * 取込は経路の一覧だけを置き換え、駅名の別名は残す（別名は画面で足す揺れの吸収で、CSV の列に無いため）。
 * 行の形の誤りは行番号付きの 400 `EXPENSE_CSV_IMPORT`、表全体の重なり（同じ駅の並び × 券種で有効期間が重なる）は 400 `EXPENSE_DOMAIN`。
 */
import { FARE_CSV_FILE_NAME, fareTableToCsv, parseFareCsv } from '../../../domain/expense/input/fare-csv';
import type { ExpenseFareTable } from '../../../domain/expense/fare-table';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export class ExportExpenseFaresCsvUseCase {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings'>) {}

  async execute(scope: TenantScope): Promise<{ readonly content: string; readonly fileName: string }> {
    const { value } = await this.deps.settings.load(scope, 'fares');
    return { content: fareTableToCsv(value.routes), fileName: FARE_CSV_FILE_NAME };
  }
}

export class ImportExpenseFaresCsvUseCase {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings' | 'now'>) {}

  async execute(input: { readonly scope: TenantScope; readonly content: string }): Promise<ExpenseFareTable> {
    const routes = parseFareCsv(input.content);
    const { value } = await this.deps.settings.load(input.scope, 'fares');
    return this.deps.settings.save(input.scope, 'fares', { routes, stationAliases: value.stationAliases, updatedAt: this.deps.now().toISOString() });
  }
}
