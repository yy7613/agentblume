import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    // node:sqlite（組込み・実験的）を各テストワーカーで有効化する（ADR-0004）
    pool: 'forks',
    execArgv: ['--experimental-sqlite', '--disable-warning=ExperimentalWarning'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // *.contract.ts / *.fixtures.ts は共有テストスイート・フィクスチャ（テストコード）なので計測対象外
      exclude: ['src/**/*.test.ts', 'src/**/*.contract.ts', 'src/**/*.fixtures.ts', 'src/demo.ts', 'src/server.ts', 'src/llmops-gate.ts', 'src/**/index.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 80,
      },
    },
  },
});
