# v7 実装契約: Run / Trace 永続化と Status

> Increment 7 の単一の真実。Increment 6 の未コミット変更を前提に継続する。

## 1. 目的

Agent previewの成功・失敗を同じ `runId` で永続化し、後からHTTPとStatus画面でTool選択、引数、各ノード出力、モデル応答、エラーを追跡できるようにする。

## 2. Run record

- status: `running | succeeded | failed`。
- scope、mode、Tool internalId/version/publishName、開始/完了時刻、response、usage、failure、traceを保持する。
- trace event: `model-request | tool-call | tool-result | model-response | error`。
- tool-resultは各nodeの行数・truncatedと終端出力の最大10行previewを保持する。
- `password / secret / token / api-key / authorization` に一致するkeyの値は永続化前に `[REDACTED]` へ置換する。
- 実行開始時にrunningを保存し、成功/捕捉可能な失敗で終端statusへupsertする。

## 3. Repository

- domain所有の `RunRepository` Portを定義する。
- `save(record)`、`find(scope, runId)`、`list(scope, {limit,status})` を提供する。
- InMemoryとSQLiteへ同じ契約テストを適用する。
- SQLiteはToolと同じDB path内の独立 `runs` tableを使う。

## 4. Error correlation

- 実行失敗は元のHTTP status/codeを維持し、error bodyへ `runId` を追加する。
- unknown errorの詳細は従来どおり秘匿する。
- UIは失敗時の `runId` を表示し、保存済みtraceを取得できる。

## 5. HTTP / UI

- `GET /runs?tenantId&workspaceId&limit?&status?` → run summary一覧。
- `GET /runs/:runId/trace?tenantId&workspaceId` → 保存済みrun record。
- Statusナビを有効化し、一覧・status・Tool version・時刻・trace詳細を表示する。
- Tool Builder内Agent Chatは成功/失敗のrunIdをStatus導線として表示する。

## 6. 完了条件

- domain transition / serialization / sanitization tests。
- InMemory / SQLite repository contract tests。
- 成功、provider失敗、引数失敗の永続化とerror correlation tests。
- list / trace API、scope分離、Status UI tests。
- typecheck、全test、coverage、depcruise、production build、実HTTP smokeが成功する。
