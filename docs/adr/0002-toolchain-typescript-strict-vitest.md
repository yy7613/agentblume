# ADR-0002: TypeScript(strict) + ESM + Vitest + Zod をツールチェーンとする

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/02-tech-stack.md](../02-tech-stack.md)

## Context

[02-tech-stack.md](../02-tech-stack.md) で **TypeScript + Node.js（🔶採用決定）**、**Zod（✅）**、**Vitest + カバレッジ計測（🔶）** が確定した。v1実装の言語・テスト・検証ライブラリを固定する。

## Decision

- **言語**: TypeScript、`strict: true`。`moduleResolution: "Bundler"`（拡張子なし相対import）。
- **モジュール**: ESM（`"type": "module"`）。実行は `tsx`、テストは `vitest`。
- **テスト**: **Vitest**。テストは実装と同居（`*.test.ts`）。カバレッジは `@vitest/coverage-v8`。ドメイン層・アプリ層は行カバレッジ90%以上を目標。
- **スキーマ/設定検証**: **Zod**。ETLノードの `config` 検証と、将来のInput/Output Schema検証に用いる（[02 §Zod と JSON Schema の使い分け](../02-tech-stack.md)）。
- **依存境界の強制**: **dependency-cruiser**。`domain → application/adapters` 禁止などを CI 相当のスクリプトで検査（[ADR-0001](./0001-layered-single-package.md)）。

## Consequences

- ✅ 外部ランタイム依存なしでドメイン/アプリ層を単体テストできる。
- ✅ Zodにより `config` の不正を実行前に型安全に弾ける（即時バリデーション原則, [docs/README §4](../README.md)）。
- ⚠️ `tsc` によるESM emit の拡張子問題を避けるため、成果物実行は `tsx`/`vitest` のリゾルバに委ねる。`build` は当面 `tsc --noEmit` の型検査に限定する。

## Alternatives considered

- **Jest**: 設定・ESM対応コストが高い。Vitestが仕様の指定に合致。
- **手書きバリデーション**: Zodが採用済みで、JSON Schema相互変換も見据えられるため却下。
