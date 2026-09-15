/**
 * ui/api層: 業務のエラー文言の登録型（葉モジュール。ADR-0039）。
 *
 * `error-messages.ts` と業務ごとの `<業務>-error-messages.ts` の両方が使うので、循環しないよう分けて置く。
 */

export type ErrorLanguage = 'en' | 'ja';
export type Bilingual = readonly [en: string, ja: string];

/** 見出しを作るときに読める応答の中身。 */
export interface BusinessErrorPayload {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;
  /** 仕訳 CSV 取込の失敗行（1 始まり）。 */
  readonly row?: number;
  /** サーバーが error 本文へ足した、共通で解釈しない項目（業務が「直す場所」を示すために載せる）。 */
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface BusinessErrorMessages {
  /**
   * error.code → 見出し（原因 → 次の一手まで 1 文で）。code は `<業務>_` で始める
   * （共通の code や他の業務と衝突させない。テストが検査する）。
   */
  readonly headings: Readonly<Record<string, Bilingual>>;
  /** 本文の項目（行番号など）を埋めた見出し。自分の code でなければ undefined を返す。 */
  readonly heading?: (payload: BusinessErrorPayload, language: ErrorLanguage) => string | undefined;
}
