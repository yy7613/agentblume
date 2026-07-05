# ADR-0015: ETL変換ノードを結合系・行操作・整形系へ拡張する（v15）

- Status: Accepted
- Date: 2026-07-05
- Context doc: [docs/06-etl-tool-builder.md §2.2](../06-etl-tool-builder.md)

## Context

実装済みの変換ノードは `select` / `filter` / `rename` / `cast` の4種（+source 3種）で、`ideas.md` が要求する変換群（join, union, sort, 重複排除, null処理, 置換, group by, ウィンドウ関数, 計算列, pivot ほか）の一部に留まる。Tool画面の実用性を上げるため変換機能の拡張が指示された（特に **結合 join / union**）。

## Decision

**v15 スコープ**（6ノード）を1増分として実装する:

| ノード | arity | 要点 |
|---|---|---|
| `join` | **2** | inner/left/right/full。キー列ペア指定。右の非キー衝突列は suffix 付与 |
| `union` | **2** | 列名ベース。strict（列集合一致必須）/ 非strict（和集合・欠損null） |
| `sort` | 1 | 複数キー・昇降順・null位置。安定ソート |
| `distinct` | 1 | 全列 or 指定列で重複排除（最初の行を保持） |
| `fill-null` | 1 | 定数埋め / 行削除（前方・後方埋めは時系列増分へ） |
| `replace` | 1 | 列ごとの厳密等価置換（from→to の複数規則） |

- **2入力ノードはエンジン変更なし**で成立する（`EtlNode.inputArity=2` と `GraphEdge.toInput` は v1 から実装・テスト済み。engine.test.ts の stub-join で検証済み）。
- UI（Tool Builder）は node-catalog への追加・NodeInspector の設定フォーム・**2入力ハンドルの描画/接続**・i18n（en/ja）を拡張する。
- **v15 に含めない**（次増分 v16+ へ）: 計算列（式エディタと同時に設計すべき）、group by 集計・ウィンドウ関数（集計セマンティクスを別増分で）、pivot/unpivot/split/merge、文字列整形、日付変換/リサンプリング。

## Consequences

- ✅ 複数ソースの結合・集合演算が可能になり、Azureデータパイプライン様の実用構成（2ソース→join→整形→sink）が組める。
- ✅ join/union のスキーマ推論（キー型不一致→mismatch、和集合の型unify）が「即時バリデーション」原則の実証になる。
- ⚠️ UIの2入力対応（ハンドル・接続制約・toInput表示）が最大の新規リスク。既存 FlowCanvas の接続モデルを先に確認して実装する。

## 実装契約

[implementation/v15-etl-transforms.md](../../implementation/v15-etl-transforms.md) を単一の真実とする。
