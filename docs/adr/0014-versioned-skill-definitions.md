# ADR-0014: SkillをTool依存固定のversion付き集約として保存する

- Status: Accepted
- Date: 2026-07-03

## Context

Agent能力をsystem promptへ直接書くだけでは、責務・発火条件・依存Toolを再利用、version管理、レビューできない。Toolのlatestへ暗黙追従するとSkill versionの意味も変化する。

## Decision

- Skillを独立したpublishable aggregateとして保存する。
- Tool依存は保存済みSemVerへ固定する。
- Skill prompt草案はmetadataから決定的に生成し、LLM Providerへ依存させない。
- AgentへのSkill bindingは別Incrementで導入する。

## Consequences

- Skill単位の再利用、差分、監査が可能になる。
- Tool更新を取り込むには新しいSkill versionが必要になる。

## Implementation contract

[implementation/v12-skill-builder.md](../../implementation/v12-skill-builder.md) を単一の真実とする。
