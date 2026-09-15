/**
 * application層: 契約書レビューの LLM 機能（文字起こし・条項抽出）に固有のエラー（docs/23 §3.5）。
 *
 * ドメインの不変条件違反ではないので `src/domain/contract/errors.ts` には置かない。
 * - `ContractExtractionUnavailableError`（409）: モデルが未設定、または必要な能力（structured output / vision）が無い。
 *   利用者が設定画面で直せるので 4xx で返し、何が足りず設定のどこで直すかを必ず書く。
 * - `ContractExtractionSchemaError`（502）: **全部の**条文束が 1 回の修復でもスキーマに合わなかった
 *   （一部の束だけの失敗はエラーにせず、そのトピックを `extraction-failed` にする）。
 */

export class ContractExtractionUnavailableError extends Error {
  readonly code = 'CONTRACT_EXTRACTION_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'ContractExtractionUnavailableError';
  }
}

export class ContractExtractionSchemaError extends Error {
  readonly code = 'CONTRACT_EXTRACTION_SCHEMA';
  readonly issues: readonly string[];
  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length === 0 ? message : `${message}: ${issues.join('; ')}`);
    this.name = 'ContractExtractionSchemaError';
    this.issues = [...issues];
  }
}
