/**
 * application層: 入金消込に固有の「今は実行できない」エラー。
 *
 * `ReceivablesExtractionUnavailableError`（409）は注文書・見積書の読み取りに要るモデルが未設定か、
 * 能力（structured output / vision）が足りないとき。仕訳の `JournalExtractionUnavailableError` を包み直し、
 * 利用者が設定画面で直せることを示す（ツール経由でだけ現れる）。
 */
export class ReceivablesExtractionUnavailableError extends Error {
  readonly code = 'RECEIVABLES_EXTRACTION_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'ReceivablesExtractionUnavailableError';
  }
}
