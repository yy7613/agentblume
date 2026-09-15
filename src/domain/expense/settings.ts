/**
 * ドメイン: ワークスペースに 1 つの設定の種類と型の対応（docs/21 §20.8。`expense_settings` の kind）。
 *
 * 版を増やさずに設定の種類を足せるよう 1 テーブルにまとめ、kind で型を引く。規程と同じく**未保存なら既定値を返すが保存しない**
 * （application の `settings-store.ts` が `saved: boolean` を付けて返す）。
 */
import { createExpenseCardSettings, emptyExpenseCardSettings, type ExpenseCardSettings } from './card';
import { createExpenseFareTable, emptyExpenseFareTable, type ExpenseFareTable } from './fare-table';
import { createExpenseOrganization, emptyExpenseOrganization, type ExpenseOrganization } from './organization';
import { createExpensePayoutSettings, defaultExpensePayoutSettings, type ExpensePayoutSettings } from './payout';

export const EXPENSE_SETTINGS_KINDS = ['organization', 'payout', 'cards', 'fares'] as const;
export type ExpenseSettingsKind = (typeof EXPENSE_SETTINGS_KINDS)[number];

export interface ExpenseSettingsMap {
  readonly organization: ExpenseOrganization;
  readonly payout: ExpensePayoutSettings;
  readonly cards: ExpenseCardSettings;
  readonly fares: ExpenseFareTable;
}

export type ExpenseSettingsOf<K extends ExpenseSettingsKind> = ExpenseSettingsMap[K];

export function isExpenseSettingsKind(value: unknown): value is ExpenseSettingsKind {
  return typeof value === 'string' && (EXPENSE_SETTINGS_KINDS as readonly string[]).includes(value);
}

/** 保存したことが無いワークスペースの値（保存はしない）。 */
export function defaultExpenseSettings<K extends ExpenseSettingsKind>(kind: K): ExpenseSettingsOf<K> {
  const defaults: { readonly [P in ExpenseSettingsKind]: () => ExpenseSettingsMap[P] } = {
    organization: () => emptyExpenseOrganization(),
    payout: () => defaultExpensePayoutSettings(),
    cards: () => emptyExpenseCardSettings(),
    fares: () => emptyExpenseFareTable(),
  };
  return defaults[kind]() as ExpenseSettingsOf<K>;
}

/** 種類ごとの組み立て（不変条件の検証）。直列化の復元と保存の入口が使う。 */
export function createExpenseSettings<K extends ExpenseSettingsKind>(kind: K, value: unknown): ExpenseSettingsOf<K> {
  const creators: { readonly [P in ExpenseSettingsKind]: (raw: never) => ExpenseSettingsMap[P] } = {
    organization: (raw) => createExpenseOrganization(raw),
    payout: (raw) => createExpensePayoutSettings(raw),
    cards: (raw) => createExpenseCardSettings(raw),
    fares: (raw) => createExpenseFareTable(raw),
  };
  return creators[kind](value as never) as ExpenseSettingsOf<K>;
}
