/**
 * application層: 運賃マスタの取得・保存（docs/21 §20.2.10 / §20.9.4。UC8）。
 *
 * ワークスペースに 1 つの設定（`expense_settings` の kind `fares`）。未保存なら空の表を返すが保存しない（`saved: false`）。
 * 運賃は利用者のデータ（外部の経路検索は使わない。ADR-0043 §11）。
 */
import type { ExpenseFareTable, FareRoute, StationAlias } from '../../../domain/expense/fare-table';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import type { ExpenseSystemDeps } from '../system-deps';

export interface ExpenseFareTableResult {
  readonly table: ExpenseFareTable;
  readonly saved: boolean;
}

/** 「実用機能の準備」カードの「運賃」が設定済みか（保存済みで経路が 1 件以上）。 */
export function fareTableConfigured(result: ExpenseFareTableResult): boolean {
  return result.saved && result.table.routes.length > 0;
}

export class GetExpenseFaresUseCase {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings'>) {}

  async execute(scope: TenantScope): Promise<ExpenseFareTableResult> {
    const { value, saved } = await this.deps.settings.load(scope, 'fares');
    return { table: value, saved };
  }
}

export interface SaveExpenseFaresInput {
  readonly scope: TenantScope;
  readonly routes: readonly FareRoute[];
  readonly stationAliases: readonly StationAlias[];
}

export class SaveExpenseFaresUseCase {
  constructor(private readonly deps: Pick<ExpenseSystemDeps, 'settings' | 'now'>) {}

  /** 表全体を置き換える（検証は `createExpenseFareTable`。違反は 400 `EXPENSE_DOMAIN`）。 */
  async execute(input: SaveExpenseFaresInput): Promise<ExpenseFareTable> {
    return this.deps.settings.save(input.scope, 'fares', { routes: input.routes, stationAliases: input.stationAliases, updatedAt: this.deps.now().toISOString() });
  }
}
