/**
 * api層: 経費精算（docs/21-expense.md §10.1 / §20.9.5）のエラー → HTTP 写像。
 *
 * 業務のエラー写像は業務ごとのファイルに置き、`error-mapping.ts` の `toHttpError` が順に尋ねる（ADR-0039）。
 * 自分の業務のエラーでなければ `undefined` を返す。読取の失敗（`JournalExtraction*`）は仕訳の写像がそのまま扱う。
 * 「直す場所」を示す項目（行番号・承認できない理由・仕訳連携の問題・振込の点検・直す欄）は `error` 本文の追加キーに載せる。
 * 実用化の 3 系統のエラーもここで写す（系統ごとに写像を分けると、同じ例外の写し方が系統間で揺れるため。骨格が持つ）。
 */
import { JournalDraftRejectedError } from '../application/expense/errors';
import {
  ExpenseAdvanceNotFoundError, ExpenseCardDuplicateImportError, ExpenseCardImportError, ExpenseCardImportNotFoundError, ExpenseCardTransactionNotFoundError,
  ExpenseClaimNotFoundError, ExpenseCsvImportError, ExpenseDetailExtractionUnavailableError, ExpenseDomainError, ExpenseEmployeeCsvImportError,
  ExpenseEmployeeNotFoundError, ExpenseHearingNotFoundError, ExpenseHearingSchemaError, ExpenseHearingUnavailableError, ExpenseItemNotFoundError,
  ExpenseJournalLinkError, ExpensePayoutBlockedError, ExpensePayoutNotFoundError, ExpensePolicyConflictError, ExpenseReceiptNotFoundError,
  ExpenseTransitionError,
} from '../domain/expense/errors';
import { httpError, type HttpError } from './http-error';

/**
 * | 例外 | status | code | 付加情報 |
 * |---|---|---|---|
 * | Expense*NotFoundError（申請・明細・証憑・従業員・仮払・振込・カード利用・カード取込・ヒアリング） | 404 | EXPENSE_*_NOT_FOUND | |
 * | ExpenseCsvImportError / ExpenseDomainError | 400 | EXPENSE_CSV_IMPORT / EXPENSE_DOMAIN | row?, field?, conflictEmployeeId?, employeeId?, converted? |
 * | ExpenseEmployeeCsvImportError / ExpenseCardImportError | 400 | EXPENSE_EMPLOYEE_CSV_IMPORT / EXPENSE_CARD_IMPORT | row?, missingColumns?, suggestedMapping? |
 * | ExpenseTransitionError | 409 | EXPENSE_TRANSITION | blockingReasons, nextStep?, claims? |
 * | ExpenseJournalLinkError | 409 | EXPENSE_JOURNAL_LINK | problems, createdEntryIds |
 * | ExpenseCardDuplicateImportError | 409 | EXPENSE_CARD_DUPLICATE_IMPORT | importId, importedAt |
 * | ExpensePayoutBlockedError | 409 | EXPENSE_PAYOUT_BLOCKED | problems, warnings |
 * | ExpensePolicyConflictError | 409 | EXPENSE_POLICY_CONFLICT | currentUpdatedAt |
 * | ExpenseDetailExtractionUnavailableError / ExpenseHearingUnavailableError | 409 | EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE / EXPENSE_HEARING_UNAVAILABLE | missing |
 * | ExpenseHearingSchemaError | 502 | EXPENSE_HEARING_SCHEMA | issues |
 * | JournalDraftRejectedError（ユースケースの外へ漏れた場合） | 409 | EXPENSE_JOURNAL_LINK | |
 */
export function expenseHttpError(err: unknown): HttpError | undefined {
  if (
    err instanceof ExpenseClaimNotFoundError || err instanceof ExpenseItemNotFoundError || err instanceof ExpenseReceiptNotFoundError
    || err instanceof ExpenseEmployeeNotFoundError || err instanceof ExpenseAdvanceNotFoundError || err instanceof ExpensePayoutNotFoundError
    || err instanceof ExpenseCardTransactionNotFoundError || err instanceof ExpenseCardImportNotFoundError || err instanceof ExpenseHearingNotFoundError
  ) {
    return httpError(404, err.code, err.message);
  }
  if (err instanceof ExpenseDomainError) {
    return { status: 400, body: { error: { code: err.code, message: err.message, ...(err.row === undefined ? {} : { row: err.row }), ...(err.details ?? {}) } } };
  }
  if (err instanceof ExpenseCsvImportError) {
    return { status: 400, body: { error: { code: err.code, message: err.message, ...(err.row === undefined ? {} : { row: err.row }) } } };
  }
  if (err instanceof ExpenseEmployeeCsvImportError || err instanceof ExpenseCardImportError) {
    return {
      status: 400,
      body: { error: {
        code: err.code, message: err.message,
        ...(err.row === undefined ? {} : { row: err.row }),
        ...(err.missingColumns === undefined ? {} : { missingColumns: err.missingColumns }),
        ...(err instanceof ExpenseCardImportError && err.suggestedMapping !== undefined ? { suggestedMapping: err.suggestedMapping } : {}),
      } },
    };
  }
  if (err instanceof ExpenseTransitionError) {
    return {
      status: 409,
      body: { error: {
        code: err.code, message: err.message, blockingReasons: err.blockingReasons,
        ...(err.nextStep === undefined ? {} : { nextStep: err.nextStep }),
        ...(err.claims.length === 0 ? {} : { claims: err.claims }),
      } },
    };
  }
  if (err instanceof ExpenseJournalLinkError) {
    return { status: 409, body: { error: { code: err.code, message: err.message, problems: err.problems, createdEntryIds: err.createdEntryIds } } };
  }
  if (err instanceof ExpenseCardDuplicateImportError) {
    return { status: 409, body: { error: { code: err.code, message: err.message, importId: err.importId, importedAt: err.importedAt } } };
  }
  if (err instanceof ExpensePayoutBlockedError) {
    return { status: 409, body: { error: { code: err.code, message: err.message, problems: err.problems, warnings: err.warnings } } };
  }
  if (err instanceof ExpensePolicyConflictError) {
    return { status: 409, body: { error: { code: err.code, message: err.message, currentUpdatedAt: err.currentUpdatedAt } } };
  }
  if (err instanceof ExpenseDetailExtractionUnavailableError || err instanceof ExpenseHearingUnavailableError) {
    return { status: 409, body: { error: { code: err.code, message: err.message, missing: err.missing } } };
  }
  if (err instanceof ExpenseHearingSchemaError) {
    return { status: 502, body: { error: { code: err.code, message: err.message, issues: err.issues } } };
  }
  if (err instanceof JournalDraftRejectedError) return httpError(409, 'EXPENSE_JOURNAL_LINK', err.message);
  return undefined;
}
