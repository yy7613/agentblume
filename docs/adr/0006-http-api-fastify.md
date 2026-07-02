# ADR-0006: HTTP API層を Fastify の駆動アダプターとして実装する

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/04-api-spec.md](../04-api-spec.md), [docs/01-architecture.md §2](../01-architecture.md)

## Context

Increment 3 まででユースケースと Composition Root が揃った。UI接続と外部利用（[04-api-spec.md §3](../04-api-spec.md) の REST API）のため、HTTPの駆動アダプター（Driving Adapter）が要る。[02-tech-stack.md](../02-tech-stack.md) は APIスタイルとして「REST or tRPC」を提案（🔶）していた。

## Decision

- **REST + Fastify v5** を採用する。理由: 型付きの成熟したHTTPフレームワーク、`inject()` によるポート不要のハンドラテスト、スキーマ検証との親和性。tRPCはUI実装言語が確定してから再検討。
- 配置は **`src/api/`（駆動アダプター層）**。ルートは **use case を引数に受け取る登録関数** として実装し、Fastify への依存を `src/api/` に閉じる。ドメイン・アプリ層は Fastify を import しない。
- リクエスト検証は **Zod**（Body/Query を parse し、失敗は 400）。レスポンスの Tool は既存の `serializeTool` を使う。
- **エラーマッピング**を一元化する: `ToolValidationError`→400 / `GraphError`→422 / `ToolNotFoundError`→404 / `VersionConflictError`→409 / その他→500。エラーボディは `{ error: { code, message } }`。
- エントリポイント **`src/server.ts`** が `createApp()`（composition）+ `buildServer()`（api）+ listen を担う。ポートは `AGENTCONTEXT_PORT`（既定 3030）。
- v1のためテナントスコープは **リクエストで明示**（body / query の `tenantId`/`workspaceId`）。認証・認可は Phase 2（[docs/08](../08-security-auth.md)）で `AuthenticationProvider` を挿す前提の構造とする。

## Consequences

- ✅ UIやcurlから保存・点検・プレビューの縦切りをHTTPで実行できる。
- ✅ ルート登録関数は use case 注入型のため、`fastify.inject()` + `test` プロファイルで外部プロセスなしにテスト可能。
- ⚠️ 認証なしの未保護APIである（ローカル開発専用）。公開前に [docs/08](../08-security-auth.md) の最低要件を満たすこと（未認証公開を既定にしない）。
- ⚠️ depcruise に api 層ルールを追加: `domain`/`application`/`adapters` から `api` の import 禁止、`api` から `adapters`/`composition` の import 禁止（use case 注入で受ける）。

## 実装契約

[implementation/v4-http-api.md](../../implementation/v4-http-api.md) を単一の真実とする。
