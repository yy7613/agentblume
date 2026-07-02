# ADR-0003: 最初の実装インクリメントを ETL Tool Engine（純ドメイン）とする

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/06-etl-tool-builder.md](../06-etl-tool-builder.md), [docs/03-domain-model.md](../03-domain-model.md)

## Context

v1の代表ジャーニー（[README §7](../README.md)）は「CSV/JSON読込 → select/filter/rename/cast → 各ノードでスキーマ変化確認 → Tool契約確定 → Agent接続 → トレース → 保存」。この中で **UI・外部SDK・LLMに一切依存しない中核** は、ETLのノード実行とスキーマ伝播（[06 §3.1](../06-etl-tool-builder.md)）である。

## Decision

最初のインクリメントを **ETL Tool Engine** に限定する。含むもの:

- ドメインのデータ型（`Schema` / `Table` / `SchemaState`）とスキーマ推論。
- `EtlNode` 契約と v1ノード5種: `json-source` / `csv-source` / `select` / `filter` / `rename` / `cast`。
- アプリ層の `EtlEngine`: グラフのトポロジカル実行、**スキーマ伝播（無実行）** と **プレビュー実行（行数制限）**。
- v1ジャーニーのE2Eテストとデモ。

**含まないもの（後続インクリメント）**: 永続化（`StoragePort` + SQLite）、Tool/Skill/Agentメタデータ、LLM接続（Mastra）、UI、MCP、認証認可。拡張点（Port定義）は先に置くが実装しない。

## Consequences

- ✅ 外部依存ゼロで高被覆の単体テストが可能。決定的で回帰検知しやすい（[06 §3.5 スナップショット](../06-etl-tool-builder.md)）。
- ✅ 「プレビュー駆動」「即時バリデーション（型不一致検知）」を最初から体現する。
- ✅ 後続の永続化・Tool契約・Agent接続は、この確定した中核へ薄く重ねられる。
- ⚠️ この段階では画面から触れない。次インクリメントで `application` ユースケース + SQLite 永続化を追加し、[07 実行モデル](../07-execution-model.md)のプレビューフローに接続する。

## 実装契約

詳細な型・シグネチャ・振る舞い・テスト要件は [implementation/v1-etl-core.md](../../implementation/v1-etl-core.md) を単一の真実とする。
