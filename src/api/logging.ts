/**
 * api層: Fastify（pino）のログ設定 — レベルと**機微情報のマスク**。
 *
 * ## なぜ必要か
 *
 * `buildServer` は長らく `logger: options?.logger ?? false` だけで、有効時は pino の素の既定
 * （level=info・redact なし）が使われていた。ログは平文ファイル・標準出力へ出て、
 * 収集基盤へそのまま流れる。`docs/08-security-auth.md` §5 は「秘密情報・個人情報はマスキングする」
 * を最低要件に挙げているが、その配線がどこにも無かった。
 *
 * ## どこが実際に危ないのか
 *
 * Fastify の**既定の `req` シリアライザはヘッダもボディも出力しない**（method / url / host /
 * remoteAddress だけ）。つまり素の状態で `Authorization` が漏れるわけではない。危ないのは
 *
 * - 自前の `server.log.info({ ...context }, msg)`（`LoggerPort` の橋渡し経由を含む）に
 *   `apiKey` / `token` の類が混ざる
 * - 障害調査でヘッダやボディを一時的にログへ出す
 *
 * といった「その場では正しく見える」変更で、**設定が無ければ静かに全部出る**。
 * そこで redact を**先に**置いておき、後から何を足しても既知の名前は伏せ字になるようにする。
 * `redact` はロガー生成時にしか渡せない（fast-redact がパスを事前コンパイルする）ので、
 * 「必要になってから足す」ができない設定でもある。
 *
 * ## 何を守らないか
 *
 * ここが伏せるのは**キー名で判別できるもの**だけ。値の形（JWTらしき文字列など）では判定しない。
 * 例外メッセージの中に埋め込まれた秘密値は `application/operations/logger` の
 * `redactSecrets()` が正規表現で落とす。役割が違うので両方要る。
 */
import type { FastifyServerOptions } from 'fastify';
import type { LogLevel } from '../config/environment';

/** 伏せ字。値の長さも漏らさないよう固定文字列にする。 */
export const LOG_REDACT_CENSOR = '[redacted]';

/**
 * pino の `redact.paths`。
 *
 * 3つの層を押さえる。
 *
 * 1. **ヘッダ** — `req.headers.*` / `headers.*` の両方。前者は `{ req }` を出したとき、
 *    後者は `request.headers` を直接ログへ渡したときに効く。
 * 2. **リクエストボディ** — カスタムシリアライザや調査目的で `req.body` を出したとき。
 * 3. **任意のログcontext** — `server.log.info({ apiKey }, …)` のような直書き。
 *    深さ1（トップレベル）と深さ2（`*.apiKey`）を張る。fast-redact のワイルドカードは
 *    1階層ぶんしか跨がないため、`{ a: { b: { token } } }` までは追わない
 *    （それ以上は「そもそも秘密値を context に入れない」呼び出し側の責務）。
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  // 1. ヘッダ
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["proxy-authorization"]',
  'req.headers["x-api-key"]',
  'req.headers["x-auth-token"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["proxy-authorization"]',
  'headers["x-api-key"]',
  'headers["x-auth-token"]',
  // 2. リクエストボディ
  'req.body.apiKey',
  'req.body.password',
  'req.body.token',
  'req.body.secret',
  'req.body.accessToken',
  'req.body.refreshToken',
  'req.body.authorization',
  'body.apiKey',
  'body.password',
  'body.token',
  'body.secret',
  // 3. 任意のログcontext（深さ1）
  'apiKey',
  'api_key',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'secretValue',
  'authorization',
  // 3. 任意のログcontext（深さ2）
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.secretValue',
  '*.authorization',
];

/**
 * pino へ渡すロガー設定を組み立てる。
 *
 * リクエストIDは設定不要。Fastify が**リクエストごとに `logger.child({ reqId })` を作る**ため、
 * `request.log.*` と自動の「incoming request / request completed」には既に `reqId` が載っている
 * （`logging.test.ts` で固定してある）。Run実行のログを相関させたい場合は、この `reqId` を
 * ハンドラから `LoggerPort` の context へ渡せばよい。
 */
export function loggerOptions(level: LogLevel): Exclude<FastifyServerOptions['logger'], boolean | undefined> {
  return {
    level,
    redact: { paths: [...LOG_REDACT_PATHS], censor: LOG_REDACT_CENSOR },
  };
}
