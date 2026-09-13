/**
 * application層: 科目マスタ（ChartOfAccounts）の取得・保存・初期化（docs/20 §5）。
 *
 * ## 保存したことが無いワークスペースは「標準セットを返すが保存はしない」
 *
 * `GET /journal/chart` の初回で標準セットを書き込む（auto-provision）ことも考えられるが、採らない。
 * 参照が書き込みを起こすと (1) 読み取り権限しか無い利用者が 500 に落ちる、(2) 標準セットの内容を
 * 後から改善しても、一度でも画面を開いたワークスペースには古い seed が焼き付く、という 2 つの困りごとが起きる。
 * 「まだ保存していない」状態を保ったまま標準セットを見せ、利用者が保存（または「標準に戻す」）を
 * 押したときに初めて `journal_chart` の行ができる。
 */
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { createChartOfAccounts, type Account, type Dimension, type TaxCategory } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import type { ChartOfAccountsRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/** 保存済みマスタ、無ければ標準セット（保存はしない）。 */
export class GetChartOfAccountsUseCase {
  constructor(private readonly charts: ChartOfAccountsRepository) {}

  async execute(scope: TenantScope): Promise<ChartOfAccounts> {
    // 標準セットは共有定数なので、呼び出し側が触っても壊れないよう毎回組み立て直す。
    return (await this.charts.get(scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
  }
}

export interface SaveChartOfAccountsInput {
  readonly scope: TenantScope;
  readonly accounts: readonly Account[];
  readonly dimensions: readonly Dimension[];
  readonly taxCategories: readonly TaxCategory[];
}

/** マスタ全体を置き換える（部分更新はしない。UI は編集後の全体を送る）。 */
export class SaveChartOfAccountsUseCase {
  constructor(
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveChartOfAccountsInput): Promise<ChartOfAccounts> {
    const chart = createChartOfAccounts({
      accounts: input.accounts,
      dimensions: input.dimensions,
      taxCategories: input.taxCategories,
      updatedAt: this.now().toISOString(),
    });
    await this.charts.save(input.scope, chart);
    return chart;
  }
}

/** 標準セットへ戻す（保存する）。 */
export class ResetChartOfAccountsUseCase {
  constructor(
    private readonly charts: ChartOfAccountsRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope): Promise<ChartOfAccounts> {
    const chart = defaultChartOfAccounts(this.now().toISOString());
    await this.charts.save(scope, chart);
    return chart;
  }
}