# v34 実装契約: Agent Runtime Harness（単一エージェントのランタイムハーネス）

> 参考: Microsoft Agent Framework `Microsoft.Agents.AI.Harness` の6機能（File memory / Todo provider / Compaction / Web search / Tool approval / Function invocation）を、agentblume の単一エージェント実行へ Agent 単位の opt-in 設定として移植する。
> **命名規約**: `Harness*` プレフィックスはマルチエージェント（`domain/harness/`）専用。本機能は **`AgentRuntimeHarness`**（Agentドメイン側）と命名し衝突を避ける。UI表示のみ「ハーネス」。
> 前提: v33まで完成・全green。外部SDKは追加しない。

## 0. 規約

strict / `noUncheckedIndexedAccess` / ESM / Zod v4 / Vitest / 非mutate / テスト同居 / depcruise 0違反 / 既存テストは純増分。

## 1. Domain

- `src/domain/agent/agent.ts`: `Agent.harness?: AgentRuntimeHarness`（6 boolean: `fileMemory` / `todoProvider` / `compaction` / `webSearch` / `toolApproval` / `functionInvocation`）。未指定 = 従来動作（後方互換）。`DEFAULT_AGENT_RUNTIME_HARNESS = { 全false, functionInvocation: true }`。serialization / API zod / DTO は6値必須のobject（部分指定は400）。
- `src/domain/run/run.ts`: `RunStatus` に `'waiting-approval'` を追加。`RunApprovalCheckpoint`（kind:'tool-approval'、`agentRef` / `messages: RunCheckpointMessage[]`（toolCalls含む全会話）/ `pendingCalls` / `executedToolRefs` / `budget残` / `step` / `sessionId?` / `expiresAt`(作成+24h) / `prompt`）を `RunRecord.checkpoint?` として waiting-approval 時のみ保持（serializationのrefineで強制）。遷移関数 `waitRunForApproval` / `resumeRunRecord` は Harness run と同じ規律。`RunTraceEvent` に `compaction` / `approval-requested` / `approval-resolved` を追加。
- domain は application の `ModelRequestMessage` を参照できないため、checkpoint メッセージは domain 側で構造定義し application 側で相互変換（`toCheckpointMessages` / `fromCheckpointMessages`。画像パーツは domain `'image'` ↔ application `'image_url'`）。

## 2. Application

- **`src/application/agent/runtime-harness.ts`**（新規）: 圧縮純関数 `compactModelMessages` と `AgentRuntimeHarnessRuntime`（ランタイム組み込みツール群。既存 `workspace_*` と同じ「ETLグラフではないランタイムツール」方式）。
  - `todos_add {items: string[1..10]}` / `todos_complete {indexes}`: Run内メモリ + セッションがあれば artifact `harness-todos`(kind:'json') に revision 保存（quota検査は `ToolOutputDispatcher.store()` と同順）。結果は毎回TODO全リスト。
  - `memory_list` / `memory_read {title}` / `memory_write {title, body}`: wikiId `agent-memory--<agentInternalId>`（`agentMemoryWikiId()`）の WikiPage を `createWikiPage` / `reviseWikiPage` で読み書き。WikiSpace は初回書き込み時に冪等自動作成。`fileMemory` 有効時は `buildWikiContext` の検索対象にも追加（自動想起）。
  - `web_search {query, maxResults?1..5}`: `WebSearchUseCase.fetch()`→`resolve()`。プロバイダは `catalog.list()` 先頭。プロバイダゼロならツール非注入。`RunAgentPreviewUseCase` 第14任意引数として DI。
  - 定数: `HARNESS_MAX_MODEL_ROUNDS=8` / `HARNESS_MAX_TOOL_CALLS=12`（`agent.harness` 定義時のみ。未定義は従来 5/4。ツリー共有 RunBudget 12/16 は不変）/ `HARNESS_COMPACTION_BUDGET_CHARS=24_000`。
- **`run-agent-preview.ts`**: `perform()` を `prepareLoop` / `runLoop` / `executeCalls` に分解し、`LoopState` を checkpoint から復元可能に（新規実行と再開が同一パス）。
  - `functionInvocation:false` → definitions を一切渡さず1往復（tool-calling capability 要求もスキップ。モデルがそれでもツールを呼んだら fail closed）。
  - `compaction:true` → 各往復前に文字数予算検査。超過時: 直近2件を除く tool メッセージを240字へ切り詰め → なお超過なら history 由来メッセージを古い順にペア削除。trace `compaction {beforeChars, afterChars}`。
  - **承認ゲート** = `harness.toolApproval && ctx.interactive && ctx.depth===0` かつ ETL Tool の `sideEffect !== 'read-only'`。発火時は予算減算前に trace `approval-requested` → checkpoint 生成 → `AgentRunPause` throw → `waitRunForApproval` 保存。ランタイムツール（todos_*/memory_*/web_search/workspace_*）と委譲（ask_*）は常に自動承認。
  - `interactive` は `POST /runs` のみ true。Harness / Factory / シナリオ検証は false（対話相手がいない実行での停止はデッドロックのため従来通り実行）。
  - `resumeSavedRun({scope, runId, decision:'approve'|'reject', feedback?})`: approve → pendingCalls を順次実行して継続（次の承認対象で再pause可）。reject → 各pendingCallへ tool結果 `{"approved":false,"reason":...}` を積み継続（モデルが代替案を出せる）。期限切れは failed 確定 + エラー。usage / trace は checkpoint 跨ぎで通算・連結。

## 3. API

- `saveAgentBodySchema` に `harness`。
- `POST /runs` 応答は従来 `{ run }` のまま、承認待ち時のみ `run.status:'waiting-approval'` + `run.checkpoint {prompt, expiresAt, tool, sideEffect}`（`response` にも prompt 同文）。
- `POST /runs/:runId/resume` body `{scope, decision:'approve'|'reject', feedback?(<=2000)}` → 応答は `POST /runs` と同形。404 / 422（承認待ちでない・期限切れ）/ 400。
- `GET /runs` / trace の checkpoint は公開サマリのみ（`messages` は返さない）。`?status=waiting-approval` で一覧可。

## 4. UI

- `AgentBuilder`: ヘッダ `save-actions` に「ハーネス」ボタン（設定済みは `ハーネス (N)`、N=true数）→ `HarnessSettingsDialog`（NodeConfigDialog型: draftローカル編集、Apply / Cancel / Clear(未設定に戻す)。チェックボックス6行、aria-labelは英語固定）。保存ペイロードは `...(harness !== undefined ? { harness } : {})`。
- `ChatPage` / `AgentInspectorPage`: `run.status==='waiting-approval'` 検出で承認バナー（`checkpoint.prompt` + 承認/拒否）→ `client.resumeRun()` → 応答は通常run応答と同経路（再承認待ちなら再表示）。
- `tool-api.ts`: `resumeRun(runId, scope, decision, feedback?, signal?)`。

## 5. 既知の制約（意図的）

- web_search のプロバイダは catalog 先頭固定（プロバイダ選択UIを出すなら `AgentRuntimeHarness` へのフィールド追加が必要）。
- `memory_read` 本文4000字 / `memory_list` 50件クリップ。
- TODO永続化はセッションquota超過で `SessionQuotaExceededError`（既存 `store()` と同挙動）。
- 再開後の compaction は履歴削除を行わない（tool結果切り詰めのみ）。保持期限の redaction 後は再開不可。
- 承認待ち中もチャット入力欄は開いたまま（新規メッセージは別Runを開始）。

## 6. 検証

全体 `npx vitest run` 204 files / **1723 passed**、`npm run typecheck` 0エラー、`npm run depcruise` 0違反（615 modules）。vitest は大文字ドライブ（`E:\`）で実行すること。
