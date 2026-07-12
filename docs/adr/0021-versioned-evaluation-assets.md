# ADR-0021: 評価入力と採点設定をSemVer資産として分離する

- Status: Accepted
- Date: 2026-07-10
- Context: [LLMOps実装計画](../../implementation/llmops-roadmap.md)、[Phase 4ロードマップ](../09-roadmap.md)

## Context

既存のScenario/ScenarioRunは1シナリオの実行履歴を、`POST /evaluations`は1応答の一時的な採点を扱う。候補Agentと基準Agentを再現可能に比較するには、実行から独立した評価入力集合と採点設定の固定参照が必要である。

## Decision

1. `EvaluationDataset`と`EvaluatorProfile`をtenant/workspace配下のSemVer資産として追加する。
2. Dataset caseは単発入力の`turn`と、既存Scenario版を参照する`scenario`の判別共用体とする。
3. EvaluatorProfileはIncrement 22ではMastraの決定的code scorer 4種だけを許可する。LLM-as-Judgeは後続Incrementで型を拡張する。
4. JSONは全case kindのstable export/import、CSVは`turn` caseだけを扱う。
5. importは保存せず、正規化済みcaseを返して利用者が確認後にDataset版として保存する。
6. Repository Portに対しInMemory/SQLiteの共有契約テストを適用する。

## Consequences

- 実験は`dataset@version`と`evaluatorProfile@version`を固定参照できる。
- Scenarioを複製せず、単発評価と複数ターン評価を同じDatasetに編成できる。
- CSVはscenario参照を表現しないため、scenario caseを含むDatasetのCSV exportは明示的に拒否する。
- 外部評価SDKやLLM Judgeはdomainへ漏れず、後続Adapterとして追加できる。

## Implementation

[implementation/v22-evaluation-assets.md](../../implementation/v22-evaluation-assets.md)を単一の実装契約とする。
