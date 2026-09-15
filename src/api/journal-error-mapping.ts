/**
 * api層: 仕訳（docs/20-journal.md）のエラー → HTTP 写像。
 *
 * 業務のエラー写像は業務ごとのファイルに置き、`error-mapping.ts` の `toHttpError` が順に尋ねる（ADR-0039）。
 * 自分の業務のエラーでなければ `undefined` を返す。
 */
import { JournalExtractionSchemaError, JournalExtractionUnavailableError } from '../application/journal/errors';
import {
  JournalCsvImportError, JournalDocumentNotFoundError, JournalDomainError, JournalEntryNotFoundError,
  JournalExportError, JournalHearingNotFoundError, JournalRuleNotFoundError,
} from '../domain/journal/errors';
import { httpError, type HttpError } from './http-error';

/**
 * | 例外 | status | code |
 * |---|---|---|
 * | Journal*NotFoundError | 404 | JOURNAL_*_NOT_FOUND |
 * | JournalCsvImportError | 400 | JOURNAL_CSV_IMPORT + row |
 * | JournalExportError / JournalDomainError | 400 | JOURNAL_EXPORT / JOURNAL_DOMAIN |
 * | JournalExtractionUnavailableError | 409 | JOURNAL_EXTRACTION_UNAVAILABLE |
 * | JournalExtractionSchemaError | 502 | JOURNAL_EXTRACTION_SCHEMA |
 */
export function journalHttpError(err: unknown): HttpError | undefined {
  // 仕訳: 参照切れは404、入力・保存済みレコードの不変条件違反と出力の前提違反は400。
  // CSV 取込だけは「何行目が悪いか」を本文へ載せる（UI が行番号つきの日本語メッセージにする）。
  // 判定が「確定できなかった」ことはエラーではなく結果（undecided）なので、ここには現れない。
  if (err instanceof JournalDocumentNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof JournalRuleNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof JournalEntryNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof JournalHearingNotFoundError) return httpError(404, err.code, err.message);
  if (err instanceof JournalCsvImportError) {
    return { status: 400, body: { error: { code: err.code, message: err.message, ...(err.row === undefined ? {} : { row: err.row }) } } };
  }
  if (err instanceof JournalExportError) return httpError(400, err.code, err.message);
  if (err instanceof JournalDomainError) return httpError(400, err.code, err.message);
  // 仕訳の LLM 抽出（フェーズ 2）: モデル未設定・能力不足は**利用者が設定画面で直せる**ので 409、
  // 応答が修復後もスキーマに合わないのはモデル側の問題なので ModelProviderError と同じ 502。
  if (err instanceof JournalExtractionUnavailableError) return httpError(409, err.code, err.message);
  if (err instanceof JournalExtractionSchemaError) return httpError(502, err.code, err.message);
  return undefined;
}
