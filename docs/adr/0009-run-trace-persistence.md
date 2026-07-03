# ADR-0009: Run traceを専用Portで永続化する

- Status: Accepted
- Date: 2026-07-03
- Context doc: [04-api-spec.md](../04-api-spec.md), [07-execution-model.md](../07-execution-model.md)

## Context

Increment 6のtraceは成功した `POST /runs` response内にしか存在せず、provider・引数・ETLエラー時には途中経過と相関IDを失う。代表ジャーニー⑥と `GET /runs/{id}/trace` を成立させるには、Tool定義とは寿命・更新規則が異なるRun専用の永続境界が必要である。

## Decision

- domainに `RunRecord` と `RunRepository` Portを置き、InMemory/SQLite adapterへ同じ契約テストを適用する。
- Agent実行開始時にrunning、終了時にsucceeded/failedをupsertする。
- 失敗例外を `RunFailedError` で相関し、元のHTTP mappingへ `runId` だけを追加する。
- 永続traceは最小化したnode summaryと最大10行previewにし、secret-like keyをmaskする。
- Status画面はREST APIだけを使い、backend内部型へ依存しない。

## Consequences

- 成功/失敗を同じrunIdで後追いできる。
- process crash時も開始済みrunはrunningとして残り、stale run検出の足場になる。
- OpenTelemetry export、監査Sink、retention、pagingは後続Incrementで追加する。

## 実装契約

[implementation/v7-run-trace-persistence.md](../../implementation/v7-run-trace-persistence.md) を単一の真実とする。
