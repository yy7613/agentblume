/**
 * ドメイン: 入金消込（receivables）BC のエラー型（docs/22 §7 のエラー写像）。
 *
 * - 入力・保存済みレコードの不変条件違反は `ReceivablesDomainError`（400）。
 * - 発行の前提（適格請求書の記載事項・税額の検査）を満たさないのは `InvoiceComplianceError`（400。違反の一覧を持つ）。
 * - 銀行明細 CSV の取込全体の前提が崩れているのは `ReceivablesCsvImportError`（400。行が特定できれば `row`）。
 * - 参照切れは `*NotFoundError`（404）。
 * - 状態の前提（発行済みの編集・入金ありの取消・判定後の残高変化など）は `ReceivablesStateError`（409。`reason` で画面が次の一手を出す）。
 * - 仕訳の科目・税区分が無い / 無効なのは `JournalLinkError`（409。どの設定項目かを `missing` に持つ）。
 *
 * 消込が「決まらなかった」ことはエラーではなく判定結果（`candidate` / `unmatched`）で表す（ADR-0041 決定 1）。
 */

/** 違反・警告 1 件（docs/22 §3.1）。文言は UI が code + params から組み立てる。 */
export interface InvoiceIssue {
  readonly code: string;
  readonly path?: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export class ReceivablesDomainError extends Error {
  readonly code = 'RECEIVABLES_DOMAIN';
  constructor(message: string) {
    super(message);
    this.name = 'ReceivablesDomainError';
  }
}

/** 発行できない（違反が 1 件以上ある）。 */
export class InvoiceComplianceError extends Error {
  readonly code = 'RECEIVABLES_INVOICE_COMPLIANCE';
  readonly violations: readonly InvoiceIssue[];
  constructor(message: string, violations: readonly InvoiceIssue[]) {
    super(message);
    this.name = 'InvoiceComplianceError';
    this.violations = violations.map((issue) => ({ ...issue, params: { ...issue.params } }));
  }
}

export class ReceivablesCsvImportError extends Error {
  readonly code = 'RECEIVABLES_CSV_IMPORT';
  readonly row: number | undefined;
  constructor(message: string, row?: number) {
    super(message);
    this.name = 'ReceivablesCsvImportError';
    this.row = row;
  }
}

export class CustomerNotFoundError extends Error {
  readonly code = 'RECEIVABLES_CUSTOMER_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'CustomerNotFoundError'; }
}

export class InvoiceNotFoundError extends Error {
  readonly code = 'RECEIVABLES_INVOICE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'InvoiceNotFoundError'; }
}

export class BankTransactionNotFoundError extends Error {
  readonly code = 'RECEIVABLES_BANK_TRANSACTION_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'BankTransactionNotFoundError'; }
}

export class MatchingNotFoundError extends Error {
  readonly code = 'RECEIVABLES_MATCHING_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'MatchingNotFoundError'; }
}

export class BankCsvProfileNotFoundError extends Error {
  readonly code = 'RECEIVABLES_BANK_CSV_PROFILE_NOT_FOUND';
  constructor(message: string) { super(message); this.name = 'BankCsvProfileNotFoundError'; }
}

/** 状態の前提違反の理由（画面はこれで「次の一手」を選ぶ）。 */
export const RECEIVABLES_STATE_REASONS = [
  'transaction-not-unmatched', 'invoice-outstanding-changed', 'invoice-not-draft', 'invoice-not-issued',
  'invoice-has-payments', 'customer-in-use', 'matching-not-confirmed', 'transaction-not-ignored',
  'allocation-exceeds-outstanding', 'allocation-sum-mismatch', 'fee-out-of-tolerance', 'profile-builtin',
] as const;
export type ReceivablesStateReason = (typeof RECEIVABLES_STATE_REASONS)[number];

/** 状態の前提違反。HTTP は reason ごとに 409 / 400（配分の入力誤りは 400。docs/22 §4.5）。 */
export class ReceivablesStateError extends Error {
  readonly code = 'RECEIVABLES_STATE';
  readonly reason: ReceivablesStateReason;
  readonly params: Readonly<Record<string, string | number>>;
  constructor(reason: ReceivablesStateReason, message: string, params: Readonly<Record<string, string | number>> = {}) {
    super(message);
    this.name = 'ReceivablesStateError';
    this.reason = reason;
    this.params = { ...params };
  }
}

/** 仕訳連携で使う科目 / 税区分のうち、マスタに無い（無効な）もの。`settingPath` は設定画面の項目。 */
export interface JournalLinkMissing {
  readonly kind: 'account' | 'tax';
  readonly id: string;
  readonly settingPath: string;
}

export class JournalLinkError extends Error {
  readonly code = 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING';
  readonly missing: readonly JournalLinkMissing[];
  constructor(message: string, missing: readonly JournalLinkMissing[]) {
    super(message);
    this.name = 'JournalLinkError';
    this.missing = missing.map((entry) => ({ ...entry }));
  }
}
