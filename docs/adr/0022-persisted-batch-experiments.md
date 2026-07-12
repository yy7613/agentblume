# ADR-0022: バッチ評価を永続状態機械とローカルworkerで実行する

- Status: Accepted
- Date: 2026-07-10
- Context: [LLMOps実装計画](../../implementation/llmops-roadmap.md)、[ADR-0021](./0021-versioned-evaluation-assets.md)

## Context

Dataset/Profileは版管理できるが、複数ケースのAgent実行と採点はまだ一時的である。ローカルLLMでは実行に時間がかかり、ケース失敗、取消、プロセス再起動でも完了済み結果を保持する必要がある。

## Decision

1. `Experiment`と`ExperimentCaseResult`を独立した永続集約として追加する。
2. Experimentは`queued/running/completed/failed/cancelled/interrupted`の明示状態機械を持つ。
3. ローカルでは同時実行数1の`InProcessExperimentWorker`を使い、APIは作成後すぐ`202`を返す。
4. turn caseは既存Agent Run、scenario caseは既存ScenarioRunを再利用する。
5. ケース失敗を保存して次へ進み、全ケースを処理できた実験は`completed`とする。
6. providerのtimeout/一時障害だけを最大2回再試行する。
7. 起動時に残った`running`は`interrupted`へ変更し、resumeでは保存済みcase resultを再実行しない。

## Consequences

- 外部queueなしでもローカルIDEで進捗と途中結果を失わない。
- workerはPortなのでチーム運用時に外部queueへ交換できる。
- scenario実行は既存契約が内部例外を`status:error`へ正規化するため、v23ではscenario caseの自動retryは行わない。

## Implementation

[implementation/v23-persisted-experiments.md](../../implementation/v23-persisted-experiments.md)を単一の実装契約とする。
