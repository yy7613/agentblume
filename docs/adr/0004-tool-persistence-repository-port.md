# ADR-0004: Tool永続化を ToolRepository ポート + 二重アダプタ + 契約テストで実装する

- Status: Accepted
- Date: 2026-07-02
- Context doc: [docs/02-tech-stack.md](../02-tech-stack.md), [docs/03-domain-model.md](../03-domain-model.md), [docs/05-dependency-graph.md](../05-dependency-graph.md)

## Context

v1ジャーニー（[README §7](../README.md)）の残りステップ「④ Tool契約確定」「⑦ 検証済み構成をバージョン付きで保存」を満たすには、Tool定義の永続化が要る。[02-tech-stack.md](../02-tech-stack.md) は永続化に **SQLite（初期開発）→ PostgreSQL（Phase 2）**、テストは **InMemory** を採用（🔶）。[05](../05-dependency-graph.md) は「application は Port にのみ依存」「SDK/DBは adapter に隔離」を要求する。

## Decision

- **ドメインに `ToolRepository` ポート（interface）** を定義する。application 層のユースケースはこのポートにのみ依存する。
- **アダプタを2つ**用意する:
  - `InMemoryToolRepository`（テスト・`test` プロファイル）
  - `SqliteToolRepository`（`local` プロファイル、Node組込み **`node:sqlite`**。ゼロインストール。`--experimental-sqlite` フラグを test/実行の execArgv で付与）
- **単一の契約テストスイート** `toolRepositoryContract(makeRepo)` を両アダプタに適用し、同一契約の充足を保証する（[01 §5 契約テスト](../01-architecture.md)）。
- **Toolバージョンは不変**。保存は新バージョンの追加であり、既存バージョンを上書きしない。`SaveToolUseCase` は保存前に `EtlEngine.propagateSchemas` でグラフを検証し、`error` issue があれば保存を拒否する（「検証済み構成のみ保存」）。
- **レイヤ整合の是正**: Tool はグラフを所有するドメイン概念のため、`ToolGraph`/`GraphNode`/`GraphEdge` を `application/etl/` から **`domain/etl/` へ移動**する。`EtlEngine`（application）はドメインの `ToolGraph` を実行する。

## Consequences

- ✅ ユースケース・ドメインはDB非依存。SQLite/PostgreSQLの差異はアダプタ内に閉じる。
- ✅ 契約テストにより、将来 PostgreSQL アダプタを足しても同一保証で差し替え可能。
- ✅ 保存前グラフ検証で「検証済み構成をバージョン付きで保存」を機構化。
- ⚠️ `node:sqlite` は実験的機能（`ExperimentalWarning`）。v1のローカル用途に限定し、フラグは test/実行スクリプトで付与する。Phase 2 で安定版採用またはPostgreSQLへ移行。
- ⚠️ 永続化はJSON直列化。**config値はJSON直列化可能**であること（Date型のconfig値の永続化はv2範囲外として明示）。

## Alternatives considered

- **better-sqlite3**: 安定APIだがネイティブビルド依存。組込み `node:sqlite` でゼロインストールを優先。
- **ファイル(JSON)永続化のみ**: クエリ・バージョン管理・テナント境界の将来拡張に弱く、SQLite採用方針([02](../02-tech-stack.md))に反する。

## 実装契約

型・シグネチャ・振る舞い・テスト要件は [implementation/v2-tool-persistence.md](../../implementation/v2-tool-persistence.md) を単一の真実とする。
