/**
 * application層: 仕訳の LLM 機能（抽出・ヒアリング）に固有のエラー（docs/20 §6 / §7。フェーズ 2）。
 *
 * ドメインの不変条件違反ではないので `src/domain/journal/errors.ts` には置かない。
 * ここに現れるのは「モデル側の都合で今は実行できない」ことだけである。
 *
 * - `JournalExtractionUnavailableError`（409）: モデルが未設定、または必要な能力
 *   （structured output / vision）が無い。**利用者が設定画面で直せる**ので 4xx で返し、
 *   メッセージには「何が足りないか」と「どこで直すか」を必ず書く。
 * - `JournalExtractionSchemaError`（502）: 応答が約束のスキーマに合わず、1 回の修復でも直らなかった。
 *   利用者に直せる点は無い（モデル側の問題）ので 5xx。何が合わなかったかを `issues` に持ち、
 *   メッセージにも並べる（モデルを替える判断の材料になる）。
 */

/** モデルの未設定・能力不足で仕訳の LLM 抽出が使えない。api で 409。 */
export class JournalExtractionUnavailableError extends Error {
  readonly code = 'JOURNAL_EXTRACTION_UNAVAILABLE';

  constructor(message: string) {
    super(message);
    this.name = 'JournalExtractionUnavailableError';
  }
}

/** 応答が抽出スキーマに合わない（修復後も）。api で 502（MODEL_PROVIDER と同じ扱い）。 */
export class JournalExtractionSchemaError extends Error {
  readonly code = 'JOURNAL_EXTRACTION_SCHEMA';
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length === 0 ? message : `${message}: ${issues.join('; ')}`);
    this.name = 'JournalExtractionSchemaError';
    this.issues = [...issues];
  }
}
