import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // node:sqlite（組込み・実験的）を各テストワーカーで有効化する（ADR-0004）
    pool: 'forks',
    execArgv: ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'],
    // 既定の 5 秒は、357 ファイルを並列実行する本リポジトリでは重い UI テストが偶発的に超える
    // （単体では通るのに全体実行でだけ落ちる偽陽性が続いた）。ハングは 20 秒で十分捕まえられる。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // *.contract.ts / *.fixtures.ts は共有テストスイート・フィクスチャ（テストコード）なので計測対象外
      // エントリポイント（import した時点で実行され、process.argv / exitCode を触る）は計測対象外。
      // 中身のロジックは application / adapters 側のテストが持つ。
      exclude: ['src/**/*.test.ts', 'src/**/*.contract.ts', 'src/**/*.fixtures.ts', 'src/demo.ts', 'src/server.ts', 'src/llmops-gate.ts', 'src/backup-cli.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
