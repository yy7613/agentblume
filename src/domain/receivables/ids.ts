/**
 * ドメイン: 入金消込（receivables）BC の識別子（ADR-0034 の Flavor パターン）。
 *
 * 取引先 / 請求書 / 入金明細 / 消込 / 明細 CSV プロファイルの id は素の string から代入できるが、
 * 互いの取り違え（請求書 id を明細 id として渡す等）はコンパイル時に検出される。実行時表現は素の文字列のまま。
 */
import type { Flavor } from '../shared/brand';

export type CustomerId = Flavor<string, 'CustomerId'>;
export type InvoiceId = Flavor<string, 'InvoiceId'>;
export type BankTransactionId = Flavor<string, 'BankTransactionId'>;
export type MatchingId = Flavor<string, 'MatchingId'>;
export type BankCsvProfileId = Flavor<string, 'BankCsvProfileId'>;
