/**
 * サーバー(API)の本番ビルド設定 — `npm run build:server` が使う。
 *
 * ## なぜ tsc の emit ではなくバンドラなのか
 *
 * このリポジトリは相対 import を**拡張子なし**で書いている（`import { buildServer } from './api/server'`）。
 * tsc は import 指定子を書き換えないため、`noEmit` を外して JS を出しても
 * Node の ESM ローダーが `./api/server` を解決できず（`ERR_MODULE_NOT_FOUND`）起動できない。
 * 全ソースへ `.js` を足す変更は現在の並行作業と衝突するので採らない。
 * そこで **既存 devDependency の vite（SSR ビルド）** で解決済みの相対パスへ書き換える。新規依存はゼロ。
 *
 * ## なぜ preserveModules なのか（1ファイルにまとめない理由）
 *
 * `src/mastra-runtime-env.ts` は「`@mastra/*` を読み込む前に env を立てる」ための副作用専用モジュールで、
 * 各エントリポイントの**最初の import** に置くことで評価順を ESM の言語仕様として固定している。
 * 単一チャンクへインライン化すると、その本体コードはバンドルの本体（= 全 import の評価後）へ移動し、
 * `import '@mastra/core'` の方が先に評価されてしまう。
 * `preserveModules` はモジュール構造をそのまま保つため、import 宣言の**記述順 = 評価順**という前提が壊れない。
 *
 * 依存パッケージ（package.json の dependencies）は vite の SSR ビルドが既定で external にするため
 * バンドルへ取り込まれない。node_modules は本番でもそのまま必要。
 */
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    ssr: 'src/server.ts',
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    // 本番の stack trace を読めるようにする（source map 付き・minify なし）。
    minify: false,
    sourcemap: true,
    rollupOptions: {
      output: {
        format: 'esm',
        preserveModules: true,
        preserveModulesRoot: 'src',
        entryFileNames: '[name].js',
      },
    },
  },
});
