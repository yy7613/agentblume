/**
 * api層: 契約書レビューと期限台帳（docs/23-contract.md §6）のエラー → HTTP 写像。
 *
 * 業務のエラー写像は業務ごとのファイルに置き、`error-mapping.ts` の `toHttpError` が順に尋ねる（ADR-0039）。
 *
 * | 例外 | status | code | 追加の項目 |
 * |---|---|---|---|
 * | ContractDomainError | 400 | CONTRACT_DOMAIN | details（例: undecidedTopicIds） |
 * | Contract*NotFoundError / SignedContractNotFoundError | 404 | CONTRACT_*_NOT_FOUND | |
 * | ContractStateError | 409 | CONTRACT_STATE | documentId / contractId / reviewId（画面が「開く場所」に使う） |
 * | ContractExtractionUnavailableError | 409 | CONTRACT_EXTRACTION_UNAVAILABLE | |
 * | ContractExtractionSchemaError | 502 | CONTRACT_EXTRACTION_SCHEMA | |
 */
import { ContractExtractionSchemaError, ContractExtractionUnavailableError } from '../application/contract/errors';
import {
  ContractDocumentNotFoundError, ContractDomainError, ContractPlaybookNotFoundError, ContractReviewNotFoundError,
  ContractStateError, SignedContractNotFoundError,
} from '../domain/contract/errors';
import { httpError, type HttpError } from './http-error';

export function contractHttpError(err: unknown): HttpError | undefined {
  if (err instanceof ContractPlaybookNotFoundError || err instanceof ContractDocumentNotFoundError || err instanceof ContractReviewNotFoundError || err instanceof SignedContractNotFoundError) {
    return httpError(404, err.code, err.message);
  }
  if (err instanceof ContractDomainError) return { status: 400, body: { error: { code: err.code, message: err.message, ...(err.details ?? {}) } } };
  // 状態の衝突は利用者が「開いて直す」ことで解消するので、どの文書 / 契約 / レビューかを本文に載せる。
  if (err instanceof ContractStateError) return { status: 409, body: { error: { code: err.code, message: err.message, ...(err.target ?? {}) } } };
  // モデル未設定・能力不足は設定画面で直せるので 409、応答がスキーマに合わないのはモデル側の問題なので 502。
  if (err instanceof ContractExtractionUnavailableError) return httpError(409, err.code, err.message);
  if (err instanceof ContractExtractionSchemaError) return httpError(502, err.code, err.message);
  return undefined;
}
