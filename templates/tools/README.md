# ツールテンプレート

このフォルダの `*.json` は、Tool を 1 から組む代わりに **テンプレートを選んでスロットを埋める**ための外部ファイルです。Agent Factory（ローカル LLM）と Tool Builder の「テンプレートから作成」が同じファイルを読みます。

- 形式の契約: [implementation/v43-tool-templates.md](../../implementation/v43-tool-templates.md)
- エディタ補完: 各ファイルの `"$schema": "./tool-template.schema.json"`
- 自分のテンプレートを足す: このフォルダに置くか、別フォルダを環境変数 `AGENTCONTEXT_TOOL_TEMPLATES_DIR` に指定する（同じ `id` は後から読んだものが勝つ）。再起動は要らない。
- `_` で始まるファイル・この README・schema は読まれない。下書きは `_draft-xxx.json` にしておく。
- 壊れたファイルは読み飛ばされ、Tool Builder の一覧の下と `GET /tool-templates` の `invalid` に**理由と直し方**が出る。

## 最小の例

```json
{
  "$schema": "./tool-template.schema.json",
  "formatVersion": 1,
  "id": "top-rows",
  "version": "1.0.0",
  "title": { "ja": "上位 N 件", "en": "Top rows" },
  "summary": { "ja": "値の大きい順に N 件返す。", "en": "Returns the N largest rows." },
  "whenToUse": { "ja": ["ランキングが要る"], "en": ["A ranking is needed"] },
  "sources": { "min": 1, "max": 1 },
  "slots": [
    { "name": "source", "kind": "dataSource", "label": { "ja": "データソース", "en": "Data source" } },
    { "name": "value", "kind": "column", "source": "source", "role": "value", "label": { "ja": "並べる値の列", "en": "Value column" } },
    { "name": "limit", "kind": "number", "min": 1, "max": 100, "integer": true, "default": 10, "label": { "ja": "件数", "en": "Rows" } }
  ],
  "arguments": [],
  "nodes": [
    { "id": "src", "type": "csv-source", "config": { "dataSourceId": { "$slot": "source" } } },
    { "id": "sort", "type": "sort", "config": { "keys": [{ "column": { "$slot": "value" }, "direction": "desc" }] } },
    { "id": "limit", "type": "limit", "config": { "count": { "$slot": "limit" } } },
    { "id": "out", "type": "agent-output", "config": { "shape": "rows", "format": "json", "maxRows": { "$slot": "limit" }, "maxBytes": 65536, "overflow": "error" } }
  ],
  "edges": [{ "from": "src", "to": "sort" }, { "from": "sort", "to": "limit" }, { "from": "limit", "to": "out" }],
  "description": { "ja": "{{value}} の大きい順に {{limit}} 件返します。", "en": "Returns the top {{limit}} rows by {{value}}." }
}
```

## 書き方の要点

| やりたいこと | 書き方 |
|---|---|
| スロットの値をそのまま入れる（配列・数値の型を保つ） | `{ "$slot": "valueColumns" }` |
| 文字列に埋め込む（式の列参照は角括弧） | `"[{{numerator}}] / [{{denominator}}]"` |
| 配列スロットの要素ごとに展開する | `{ "$each": "joinKeys", "as": "k", "item": { "left": "{{k}}", "right": "{{k}}" } }` |
| 配列をつなぐ | `{ "$concat": [{ "$slot": "joinKeys" }, [{ "$slot": "denominator" }]] }` |
| 選択肢の値を数値にする | `{ "$number": "lag" }` |
| エージェントの引数に束縛する | filter 条件に `"valueBinding": { "$argument": "period_from" }` |
| データから設計時の見本を取る | `{ "$profile": "periodMin:periodColumn" }` / `firstValues:<slot>:<n>` |
| 式を AI に書かせる | calculate の `"expression": { "$intent": "computationIntent" }` と `intent` スロット |
| 任意のスロットが空ならノードごと外す | ノードに `"when": "categoryColumn"`（前後は自動で繋がる。入口 1・出口 1 のノードだけ） |
| csv でも json でも読めるようにする | ノードの `"type": { "$sourceType": "source" }`（そのデータソースの形式から `csv-source` / `json-source` を選ぶ） |

決まりごと:

- `agent-input` は書かない。`arguments` から自動で作られる。`agent-output` はちょうど 1 つ書く。
- データソースを読むノードの数は `dataSource` スロットの数と同じにする。
- 月次と年次が同じ列に混ざるデータでは、`parse-period` の後で必ず `periodGranularity` を絞る。粒度を引数にするなら**必須引数**（`"nullable": false`）にする（省略できると混ざる）。
- 引数の `description` は、実体化のときに Tool の説明文の末尾へ「引数:」として連結される（エージェントが読むのは Tool の説明文だけ）。識別子を渡させる引数は、取り得る値を綴りのまま書く（例: `month / quarter / half / year / fiscal-year`。書かないと `monthly` や「月次」を渡されて 0 行になる）。
- 差・比・率・前年比のような数値は、固定の式か分析ノードで**ツールの列として**出す。説明文に「この列から答え、暗算しない」と書く。
- 実体化したグラフは、手で作った Tool と同じ検査（構造・列の存在・設計時プレビュー・保存時の検証）を通る。通らないテンプレートは使われない。
- データ経路は 1 本の木にする（分岐は禁止。合流できるのは `join` だけ）。`join` の枝は `when` で外せない（外すと 2 入力の橋渡しになるため）ので、ソース数が違う形は別のテンプレートにする。
- 結合の右側から来た列は、同名の列が左にあると `rightSuffix` が付く。テンプレートは**素の列名**で書いてよい（`join` より下流だけ自動で読み替わる）。

## 同梱の標準テンプレート

| id | 何を作るか | ソース数 |
|---|---|---|
| `period-series` | 期間・粒度・カテゴリで時系列を取り出す（新しい順） | 1 |
| `latest-values` | 最新の N 期だけを返す（期間の範囲引数なし） | 1 |
| `category-ranking` | ある 1 つの期間のカテゴリ別ランキング（上位 N） | 1 |
| `period-change` | 前月比・前年同月比の増減（delta）と増減率（percentChange） | 1 |
| `period-statistics` | 期間内の件数・合計・平均・最小・中央値・最大（カテゴリ別も可） | 1 |
| `custom-computation` | 計算列を 1 つ足す（式は意図文から AI が書く） | 1 |
| `join-side-by-side` | 2 ソースを同じ時点・同じキーで横に並べる | 2 |
| `join-three-side-by-side` | 3 ソースを同じ時点・同じキーで横に並べる | 3 |
| `ratio-of-two-sources` | 2 ソースの比（一人当たり・率）を固定の式で計算 | 2 |
| `correlation-of-two-sources` | 2 ソースの値の相関係数（pearson / spearman） | 2 |
