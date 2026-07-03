# ADR-0013: Structured OutputをProviderとアプリ境界の両方で検証する

- Status: Accepted
- Date: 2026-07-03

## Context

ProviderのJSON Schema制約はモデルやbackend実装によって対応差があり、返却内容をそのまま信頼すると型安全な境界にならない。一方、任意JSON SchemaをGUIで完全に扱うのはv1の範囲を超える。

## Decision

- v1はobject直下のprimitive fieldへschema機能を限定する。
- schemaをOpenAI互換response_formatとしてProviderへ渡す。
- 最終contentをアプリケーション側でもJSON parse・型検証する。
- Providerがstructured-output capabilityを宣言しない場合はfail closedとする。
- 検証済みobjectをRunへ保存する。

## Consequences

- モデル実装に依存せず、プログラム境界で構造を保証できる。
- nested objectやarrayを必要とするAgentは後続schema editor拡張まで表現できない。

## Implementation contract

[implementation/v11-structured-output.md](../../implementation/v11-structured-output.md) を単一の真実とする。
