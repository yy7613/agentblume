/**
 * Composition: 経費精算の 3 系統（A 人と承認 / B お金の流れ / C 入力と規程）の組み立てが受け取る共通の文脈と返す形
 * （docs/21 §20.13.2。骨格。凍結）。
 *
 * `composition/expense.ts` が全リポジトリとポートを 1 回だけ作り、`ExpenseCoreServices` として `compose<系統>(core)` へ渡す。
 * 系統はリポジトリを作り直さない（test プロファイルでは InMemory の保管庫が別になり、骨格の申請から見えなくなるため）。
 * 系統の `feature` は `ExpenseAppFeature` に展開され、api の `Expense<系統>RouteDeps` をそのまま満たす。
 */
import type { ExpenseCheckFactsProvider } from '../application/expense/ports';
import type { ExpenseSystemDeps } from '../application/expense/system-deps';
import type { JournalAppFeature } from './journal';
import type { BusinessComposition, BusinessCompositionContext } from './business';

export interface ExpenseCoreServices extends ExpenseSystemDeps {
  /** 業務の組み立て文脈（profile・main モデル・モデルの能力・ロガー）。LLM の可否は `context.profile === 'test'` なら使えない側へ倒す。 */
  readonly context: BusinessCompositionContext;
  /** 仕訳の組み立て結果（読取・下書き・科目マスタ）。 */
  readonly journal: JournalAppFeature;
}

/** 系統の組み立て結果。判定の事実を集める provider を必ず返す（スタブは何も集めない）。 */
export interface ExpenseSystemComposition<Feature> extends BusinessComposition<Feature> {
  readonly checkFacts: ExpenseCheckFactsProvider;
}
