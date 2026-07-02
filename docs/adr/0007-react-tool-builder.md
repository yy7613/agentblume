# ADR-0007: Tool Builder を React と React Flow で実装する

- Status: Accepted
- Date: 2026-07-02
- Context doc: [06-etl-tool-builder.md](../06-etl-tool-builder.md), [07-execution-model.md](../07-execution-model.md)

## Context

Increment 4 で保存済み Tool の保存・取得・スキーマ点検・プレビューが HTTP から利用可能になった。一方、Tool 開発画面の「設定変更のたびにプレビューする」体験には、未保存グラフをバージョン化せず検査・実行する境界が必要である。既存の `POST /tools` を自動保存に使うと編集操作ごとに patch version が増え、明示的に検証済み構成を保存する Tool の履歴と下書きが混在する。

## Decision

- UI は React、Vite、`@xyflow/react`、Zustand で構築する。
- UI は HTTP の wire DTO だけを所有し、`domain` / `application` / `api` / `adapters` / `composition` の実装を import しない。
- 未保存グラフ用に非永続の `DraftToolUseCase` と `POST /tool-drafts/infer-schema`、`POST /tool-drafts/preview` を追加する。これらは repository に触れず、バージョンを作らない。
- 編集後 300ms の debounce で infer-schema を実行し、エラーが無い場合だけ preview を実行する。古い要求は `AbortSignal` と request sequence で破棄する。
- `POST /tools` は利用者の明示的な Save 操作だけで呼び出す。保存後は既存の versions / GET API で履歴を表示・復元する。
- 開発時は Vite proxy で Fastify の `3030` へ接続し、ブラウザ向け CORS 設定を API へ追加しない。

## Consequences

- 下書き操作と永続 version の意味が分離される。
- UI は API 境界だけに依存し、バックエンド内部のリファクタリングから隔離される。
- v1 node catalog はクライアント内に固定する。サーバー側 node catalog API は後続課題とする。
- 編集途中の不完全グラフは 422 になり得る。UI は直近の成功プレビューを保持しつつ、現在のエラーを表示する。
- 認証のないローカル開発用 API である点は ADR-0006 から変わらない。

## 実装契約

[implementation/v5-tool-builder-ui.md](../../implementation/v5-tool-builder-ui.md) を単一の真実とする。
