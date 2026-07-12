# v23 実装契約: 永続バッチ実験

> 前提: v22完成。[ADR-0022](../docs/adr/0022-persisted-batch-experiments.md)に従う。

## 1. Domain / Storage

- ExperimentはAgent/Dataset/Profileの固定SemVer、反復回数、model snapshot、進捗、状態、時刻を保持する。
- CaseResultはcase id/kind/repetition、Run参照、output、score、latency、usage、失敗を保持する。
- InMemory/SQLiteへ同じRepository contractを適用する。
- 起動時に永続したrunningをinterruptedへ変更する。

## 2. Application / Worker

- Create/Run/Cancel/Resume/Query use caseを追加する。
- InProcess workerは同時実行数1、同一Experimentの重複enqueueを拒否する。
- turnはRunAgentPreview、scenarioはRunScenarioを使う。
- timeout/一時ModelProviderErrorだけを最大2回retryする。
- resumeは既存case resultをskipする。

## 3. API / UI

- `POST /experiments`は202。
- list/detail/results/cancel/resume APIを提供する。
- ValidationにExperimentsタブを追加し、作成、進捗poll、結果、Run trace、cancel/resumeを提供する。

## 4. DoD

- 部分失敗、retry、cancel、interrupt/resume、重複防止をテストする。
- test/coverage/typecheck/depcruise/build/Playwrightがgreen。

## 5. 実装結果

- Status: Complete (2026-07-10)
- 122 test files / 856 tests green。
- coverage: statements 90.95%、branches 80.61%、functions 90.75%、lines 94.34%。
- typecheck / dependency-cruiser / production build / Playwright 4 tests green。
