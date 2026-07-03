# ADR-0010: Agent定義をバージョン固定Tool参照として保存する

- Status: Accepted
- Date: 2026-07-03

## Context

Increment 6のAgent previewはsystem promptとTool参照をリクエストごとに渡しており、再現可能なAgent定義として保存できなかった。また、Toolのlatestへ暗黙追従すると、同じAgent versionでも実行契約が変化する。

## Decision

- AgentをToolと同じ共通メタデータ・SemVer・tenant/workspace境界を持つ集約として保存する。
- Agent内のTool参照はinternalIdとSemVerを必須とし、保存時に存在を検証する。
- system prompt草案はToolの公開メタデータと入出力から決定的に生成し、LLM Providerへ依存させない。
- 生成結果は保存せず、UIでレビュー・編集したsystem promptだけをAgent versionへ保存する。
- Skill参照、structured output、複数Tool実行は後続の独立Incrementとする。

## Consequences

- Agent versionから参照Tool versionまで追跡でき、再生成と監査が容易になる。
- Tool更新をAgentへ反映するには、新しいAgent versionを明示保存する必要がある。
- 草案品質は決定的テンプレートの範囲に限定されるが、モデル可用性に左右されずテスト可能になる。

## Implementation contract

[implementation/v8-agent-builder.md](../../implementation/v8-agent-builder.md) を単一の真実とする。
