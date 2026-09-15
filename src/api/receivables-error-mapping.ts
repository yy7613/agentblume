/**
 * api層: 入金消込（docs/22-receivables.md §7）のエラー → HTTP 写像。
 *
 * 業務のエラー写像は業務ごとのファイルに置き、`error-mapping.ts` の `toHttpError` が順に尋ねる（ADR-0039）。
 * 「直す場所」を示す項目（違反の一覧・行番号・状態の理由・足りない科目）は本文の追加キーとして載せ、
 * 画面はそれで「原因・次の一手・その場所を開くボタン」を出す。
 */
import { ReceivablesExtractionUnavailableError } from '../application/receivables/errors';
import {
  BankCsvProfileNotFoundError, BankTransactionNotFoundError, CustomerNotFoundError, InvoiceComplianceError, InvoiceNotFoundError,
  JournalLinkError, MatchingNotFoundError, ReceivablesCsvImportError, ReceivablesDomainError, ReceivablesStateError,
} from '../domain/receivables/errors';
import { httpError, type HttpError } from './http-error';

/** 入力の誤り（配分・プロファイル）として 400 にする状態の理由。残りは「状態が変わった」ので 409。 */
const BAD_REQUEST_REASONS: ReadonlySet<string> = new Set(['allocation-exceeds-outstanding', 'allocation-sum-mismatch', 'fee-out-of-tolerance', 'profile-builtin']);

/**
 * | 例外 | status | code | 本文の追加 |
 * |---|---|---|---|
 * | ReceivablesDomainError | 400 | RECEIVABLES_DOMAIN | |
 * | InvoiceComplianceError | 400 | RECEIVABLES_INVOICE_COMPLIANCE | violations |
 * | ReceivablesCsvImportError | 400 | RECEIVABLES_CSV_IMPORT | row |
 * | *NotFoundError | 404 | RECEIVABLES_*_NOT_FOUND | |
 * | ReceivablesStateError | 409（入力誤りは 400） | RECEIVABLES_STATE | reason, params |
 * | JournalLinkError | 409 | RECEIVABLES_JOURNAL_ACCOUNT_MISSING | missing |
 * | ReceivablesExtractionUnavailableError | 409 | RECEIVABLES_EXTRACTION_UNAVAILABLE | |
 */
export function receivablesHttpError(err: unknown): HttpError | undefined {
  if (err instanceof InvoiceComplianceError) return { status: 400, body: { error: { code: err.code, message: err.message, violations: err.violations } } };
  if (err instanceof ReceivablesCsvImportError) return { status: 400, body: { error: { code: err.code, message: err.message, ...(err.row === undefined ? {} : { row: err.row }) } } };
  if (err instanceof ReceivablesDomainError) return httpError(400, err.code, err.message);
  if (err instanceof CustomerNotFoundError || err instanceof InvoiceNotFoundError || err instanceof BankTransactionNotFoundError || err instanceof MatchingNotFoundError || err instanceof BankCsvProfileNotFoundError) {
    return httpError(404, err.code, err.message);
  }
  if (err instanceof ReceivablesStateError) {
    return { status: BAD_REQUEST_REASONS.has(err.reason) ? 400 : 409, body: { error: { code: err.code, message: err.message, reason: err.reason, params: err.params } } };
  }
  if (err instanceof JournalLinkError) return { status: 409, body: { error: { code: err.code, message: err.message, missing: err.missing } } };
  if (err instanceof ReceivablesExtractionUnavailableError) return httpError(409, err.code, err.message);
  return undefined;
}
