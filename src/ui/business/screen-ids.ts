/**
 * 業務テンプレートの画面ID（ADR-0039）。`screens.ts` の `SCREENS` に連結される。
 *
 * 画面ID（= route slug のもと。`#/expense`）は型として列挙しておく必要があるので、記述子とは分けて依存を持たない葉に置く。
 * 業務ごとの記述子は `business/registry.ts` が束ねる。
 */
export const BUSINESS_SCREENS = ['Journal', 'Expense', 'Receivables', 'Contract'] as const;

export type BusinessScreenName = (typeof BUSINESS_SCREENS)[number];
