# v35 実装契約: MCP クライアント（外部MCPサーバー接続とAgentからのツール利用）

> agentblume を MCP クライアントにする。接続設定は事実上の標準 `mcpServers` JSON（Claude Desktop 等）と**完全等価**で、UIのフォームタブとJSONタブが双方向に一致する。
> 依存追加: `@modelcontextprotocol/sdk@^1.29.0`（@mastra/core 経由で既に推移的依存にあったものを直接依存へ昇格）。SDKは adapters 層のみ（README原則5）。
> 前提: v34（Agent Runtime Harness）まで完成・全green。既存の `src/ui/mcp/McpPage.tsx` の「MCP公開」（サーバー側 fail-closed モック）は別機能としてそのまま残す。

## 0. 規約

strict / `noUncheckedIndexedAccess` / ESM / Zod v4 / Vitest / 非mutate / depcruise 0違反 / 既存テスト純増分。

## 1. Domain（`src/domain/mcp/`）

- `mcp-server.ts`: `McpServerConfig { scope, name, transport, disabled, updatedAt }`。`transport` は判別union — `{kind:'stdio', command, args[], env{}, cwd?}` | `{kind:'http', url, headers{}}`。name は 1..64 かつ `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/`。
- `mcp-servers-document.ts`: 標準ドキュメントとの相互変換。`command`→stdio / `url`→http（両方・どちらも無しはエラー）。省略キーは既定値へ、書き戻しは既定値キー省略・name昇順。**parse→to→parse ロスレス / to→parse→to 不動点**をテストで保証。
- `serialization.ts` / `errors.ts`（`McpValidationError` / `McpNotFoundError`）/ `mcp-server-repository.ts`（Port: save(upsert) / find / list / delete / replaceAll）。

## 2. Application（`src/application/mcp/`）

- `mcp-client.ts`（Port）: `McpClientPort { listTools(config) / callTool(config, toolName, args) → {content, isError} / close() }` + `McpClientError`（通信レベル障害のみ例外。ツール自身のエラーは `isError:true` でモデルへ返す）。
- ユースケース: Save / List / Delete / Replace（ドキュメント一括置換）/ Test（接続+listToolsを `{ok, tools?|error?}` に正規化、例外を投げない）。

## 3. Adapter（`src/adapters/mcp/sdk-mcp-client.ts` ほか）

- SDK: `Client`(`/client/index.js`) / `StdioClientTransport`+`getDefaultEnvironment`(`/client/stdio.js`) / `StreamableHTTPClientTransport`(`/client/streamableHttp.js`)。HTTPは streamable-http のみ（旧SSE非対応）。
- stdio env は `getDefaultEnvironment()` に設定envを重ねる（PATH引き継ぎ）。**Windowsでnpx系は `command:"cmd", args:["/c","npx",...]` が必要な場合がある**（設定側の責務、UIにヒント表示）。
- 接続プール: キー `${tenant}/${workspace}/${name}` + 設定sha256。不一致で張り直し、例外時は除去、アイドル5分スイープ（timerは`unref()`）。リクエストタイムアウト30秒。
- エラー正規化はサーバー名+操作名のみ。**env/headers の値はメッセージから伏せ字化**（二重防御）。callTool content は textブロック連結・非textはプレースホルダ・64KiBクリップ。
- テストは SDK の `InMemoryTransport` + `McpServer`（transport factory注入）+ stdio fixture の実プロセスsmoke。
- storage: `sqlite-mcp-server-repository.ts`（`mcp_servers` テーブル、PK `(tenant_id, workspace_id, name)`、JSON1列）/ in-memory / 共有契約テスト。

## 4. API（`src/api/mcp-routes.ts`）

- `GET /mcp-servers` → `{servers}` / `POST /mcp-servers` → 201 upsert / `PUT /mcp-servers`（mcpServersドキュメントで**全置換**、JSONタブApply用）→ `{servers}` / `DELETE /mcp-servers/:name?tenantId=&workspaceId=` → 204 / `POST /mcp-servers/:name/test` → **常に200** `{ok, tools?, error?}`。
- `McpValidationError`→400 / `McpNotFoundError`→404。composition/root で profile 分岐配線、`AppOptions.mcpServerRepository / mcpClient` でテスト注入可。

## 5. Agent統合（v34の実行ループへ）

- `Agent.mcpServers?: readonly string[]`（サーバーname、最大8・各1..64・重複禁止）。serialization / saveAgentBodySchema / DTO 対応。
- `src/application/agent/mcp-tools.ts`: Run開始時（prepareLoop）に解決。**未登録・disabled・listTools失敗・inputSchemaがobject以外のツールはスキップしRunは落とさない**。ツール名は `mangleMcpToolName`: `mcp__<server>__<tool>` → 不正文字`_`置換 → 64字切詰め → 衝突は数値サフィックス（既存ETL/ランタイム/ask_*名も予約集合）。
- 実行: `callTool` 結果をtool結果としてモデルへ（`isError:true` も内容のまま）。`McpClientError` は `MCP server '<name>' unavailable: ...` をtool結果にして継続。予算（tool calls）は通常ツールと同じ消費。trace は `tool-call`/`tool-result`（terminalId `'mcp'`）。
- **承認ゲート**: MCPツールは外部実行のため、`harness.toolApproval && interactive && depth===0` で承認対象（`sideEffect:'external-action'` 表示）。内蔵ランタイムツール（todos_*/memory_*/web_search/workspace_*）は従来どおり自動承認。再開（`resumeSavedRun`）は prepareLoop の同一経路で definitions を再構築（再接続不能なら明示エラーでRun失敗）。`functionInvocation:false` はMCPも含め全ツール非注入。

## 6. UI

- `McpPage`: 上部に「MCPクライアント（外部サーバー接続）」を新設（既存タブパターン `.validation-tabs`）。
  - **フォームタブ**: 一覧（name / transport要約 / disabledバッジ / テスト・編集・削除）+ 追加/編集フォーム（stdio/http radio、args・env・headers は1行1件textarea、Windowsヒント表示）。テストボタンはツール一覧をインライン表示。
  - **JSONタブ**: 保存済み状態から標準ドキュメントを生成した textarea + 「適用」（`PUT` 全置換、注意書きあり）。変換は `src/ui/mcp/mcp-config.ts` の純関数（バックエンドと同じ省略規約）で、フォーム⇔JSONの表示が往復で一致する。
- `AgentBuilder`: Wikis の下に「MCPサーバー」チェックリスト（最大8件、disabledは「実行時はスキップ」表示、0件時はMCP画面への誘導）。保存/復元/リセット対応（**既存Agent再保存でmcpServersが落ちる問題もここで解消**）。
- `tool-api.ts`: `listMcpServers` / `saveMcpServer` / `replaceMcpServers` / `deleteMcpServer` / `testMcpServer`。

## 7. 既知の制約（意図的）

- HTTPトランスポートは streamable-http のみ。プロバイダ横断の認可・OAuthフローは未対応（headersに静的トークンを書く方式）。
- env/headers はSQLiteに平文保存（ローカル・シングルユーザー前提）。エラーメッセージへは伏せ字化して出さない。
- フォームの env/headers textarea は区切り(`=`/`:`)の無い行を黙って無視（純関数テストで固定）。
- name のUI事前検証なし（サーバー400をそのまま表示）。

## 8. 検証

全体 `npx vitest run` 214 files / **1862 passed**、`npm run typecheck` 0エラー、`npm run depcruise` 0違反（650 modules）。vitest は大文字ドライブ（`E:\`）で実行。
