# ADR-0005: Composition Root と env プロファイル切替を導入する

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/01-architecture.md §5](../01-architecture.md), [docs/02-tech-stack.md §5](../02-tech-stack.md)

## Context

Increment 2 でユースケースとアダプタ（InMemory / SQLite）が揃ったが、組み立て（どのアダプタを注入するか）が存在せず、demo も生のエンジンを直接組んでいる。[01 §5](../01-architecture.md) は「Adapterの選択・初期化は Composition Root ただ1箇所に集約」、[02 §5](../02-tech-stack.md) は `local`（SQLite）/ `test`（InMemory）プロファイルを規定する。

## Decision

- `src/composition/root.ts` に **`createApp(options)`** を実装する。プロファイル `'local' | 'test'` を受け取り（既定は env `AGENTCONTEXT_PROFILE`、無指定は `'local'`）、リポジトリ（local→`SqliteToolRepository`（パスは `AGENTCONTEXT_DB_PATH` または `:memory:`）、test→`InMemoryToolRepository`）・`EtlEngine`・全ユースケースを配線した **App オブジェクト** を返す。`close()` で保有リソースを解放する。
- **PreviewToolUseCase**（`src/application/tool/preview-tool.ts`）を追加し、「保存済みToolをidで取得→スキーマ点検/プレビュー実行」を提供する。これでジャーニーの保存(⑦)→実行(③⑥)が縦につながる。
- demo は Composition Root 経由の縦切り（保存→バージョン→取得→プレビュー）に書き換える。実行は `node --experimental-sqlite --import tsx`（検証済み）。
- 依存ルール: `composition` のみが adapters と application の両方を import できる。`demo.ts` は composition 経由でのみアプリを得る。dependency-cruiser に「composition を import できるのはルート（demo）だけ」「adapters を import できるのは composition と adapters 自身だけ」を追加する。

## Consequences

- ✅ プロファイル切替が1箇所に集約され、[02 §5](../02-tech-stack.md) の `local`/`test` を実運用できる。
- ✅ demo が v1ジャーニー7ステップの縦切り実証になる。
- ⚠️ UI/HTTP API は未着手（次インクリメント以降）。App オブジェクトがその足場になる。

## 実装契約

[implementation/v3-preview-composition.md](../../implementation/v3-preview-composition.md) を単一の真実とする。
