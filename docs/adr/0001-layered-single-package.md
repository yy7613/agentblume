# ADR-0001: レイヤードモノリス（単一パッケージ + 層フォルダ）を採用する

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/05-dependency-graph.md](../05-dependency-graph.md)

## Context

[05-dependency-graph.md](../05-dependency-graph.md) は `@app/domain` / `@app/application` / `@app/adapter-*` などの**複数パッケージ**構成を理想として描いている。一方でv1（[README §7](../README.md)）は「ローカル縦切り一本」を完成させることが目的で、npm workspaces のビルド・公開・バージョニング運用を先に導入すると、機能を出す前にツーリングコストが先行する。

## Decision

v1は**単一パッケージ**とし、レイヤ境界を**フォルダ**で表現する。

```
src/
  domain/        # SDK非依存の中核（エンティティ・値オブジェクト・Port定義）
  application/   # ユースケース（Portインターフェースにのみ依存）
  adapters/      # 外部SDK実装（Phase 2以降で拡充）
  composition/   # Composition Root（DI）
```

境界は **dependency-cruiser** で機械的に強制する（`domain` は `application`/`adapters` を import 不可 等）。将来パッケージ分割が必要になった時点で、フォルダ境界をそのまま `packages/*` へ引き上げる。

## Consequences

- ✅ v1をすぐ実装開始できる。ビルドは `tsc` 1回、テストは `vitest` 1回。
- ✅ 依存方向は [05-dependency-graph.md](../05-dependency-graph.md) のルール表と同一。lintで担保。
- ⚠️ パッケージ単位の独立公開はできない（v1では不要）。分割は将来のADRで扱う。

## Alternatives considered

- **npm workspaces（複数パッケージ）**: 理想形だが現時点は過剰。境界はlintで代替できる。
- **層を分けないフラット構成**: SOLID/依存逆転（[docs/01](../01-architecture.md)）を機械強制できず却下。
