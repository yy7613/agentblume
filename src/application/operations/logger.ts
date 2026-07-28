/**
 * application層: 運用ログの最小Port（`TelemetryPort` と同じ「観測系は業務へ伝播させない」規律）。
 *
 * ## なぜ必要か
 *
 * 「観測系の障害を業務へ伝播させない」ために、コードベースには**意図的に握り潰す catch** が並んでいる
 * （メトリクス保存の失敗でAgent実行を落とすのは本末転倒、という判断は正しい）。
 * ところが握り潰したまま**何も残していなかった**ため、
 *
 * - メトリクスがずっと保存されていない
 * - judge の設定解決が毎回失敗して古い指紋が記録され続けている
 * - ワーカーが例外でジョブを1件も進めていない
 *
 * といった障害が**完全に不可視**だった。ここでは方針（握り潰す）は変えず、**痕跡だけを残す**。
 *
 * ## 依存の向き
 *
 * application層はadapters層をimportできないため、出力先はPortとして受け取る。
 * composition が console 実装（`ConsoleLogger`）を注入し、テストは fake か `NOOP_LOGGER` を使う。
 */

/** ログ1行に添える構造化情報。値はそのまま出力先へ渡す（秘密値を入れないのは呼び出し側の責務）。 */
export type LogContext = Readonly<Record<string, unknown>>;

/**
 * 運用ログの出力先。level は3つに絞る。
 *
 * - `info`: 起動時の回収件数・retentionの削除件数など「運用者が知りたい正常系の結果」。
 * - `warn`: 握り潰した障害。業務は続行しているが、放置すると機能が静かに死ぬもの。
 * - `error`: 握り潰しはしたが、次の実行も同じように失敗し続けると考えられるもの。
 */
export interface LoggerPort {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/** 何も出力しないロガー。テストと「未配線」の既定値に使う。 */
export const NOOP_LOGGER: LoggerPort = { info: () => {}, warn: () => {}, error: () => {} };

/** エラーメッセージに載せる長さの上限（スタックまがいの長文でログを埋めない）。 */
const MAX_REASON_LENGTH = 300;

/**
 * 秘密値らしき部分を伏せる（`src/config/environment.ts` の `describeReceived` と同じ規律）。
 *
 * 例外メッセージには、リクエストURLやヘッダがそのまま載ることがある
 * （`fetch` 失敗の `cause`、SDKの「401 for https://…?api_key=…」など）。
 * ログは平文ファイルへ出るため、**鍵の形をしたものは値ごと落とす**。
 */
export function redactSecrets(text: string): string {
  return text
    // Authorization ヘッダはスキームごと落とす（`Bearer …` の空白で切ると後半が残る）。
    .replace(/(authorization"?\s*[:=]\s*"?)[^"'\n,;}]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[\w\-._~+/=]+/gi, '$1[redacted]')
    .replace(/((?:api[-_]?key|apikey|access[-_]?token|token|password|passwd|secret)"?\s*[:=]\s*"?)[^\s"'&,;}]+/gi, '$1[redacted]');
}

/** 例外を1行の説明へ落とす。秘密値を伏せ、長さを切り詰める（`context` へ渡す用）。 */
export function describeError(error: unknown): string {
  const raw = error instanceof Error
    ? (error.name === 'Error' ? error.message : `${error.name}: ${error.message}`)
    : String(error);
  const text = redactSecrets(raw);
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH)}…` : text;
}

/**
 * 「握り潰した障害」を1行残す定型。空 catch から呼ぶ。
 *
 * ロガー自体が例外を投げても飲み込む。**ログを出すために業務が落ちては本末転倒**であり、
 * それではこの仕組みを入れた意味がなくなる。
 */
export function logSwallowed(logger: LoggerPort | undefined, message: string, error: unknown, context?: LogContext): void {
  if (logger === undefined) return;
  try {
    logger.warn(message, { ...context, reason: describeError(error) });
  } catch {
    // 出力先が壊れているときに何ができるわけでもない。ここだけは本当に握り潰す。
  }
}
