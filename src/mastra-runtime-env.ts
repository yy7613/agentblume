/**
 * 副作用専用モジュール: `@mastra/*` を読み込む**前**に決めておく必要のある環境変数だけを設定する。
 *
 * なぜ独立したモジュールなのか:
 * ESM の import は本体コードより先に、しかも**記述順**で評価される。つまり
 *
 *   import { X } from '@mastra/core/llm';
 *   process.env['MASTRA_OFFLINE'] ??= '1';   // ← @mastra/core の評価より後
 *
 * と書いても、env を立てる頃には `@mastra/core` のトップレベル評価が終わっている。
 * 現状の Mastra はこれらを遅延評価しているため結果的に効いているが、それは保証ではない。
 * 「env を立てるだけのモジュール」を作り、それを**最初の import** に置くことで
 * 評価順を言語仕様として固定する。
 *
 * 使い方（import順が意味を持つ。並べ替え禁止）:
 *   import './mastra-runtime-env';        // 必ず最初
 *   import { ... } from '@mastra/core/...';
 *
 * 読み込むのは各エントリポイント（src/server.ts・src/demo.ts・src/llmops-gate.ts）と
 * Mastra を直接使うアダプタ。多重 import は ESM のモジュールキャッシュで1回に畳まれる。
 */

// @mastra 同梱の posthog テレメトリを無効化する（オフラインファースト・外部送信抑止）。
process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true';
// モデル登録簿の動的取得（ネットワーク）も止める。登録簿はパッケージ同梱の静的JSONだけを使う。
process.env['MASTRA_OFFLINE'] ??= '1';

export {};
