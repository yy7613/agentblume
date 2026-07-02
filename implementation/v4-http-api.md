# v4 実装契約: HTTP API層（Fastify駆動アダプター + serverエントリポイント）

> 本書は Increment 4（[ADR-0006](../docs/adr/0006-http-api-fastify.md)）の**単一の真実**。
> 前提: Increment 1〜3 完成（326テストgreen、use case群 + Composition Root あり）。
> 参照: [04-api-spec.md §3](../docs/04-api-spec.md) / [01-architecture.md §2](../docs/01-architecture.md)

## 0. 規約（従来どおり + api固有）
TypeScript strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4 / Vitest v4 / **Fastify v5**（導入済み）。設定ファイルは編集済み・編集禁止。
- **api本体**（`src/api/*.ts`、テスト除く）は `adapters`/`composition` を import しない（use case 注入）。depcruiseルール追加済み。
- **apiテスト**（`src/api/*.test.ts`）は `composition` の `createApp({profile:'test'})` を使ってよい（配線のため。例外として許可済み）。
- ドメインのエラー型はそのまま伝播させ、api層のエラーマッパーでHTTPステータスへ変換する。

## 1. ディレクトリ
```
src/api/
  error-mapping.ts     error-mapping.test.ts   ドメインエラー→HTTPステータス/ボディ
  schemas.ts                                    リクエストZodスキーマ（Body/Query）
  tool-routes.ts       tool-routes.test.ts      /tools ルート登録
  server.ts            server.test.ts           buildServer（Fastifyインスタンス組み立て）
src/server.ts                                    エントリポイント（composition + api + listen）
```

## 2. `src/api/error-mapping.ts`
```typescript
export interface HttpError { readonly status: number; readonly body: { error: { code: string; message: string } } }
export function toHttpError(err: unknown): HttpError;
```
マッピング（instanceof 判定・順序に注意: 具象クラス優先）:
| 例外 | status | code |
|---|---|---|
| `ToolNotFoundError` | 404 | `TOOL_NOT_FOUND` |
| `VersionConflictError` | 409 | `TOOL_VERSION_CONFLICT` |
| `ToolValidationError` | 400 | `TOOL_VALIDATION` |
| `GraphError` | 422 | `ETL_GRAPH` |
| `ConfigError` | 422 | `ETL_CONFIG` |
| `SchemaError` | 422 | `ETL_SCHEMA` |
| Zod検証失敗（api層で `BadRequestError` に変換） | 400 | `BAD_REQUEST` |
| その他 | 500 | `INTERNAL` |
- `code` は例外の `code` プロパティがあればそれを使い、message は例外message（500のみ固定文言 `'internal error'`、詳細を漏らさない）。
- `BadRequestError`（api層ローカルの小さなError派生、`code:'BAD_REQUEST'`）も本ファイルで定義・export。

## 3. `src/api/schemas.ts`（Zod）
```typescript
export const tenantScopeSchema; // { tenantId: string(min1), workspaceId: string(min1) }
export const saveToolBodySchema; // §4 POST /tools の body
export const previewBodySchema;  // { scope, version?: string(semver形式), rowLimit?: number(int, 1..10000) }
export const versionQuerySchema; // { tenantId, workspaceId, version?: string }
```
- graph は `{ nodes: array({id:string, type:string, config: unknown}), edges: array({from:string, to:string, toInput?: number}) }` として構造だけ検証（configの中身はノードの `validateConfig` に委ねる）。
- `version` 文字列は `SemVer.parse` を try し、失敗は `BadRequestError`。

## 4. ルート — `src/api/tool-routes.ts`
```typescript
import type { FastifyInstance } from 'fastify';
export interface ToolRouteDeps {
  saveTool: SaveToolUseCase;
  getTool: GetToolUseCase;
  listToolVersions: ListToolVersionsUseCase;
  previewTool: PreviewToolUseCase;
}
export function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): void;
```

| メソッド/パス | 入力 | 処理 | 成功レスポンス |
|---|---|---|---|
| `POST /tools` | body: `{ scope, internalId, workingName, displayName, publishName, owner, sideEffect, graph, inputSchema?, outputSchema?, bump?, state? }` | `saveTool.execute` | **201** `{ tool: SerializedTool }` |
| `GET /tools/:internalId` | query: `tenantId, workspaceId, version?` | version有→`getTool.version` / 無→`getTool.latest` | 200 `{ tool: SerializedTool }` |
| `GET /tools/:internalId/versions` | query: `tenantId, workspaceId` | `listToolVersions.execute` | 200 `{ versions: string[] }`（昇順・文字列化） |
| `POST /tools/:internalId/infer-schema` | body: `{ scope, version? }` | `previewTool.inspect` | 200 `{ tool: SerializedTool, propagation: PropagationResult }` |
| `POST /tools/:internalId/preview` | body: `{ scope, version?, rowLimit? }` | `previewTool.preview` | 200 `{ tool: SerializedTool, result: PreviewResult }` |

- レスポンスの Tool は必ず `serializeTool`。`versions` は `SemVer.toString()` の配列。
- `PreviewResult` 内の `Table.rows` の `Date` セルは `JSON.stringify` で ISO 文字列になる（許容・そのまま）。
- ハンドラは try/catch で `toHttpError` に集約（Fastify の `setErrorHandler` を server.ts 側で設定してもよい。どちらかに統一）。

## 5. `src/api/server.ts`
```typescript
import Fastify, { FastifyInstance } from 'fastify';
export function buildServer(deps: ToolRouteDeps, options?: { logger?: boolean }): FastifyInstance;
```
- `Fastify({ logger: options?.logger ?? false })` → `setErrorHandler`（`toHttpError` 使用）→ `registerToolRoutes` → `GET /health` = 200 `{ status: 'ok' }` を追加 → return（listenしない）。

## 6. エントリポイント `src/server.ts`
- `createApp()`（env駆動）→ `buildServer(app, { logger: true })` → `listen({ port: Number(env.AGENTCONTEXT_PORT ?? 3030), host: '127.0.0.1' })`。
- SIGINT/SIGTERM で `server.close()` + `app.close()`。起動ログにprofile/portを出す。
- 実行: `npm run serve`（package.json 追加済み）。

## 7. テスト（`fastify.inject()`、実HTTPポート不使用）
- `error-mapping.test.ts`: 各例外→status/code の全マッピング + 未知例外→500（messageが'internal error'固定）。
- `tool-routes.test.ts`: `createApp({profile:'test'})` + `buildServer` で:
  - POST /tools → 201、SerializedToolのversion==='1.0.0'。再POST→'1.0.1'。
  - 不正body（scope欠落）→400 BAD_REQUEST。グラフに存在しない列select→400 TOOL_VALIDATION。未知ノードtype→422 ETL_GRAPH。
  - GET /tools/:id（latest / version指定 / 未存在→404 / 不正version文字列→400）。
  - GET /tools/:id/versions → 昇順文字列配列（未存在→200 `{versions: []}`）。
  - POST /tools/:id/infer-schema → propagation（order/nodes/hasErrors）を含む200。
  - POST /tools/:id/preview → result.output.rows 期待値、rowLimit=1 で truncated、version固定で旧グラフ結果。
  - テナント分離: 別scopeから404。
- `server.test.ts`: /health 200、setErrorHandler経由の404マッピング（ルート未登録パス→Fastify標準404はそのまま/またはマッピング仕様を明記）、buildServerがlistenしないこと（injectのみで完結）。

## 8. 完了条件（DoD）
- [ ] `npx tsc --noEmit` エラー0
- [ ] `npx vitest run` 全green（既存326 + 新規）
- [ ] `npx vitest run --coverage` 閾値クリア
- [ ] `npx depcruise src --config .dependency-cruiser.cjs` 違反0（api新ルール含む）
- [ ] `npm run serve` が起動し、`/health` と `POST /tools`→`POST /tools/:id/preview` の実HTTP縦切りが通る（統合時に親が実施）
