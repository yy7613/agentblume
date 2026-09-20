# v43 実装契約: ツールテンプレート（外部ファイル）

- 関連: [ADR-0049](../docs/adr/0049-tool-templates.md) / [v42 段階的ツール生成](./v42-staged-tool-generation.md) / [docs/06](../docs/06-etl-tool-builder.md) / [docs/16](../docs/16-agent-factory.md)
- この文書は**契約の正本**。ファイル形式の正本は `templates/tools/tool-template.schema.json`（エディタ補完用）と `src/domain/tool-template/template.ts`（zod。実行時の検証）。

## 0. 目的

Tool を 1 から組むのではなく、**テンプレートを選び、スロット（データソース・列・少数の選択肢）を埋める**だけで作れるようにする。

- ローカルの小さなモデルでも、相関・前期比・ランキング・複数ソースの比率のような**高度な構成**を作れる（構成はテンプレートが持ち、モデルは選ぶだけ）。
- 人も Tool Builder で「テンプレートから作成」を使える（同じファイル・同じ実体化）。
- テンプレートは**外部ファイル**（JSON）。コードを変えずに足せる。壊れたファイルは読み飛ばし、理由と直し方を一覧に出す。

## 1. 置き場所と読み込み

- 既定の置き場所: `<作業ディレクトリ>/templates/tools/*.json`（リポジトリ同梱の標準テンプレート）。
- 追加の置き場所: 環境変数 `AGENTCONTEXT_TOOL_TEMPLATES_DIR`（`;` か `:` 区切りで複数可）。同じ `id` は後勝ち（利用者のファイルが標準を上書きできる）。
- `tool-template.schema.json` と `README.md`、`_` で始まるファイルは読まない。1 ファイル 1 テンプレート。最大 256KB、最大 200 ファイル。
- 読み込みは要求時（一覧取得・Factory の Stage 2 開始時）に行い、ファイルの更新時刻でキャッシュする（再起動なしで足せる）。
- ポート: `ToolTemplateCatalogPort { list(): Promise<ToolTemplateCatalog> }`、`ToolTemplateCatalog { templates: ToolTemplate[]; invalid: { file: string; id?: string; problems: string[] }[] }`。アダプタ: `src/adapters/templates/fs-tool-template-catalog.ts`。ディレクトリが無ければ空の一覧（機能は無効なだけで、エラーにしない）。

## 2. ファイル形式（formatVersion 1）

```jsonc
{
  "$schema": "./tool-template.schema.json",
  "formatVersion": 1,
  "id": "period-series",              // ^[a-z][a-z0-9-]{1,48}$
  "version": "1.0.0",
  "title":     { "ja": "…", "en": "…" },
  "summary":   { "ja": "…", "en": "…" },     // 1 行。一覧とモデルの選択材料
  "whenToUse": { "ja": ["…"], "en": ["…"] }, // 箇条書き（モデルが選ぶ根拠）
  "notFor":    { "ja": ["…"], "en": ["…"] }, // 任意
  "tags": ["time-series"],
  "sources": { "min": 1, "max": 1 },          // このテンプレートが読むデータソースの数
  "slots": [ /* §2.1 */ ],
  "arguments": [ /* §2.3 */ ],
  "nodes": [ /* §2.2 */ ],
  "edges": [ { "from": "src", "to": "period" }, { "from": "a", "to": "join", "toInput": 0 } ],
  "description": { "ja": "…{{slot}}…", "en": "…" }  // エージェント向けの Tool 説明
}
```

### 2.1 スロット（埋める場所）

共通: `name`（`^[a-z][A-Za-z0-9]{0,39}$`）、`label {ja,en}`、`help {ja,en}`（任意）、`optional`（既定 false）。

| kind | 追加フィールド | 値 | 選択肢の作り方（決定的） |
|---|---|---|---|
| `dataSource` | — | データソース id | Tool 計画のソース（主 → 追加の順）。`sources` の数だけ `dataSource` スロットを置く |
| `column` | `source`（dataSource スロット名）、`role`、`types?`、`multiple? {min,max}`、`distinctFrom? [slot]` | 列名（`multiple` なら配列） | `role` と `types` でプロファイルから絞る（下表） |
| `joinKeys` | `left`、`right`（dataSource スロット名）、`multiple {min,max}` | 列名の配列 | その 2 ソース間の `joinCandidates.keys` |
| `choice` | `options [{value,label{ja,en}}]` か `optionsFrom`、`default?` | 文字列 | `optionsFrom: "granularities:<periodColumnSlot>"` = その期間列にデータが在る粒度 |
| `number` | `min`、`max`、`integer?`、`default` | 数値 | 範囲内 |
| `text` | `maxLength`、`pattern?`、`default` | 文字列 | 自由記述（出力列名など） |
| `intent` | `maxLength` | 文字列 | 計算の意図文。`{"$intent": slot}` を持つ calculate ノードの式を v41 の式提案が埋める |

`column.role`: `period`（`periodColumns`）/ `category`（`categoricalColumns`）/ `value`（数値列。コード列・期間の派生列を除く）/ `text`（string 列）/ `any`。`types` があれば列の型でも絞る。必須スロットに候補が 1 つも無いテンプレートは、その Tool 計画には**適用不可**（選択肢に出さない）。

### 2.2 ノードと置換

`nodes[]`: `{ "id", "type", "config", "when"? }`。`type` は登録済みノード種別。`config` の中で次の置換が使える。

| 書き方 | 意味 |
|---|---|
| `"{{slot}}"` を含む文字列 | 文字列への埋め込み（配列は `, ` で連結）。式の列参照は `[{{valueA}}]` と書く |
| `{ "$slot": "name" }` | 値そのもの（配列・数値・文字列の型を保つ） |
| `{ "$each": "slot", "as": "c", "item": <任意の JSON> }` | 配列スロットの各要素について `item` を展開した配列。`item` の中では `{{c}}` / `{"$slot":"c"}` が要素を指す |
| `{ "$intent": "slot" }` | calculate の `expression` にだけ書ける。式は空で置かれ、実体化後に式提案が埋める |
| `{ "$profile": "periodMin:<slot>" }` など | プロファイル由来の値。`periodMin` / `periodMax`（ISO 日付）、`firstValues:<slot>:<n>`（実在値の先頭 n 件の配列）、`firstValuesCsv:<slot>:<n>`（同・カンマ連結） |
| `{ "$argument": "name" }` | filter 条件の `valueBinding` を作る糖衣: `{ "source": "agent-input", "field": name }` |
| `{ "$number": "slot" }` | スロット値を数値として入れる（`choice` の値は文字列なので、`lag` のような数値 config に使う）。数値にできなければ実体化エラー |
| `{ "$concat": [<配列になる式>, …] }` | 配列を連結して 1 つの配列にする（重複は除く）。`select.columns` に「結合キー + 値の列」を渡すときなど |
| `{ "$sourceType": "<dataSource スロット>" }` | **ノードの `type` にだけ**書ける。そのデータソースの形式（プロファイルの `format`）から `csv-source` / `json-source` を選ぶ。標準テンプレートはすべてこの形で書き、csv 専用にならないようにする |

`$each` は配列でないスロット（任意の単一列など）にも使える: 埋まっていれば 1 要素、空なら 0 要素の配列になる（`time-series-analysis` の `groupBy` に「カテゴリ列があればそれで分ける」を書くための形）。

ファイル直下の `notes`（文字列、任意）は作者向けのメモで、実行時は無視する。同梱テンプレートの `implementationNotes` は実装担当への申し送りで、**解決したら削除して `notes` に要点だけ残す**。

**結合後の列名**: `join` の右側で同名になる列は `rightSuffix` が付く。スロットが指す列が右ソース由来で、左に同名の列があるとき、実体化は **join より下流のノードに限り** `{{slot}}` / `$slot` を suffix 付きの名前へ読み替える（テンプレート作者が意識しなくてよいようにする）。式で参照できない列名（`]` を含む）は `validateSlotValues` が「上流で列名を変える」直し方つきで弾く。

`when`: ノード・引数・`edges` の要素に付けられる。`"slot"`（そのスロットが埋まっている）/ `{ "slot": "x", "equals": "v" }` / `{ "slot": "x", "notEquals": "v" }` / `{ "not": <when> }`。`when` が偽のノードは消え、**入次数 1・出次数 1 のノードに限り**前後を自動で繋ぐ（読み込み時に検査）。

agent-input ノードはテンプレートに書かない。`arguments` から実体化時に生成する（1 つも残らなければ作らない）。agent-output は `nodes` にちょうど 1 つ書く。

### 2.3 引数

`arguments[]`: `{ "name", "type": "string|number|boolean|date", "nullable", "when"?, "description {ja,en}", "sample" }`。`sample` はリテラルか `$slot` / `$profile`。`name` は `^[a-z][a-z0-9_]{0,39}$`。filter 条件からは `{ "$argument": name }` で参照する。参照されない引数・宣言の無い参照は読み込み時エラー。

引数の `description` は、実体化のときに **Tool の説明文へ連結する**（`引数:` / `Arguments:` の見出しの下に `- <name> (必須|省略可): <説明>`。`when` で落ちた引数は載せない。引数が無ければ見出しごと出さない）。入力スキーマの列は名前・型・null 可否しか持たず、モデルへ届く文章は Tool の説明文だけだからである（実測: 説明が届かず `granularity` に `monthly` を渡して 0 行になった。ADR-0047 第6ラウンド）。識別子を渡させる引数は、取り得る値を**綴りのまま**説明に書く。

### 2.4 読み込み時の検査（壊れたテンプレートは `invalid` に入る。問題ごとに直し方を書く）

形式（zod）/ id・スロット名・引数名の形と重複 / `edges` の端点 / `$slot`・`{{ }}`・`$each`・`$intent`・`$profile`・`$argument`・`when` が参照する名前の実在 / agent-output がちょうど 1 つ / source ノード数 = `dataSource` スロット数 = `sources.max` 以下 / 条件つきノードが橋渡しできる形か / ノード種別が登録済みか（アプリ層で registry を見る）/ `$intent` が calculate の `expression` 以外にある / 循環。

## 3. 実体化 — `src/domain/tool-template/instantiate.ts`（純関数）

```ts
export interface TemplateSlotValues { readonly [slot: string]: string | number | readonly string[] | undefined }
export interface TemplateProfileFacts { /* $profile が要る事実だけ: 期間列ごとの minStart/maxStart/粒度、列ごとの実在値 */ }
export interface InstantiatedTemplate {
  readonly graph: ToolGraph;
  readonly inputSchema?: Schema;
  readonly agentTool: { readonly name: string; readonly description: string };
  /** `$intent` を持つ calculate ノード（式は空）。実体化後に式提案が埋める。 */
  readonly pendingExpressions: readonly { readonly nodeId: string; readonly intent: string }[];
}
export function slotCandidates(template, context): Record<string, readonly string[] | { min: number; max: number } | 'free-text'>;
export function applicableTemplates(templates, context): ToolTemplate[];
export function validateSlotValues(template, values, context): { slot: string; message: string }[];
export function instantiateTemplate(template, values, facts, options: { toolName: string; language: 'ja' | 'en' }): InstantiatedTemplate;
```

`context` は v42 の `ToolSpecContext` を再利用できるならする（ソースごとの列・期間列・カテゴリ列・結合キー候補）。実体化の結果は、既存の構造検査・意味検査・設計時プレビュー・保存検証を**そのまま**通す（テンプレート経路だけの抜け道を作らない）。テンプレートが使ってよいノード種別は登録済みの全種別（一括 ToolSmith の許可リストには縛られない。副作用のある sink は `agent-output` のみ許可）。

## 4. Factory への組み込み（Stage 2 の新規作成 Tool）

順番: **テンプレート → 段階的生成（v42）→ 一括 ToolSmith**。

1. `applicableTemplates` で、この Tool 計画（ソース数・プロファイル）に当てはまるテンプレートを決定的に絞る。0 件なら v42 へ。
2. タスク `select-template`（`runRoleTask`）: 材料は計画の目的・目標文と、各候補の `id` / `summary` / `whenToUse` / `notFor` だけ。出力 `{ templateId: <enum: 候補の id + "none"> , reason }`。`none` なら v42 へ。
3. タスク `fill-slots`: 材料は選んだテンプレートのスロット定義（label/help）と、スロットごとの候補（`slotCandidates`。カテゴリ列は実在値の例つき）。スキーマは**スロットごとに enum**（`multiple` は enum の配列、`number` は min/max、`text`/`intent` は文字列）。
4. `validateSlotValues` → 違反は `fill-slots` へ 1 回差し戻し。`instantiateTemplate` → `pendingExpressions` を式提案で埋める（失敗したら一括ではなくその Tool のテンプレート経路を失敗にして v42 へ）。
5. 既存の検査一式 → 違反は `fill-slots` へ 1 回差し戻し → それでも駄目なら v42 へ（理由をイベントに残す: `template <id> failed: <reason>; falling back to staged generation`）。
6. `tool_generated` の message: `<key> (template: period-series@1.0.0; slots: periodColumn=時点, valueColumns=[…]; repaired: fill-slots)`。

`FactoryOptions.toolGeneration` に `'template'` は足さない。`'staged'`（既定）はテンプレートを先に試す。`'one-shot'` は従来どおりテンプレートも段階的生成も使わない。

Planner へ: 適用できるテンプレートの `id` と `summary` の一覧を材料に足し、「テンプレートで作れる形の Tool を優先して計画する」規則を 1 行足す（計画の形は変えない）。

## 5. API と Tool Builder

- `GET /tool-templates` → `{ templates: [{ id, version, title, summary, whenToUse, tags, sources, slots }], invalid: [...] }`（`ToolRead` 権限）。
- `POST /tool-templates/:id/slot-candidates` body `{ dataSourceIds: string[] }` → スロットごとの候補（サーバーがプロファイルを取って `slotCandidates` を返す）。
- `POST /tool-templates/:id/instantiate` body `{ dataSourceIds, values, language }` → `{ graph, inputSchema, agentTool, pendingExpressions }`（保存はしない。検証エラーは 422 でスロット名つき）。
- Tool Builder: 新規作成に「テンプレートから作成」。一覧（タイトル・要約・使いどころ）→ データソース選択 → スロットをドロップダウンで埋める → キャンバスへ展開（メタデータの表示名・公開名・Agent Tool 契約も埋める）。`pendingExpressions` があれば、該当の関数電卓ノードを選択状態にして「AIに式を書かせる」へ意図文を入れておく。`invalid` は一覧の下に「読み込めなかったテンプレート」として理由と直し方を出す。

## 6. 同梱する標準テンプレート（`templates/tools/`）

| id | 何を作るか | 主なノード |
|---|---|---|
| `period-series` | 期間・粒度・カテゴリで時系列を取り出す | parse-period → filter ×3 → sort → limit |
| `latest-values` | 最新の N 期を返す | parse-period → filter → sort desc → limit |
| `category-ranking` | ある期間のカテゴリ別ランキング（上位 N） | parse-period → filter → sort(value desc) → limit |
| `period-change` | 前期比・前年同期比（増減と増減率） | parse-period → filter → time-series-analysis(comparison) |
| `period-statistics` | 期間内の統計（平均・最小・最大・中央値）をカテゴリ別に | parse-period → filter → summary-statistics |
| `join-side-by-side` | 2 ソースを同じ時点・同じ地域で横に並べる | select → join → parse-period → filter → sort |
| `join-three-side-by-side` | 3 ソースを同じ時点・同じ地域で横に並べる | select ×2 → join ×2 → parse-period → filter → sort |
| `ratio-of-two-sources` | 2 ソースの比（一人当たり・率）を固定の式で計算 | join → calculate（固定式）→ … |
| `correlation-of-two-sources` | 2 ソースの値の相関係数 | join → parse-period → filter → correlation-analysis |
| `custom-computation` | 1 ソース + 計算列（式は意図文から AI が書く） | … → calculate(`$intent`) |

各テンプレートは、e-Stat 風の固定データに対して**実エンジンで実体化 → 検査 → 実行**するテストを持つ（ノードの実際の config・出力列がテンプレートの想定と違えば、テンプレート側を直す）。

2 ソース版と 3 ソース版を 1 つのテンプレートに `when` でまとめることはしない（§2.2 の橋渡しは**入次数 1・出次数 1**のノードにしか効かず、結合の枝 `source → select → join(入力 1)` は `join` が 2 入力なので繋ぎ直せない）。`join-side-by-side` と `join-three-side-by-side` に分ける。

## 7. テスト観点

- 形式: zod の受理/拒否、§2.4 の各検査が直し方つきの問題文を返す、`when` の橋渡し、`$each` の入れ子、未知の `$profile` 関数。
- 実体化: 置換の型保持、配列の文字列埋め込み、任意スロット未指定でノード・引数・エッジが消えて繋がる、引数から agent-input が生成される、決定性、説明文の言語。
- 候補: role/types/distinctFrom/joinKeys/granularities、適用不可の判定。
- カタログ: 複数ディレクトリ・後勝ち・`_` と schema を無視・壊れた JSON / 大きすぎるファイル / 上限超過・更新時刻キャッシュ・ディレクトリ無し。
- 標準テンプレート: §6 の全件が e-Stat 風データで動く（値まで検証）。
- Factory: テンプレート選択 → スロット → 保存、`none` で v42 へ、スロット違反の差し戻し、検査違反の差し戻し、失敗でフォールバックしイベントに理由、`one-shot` では使わない、役割呼び出しの会計。
- API / UI: 一覧・候補・実体化・422 のスロット名、Tool Builder の作成フロー、invalid の表示。

## 8. 非スコープ

テンプレートの GUI 編集・共有、テンプレートからの Skill 生成、テンプレート内の条件分岐より複雑な制御、`formatVersion` の移行ツール。
