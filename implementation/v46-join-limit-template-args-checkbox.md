# v46: 結合の行数上限を変えられるようにする / テンプレートで引数の必須・任意を切り替える / チェックボックスを横並びに統一する

互いに独立した 3 つの増分。ファイルの所有を分けて並行で実装する。

---

## A. 結合（join）の行数上限を変えられるようにする

### A.1 問題

`join` は出力が **10 万行**を超えると止まる（`MAX_JOIN_ROWS`、[join.ts](../src/domain/etl/nodes/join.ts)）。この上限は結合キーの指定ミス（直積）でメモリが尽きるのを防ぐ安全弁だが、**固定**で変えられない。キーが正しくても 10 万行を超える結合（都道府県 × 月次 × 複数指標など）は作れない。

さらにその外側に、エンジン全体の「1 ノードが生成してよい行数」の上限（`DEFAULT_MAX_EXECUTION_ROWS` = 25 万、[engine.ts](../src/application/etl/engine.ts)）がある。これも固定で、呼び出し側から変える経路が無い。結合の上限だけを上げても 25 万で止まる。

### A.2 決定

2 段の上限を、それぞれ**持ち主が変えられる**ようにする。

| 上限 | 誰が変えるか | どこで | 既定 | 範囲 |
|---|---|---|---|---|
| 結合ごとの上限 `join.maxRows` | Tool を作る人 | 結合ノードの設定 | 100,000（今と同じ） | 1〜10,000,000 の整数 |
| サーバーの実行上限 | 運用者 | 環境変数 `AGENTCONTEXT_MAX_EXECUTION_ROWS` | 250,000（今と同じ） | 1 以上の整数 |

- **既存の Tool は何も変わらない**（`maxRows` を持たない join は 10 万のまま）。
- 実際に効くのは両者の小さい方。結合の上限を 50 万にしても、サーバーの上限が 25 万なら 25 万で止まる。そのとき出るのはエンジンのエラーなので、**そのエラー文が「サーバーの上限を上げる方法」を言う**（下記）。
- 結合ごとの上限を残すのは、キーの指定ミスを「結合キーを確認して」という具体的な文で早く止めるため（エンジンの上限は原因を言えない）。

### A.3 変更

**domain `src/domain/etl/nodes/join.ts`**
- `JoinConfig.maxRows?: number`。zod は `z.number().int().min(1).max(JOIN_MAX_ROWS_CEILING).optional()`。`JOIN_MAX_ROWS_CEILING = 10_000_000`。
- `MAX_JOIN_ROWS` は既定値として残す（名前は `DEFAULT_JOIN_MAX_ROWS` へ変えてよいが、参照箇所をすべて追随させる）。
- 実行時の上限は `config.maxRows ?? DEFAULT`。
- エラー文を直し方つきにする: `join: output exceeded <N> rows (this join's maxRows); check the join keys, and if they are right, raise maxRows on this join`。`<N>` は実際に効いた上限。

**application `src/application/etl/engine.ts`**
- `new EtlEngine(registry, options?: { readonly maxRows?: number })`。`preview` の `options.maxRows` が無いときの既定を、`DEFAULT_MAX_EXECUTION_ROWS` からこのコンストラクタ値へ変える（呼び出しごとの指定は従来どおり優先）。
- 上限超過のエラー文に直し方を足す: `<type>: produced <N> rows, exceeding the execution limit of <M> rows; narrow the data upstream, or raise AGENTCONTEXT_MAX_EXECUTION_ROWS on the server`。

**config `src/config/environment.ts`**
- `AGENTCONTEXT_MAX_EXECUTION_ROWS: optional(positiveInteger)` を他の変数と同じ作法で足す（起動時の fail-fast 検証、日本語の説明文）。未設定は 250,000。

**composition `src/composition/root.ts`**
- `new EtlEngine(nodeRegistry, { maxRows: env.… })` の 1 か所だけ。

**UI `src/ui/tool-builder/NodeInspector.tsx`（結合ノードの設定欄）**
- 「最大行数」の数値欄を足す。空欄 = 既定（100,000）。補助文: 「キーの指定ミスで行が爆発するのを止める上限。キーが正しいのに止まるときだけ上げる。サーバーの実行上限（既定 250,000 行）を超える値は、その上限で止まる」。
- 範囲外（0 以下・小数・1,000 万超）はその場で欄の下に指摘する。

**UI `src/ui/api/error-messages.ts`**
- `join: output exceeded 100,000 rows` の固定パターンを任意の行数に一般化し、新しいエラー文の日本語訳を足す: 「結合結果が〈N〉行を超えました。結合キーが正しいか確認し、正しければこの結合ノードの『最大行数』を上げてください」。旧文面（`; check join keys` だけの形）も引き続き訳す（保存済みの実行履歴に残っているため）。
- エンジン上限の訳に直し方を足す: 「…実行上限の〈M〉行を超えました。上流で行を絞るか、サーバーの環境変数 AGENTCONTEXT_MAX_EXECUTION_ROWS を上げてください」。旧文面も訳す。

**`.env.example`**: `AGENTCONTEXT_MAX_EXECUTION_ROWS` を他の項目の書式で足す（メモリとの関係を 1 行で）。

### A.4 テスト（観点）

- join: `maxRows` 省略で 10 万のまま（従来どおり）／`maxRows` を上げると 10 万超を返せる／下げるとその値で止まり、エラー文に実際の上限と直し方が入る／境界（ちょうど上限は通る・1 超えで止まる）／範囲外の config（0・小数・1,000 万超）は `validateConfig` で弾かれる。
- engine: コンストラクタの上限が既定になる／`preview` の呼び出しごとの指定が優先する（従来どおり）／超過エラー文に直し方。
- environment: 既定値／正の整数を受け付ける／0・負・小数・文字列は起動時エラー（どの変数に何を期待するかを含む）。
- error-messages: 新旧両方の文面を日本語化／任意の行数。
- NodeInspector: 欄の表示・入力・空欄で既定・範囲外の指摘。

---

## B. テンプレートで引数の必須・任意を切り替える

### B.1 問題

テンプレートの引数が必須か任意か（`arguments[].nullable`）は**テンプレート作者が決めた値で固定**されている。作った後なら「エージェント入力」ノードの「任意」チェックで変えられるが、作る時点では選べず、作成画面にも引数の一覧が出ない。

- 地域を毎回必ず指定させたい（`categories` を必須にしたい）、期間を省略させたくない、という調整を作成時にできない。
- 逆に、どの引数でも任意にしてよいわけではない。**粒度（`granularity`）を任意にすると、省略されたときにその条件が外れて月次と年次が混ざる**（引数が省略されると、束縛された条件ごと飛ばされる仕様のため。[tool-execution.ts](../src/application/tool/tool-execution.ts) `graphWithArguments`）。

### B.2 決定

- **既定はテンプレートの `nullable`**。作成画面で引数ごとに「必須」を切り替えられる。
- テンプレート作者は、切り替えさせたくない引数に **`lock`（理由の文、日英）**を書く。`lock` のある引数は切り替えられず、画面には理由が出る。
- 同梱テンプレートの `granularity` はすべて `lock` する（理由: 「省略できると月次と年次が混ざるため、必須に固定しています」）。
- Agent Factory は変えない（テンプレートの既定のまま）。

### B.3 テンプレートの形式（追加のみ。`formatVersion` は 1 のまま）

```jsonc
{
  "name": "granularity", "type": "string", "nullable": false,
  "lock": { "ja": "省略できると月次と年次が混ざるため、必須に固定しています", "en": "Required: omitting it would mix monthly and annual rows" },
  "sample": { "$slot": "defaultGranularity" },
  "description": { … }
}
```

- `src/domain/tool-template/template.ts`: 引数に `lock?: Localized`。
- `templates/tools/tool-template.schema.json`: 同じ項目を足す（エディタ補完）。
- `templates/tools/README.md`: 「書き方の要点」の表と「決まりごと」に 1 行ずつ（いつ `lock` を書くか）。
- 同梱テンプレートで `granularity` を持つもの（9 本）に `lock` を足し、`version` のパッチを 1 つ上げる。

### B.4 実体化

**domain `src/domain/tool-template/instantiate.ts`**
- `instantiateTemplate(template, values, facts, { toolName, language, argumentNullability? })`。`argumentNullability: Readonly<Record<string, boolean>>`（引数名 → nullable）。
- 効く値 = `argumentNullability[name] ?? argument.nullable`。これを入力スキーマの列、説明文の「必須 / 省略可」、設計時サンプルの要否のすべてに使う（今 `argument.nullable` を直接見ている箇所をすべて置き換える）。
- 検査（違反は `ToolTemplateError`、直し方つき）:
  - テンプレートに無い引数名 → 「引数『x』はこのテンプレートにありません。〈使える名前〉から選んでください」。
  - `lock` のある引数をテンプレートの既定と違う値にした → 「引数『granularity』は変えられません: 〈lock の理由〉」。
  - 任意 → 必須にした引数に設計時の見本（`sample`）が無い → 「引数『x』は設計時の見本が無いので必須にできません。テンプレートに sample を書いてください」。
  - `when` で落ちた引数への指定は**無視する**（その引数は作られない）。

**application / API**
- `InstantiateToolTemplateRequest.argumentNullability?`、`POST /tool-templates/:id/instantiate` の body に任意の `argumentNullability: Record<string, boolean>`。違反は既存の 422 `TOOL_TEMPLATE_SLOTS` 封筒に載せる（`slot` は `argument:<name>` の形にする。画面では欄の真下に出せる）。
- `POST /tool-templates/:id/slot-candidates` の応答に **`arguments`** を足す: 今のスロットの値で `when` を評価して**残る引数だけ**を、`{ name, type, nullable, lock?, description }`（`description` は言語に合わせて埋め込み済みの文）で返す。画面はこれをそのまま描く（`when` の評価を画面に持たせない）。

**UI `src/ui/tool-builder/TemplateDialog.tsx`**
- スロットの欄と名前の欄の間に「**エージェントの引数**」の区画を置く。`slot-candidates` の `arguments` を 1 行ずつ: 引数名・説明・「必須」チェックボックス（既定はテンプレートの値）。
- `lock` のある行はチェックボックスを無効にし、理由をその行に出す。
- 区画の冒頭に 1 文: 「任意にした引数は、エージェントが省略するとその条件で絞りません」。
- 作成時、**既定から変えた引数だけ**を `argumentNullability` に入れて送る。
- `styles.css` は触らない（チェックボックスの体裁は C の全体規則に任せる）。

### B.5 テスト（観点）

- domain: 既定のまま／任意 → 必須（入力スキーマ・説明文の「必須」・見本）／必須 → 任意（説明文の「省略可」）／未知の名前／lock の引数を変える／lock の引数を既定と同じ値で送るのは可／見本の無い引数を必須にする／`when` で落ちた引数の指定は無視。
- 同梱テンプレート: `granularity` を持つ 9 本すべてに `lock` があり、読み込みで invalid にならない（実カタログのテスト）。
- API: 本文の検証、422 の `slot: 'argument:<name>'`、`slot-candidates` の `arguments` が `when` に従う（カテゴリ列を選ぶと `categories` が現れる）。
- UI: 区画の表示・既定値・切り替え・lock 行は無効で理由が出る・変えた引数だけが送られる・何も変えなければ `argumentNullability` を送らない。

---

## C. チェックボックスとラベルを横並びに統一する

### C.1 問題

全体の CSS が `label { display: flex; flex-direction: column }`（[styles.css:39](../src/ui/styles.css)）なので、`<label>` の中にチェックボックスを置くと、**チェックボックスと文言が縦に積まれる**。画面ごとに打ち消していて、その書き方が 6 通り以上ある（`.inline-check` / `.checkbox-label` / `.journal-checkbox` / `.structured-output-field > label` / `.journal-question label` / `.journal-register label` / `.mcp-transport-kind label` / `.factory-mode-select label` / `.tool-check-arg .checkbox-label` など）。打ち消していない画面（テンプレートの列・結合キーの選択、エージェント入力の「任意」など）は縦のまま。チェックボックスは UI 全体で 95 か所ある。

### C.2 決定

**全体の規則 1 つで横並びにする**。個々の画面のマークアップは変えない。

```css
/* チェックボックス・ラジオを含むラベルは横並び（チェックが先・文言が後）。 */
label:has(> input[type="checkbox"]),
label:has(> input[type="radio"]) {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}
label:has(> input[type="checkbox"]) > input[type="checkbox"],
label:has(> input[type="radio"]) > input[type="radio"] {
  width: auto;
  flex: none;
  margin: 0;
  order: -1; /* マークアップで文言が先でも、見た目はチェックを先に揃える */
}
```

- 画面ごとの打ち消し規則のうち、**この規則と同じことしかしていないもの**は消す。レイアウト上の別の役目（`align-self` / `min-height` / 余白 / 文字サイズ）を持つものは、その役目だけ残す。
- 文言が長くて折り返すときも、チェックは 1 行目の高さに揃う（`align-items: center` で崩れる箇所があれば `flex-start` + チェックの上余白で合わせる）。
- `:has()` を使う（対象は現行のブラウザ。旧ブラウザの対応は非スコープ）。

### C.3 確認

- CSS の変更は jsdom のテストでは見えないので、**実画面で確かめる**: 一時サーバ（`AGENTCONTEXT_DB_PATH=:memory:`）と UI を起動し、Playwright で次の画面のスクリーンショットを撮って、変更前と見比べる: ツール作成画面の「テンプレートから作成」（列の複数選択・結合キー）、結合ノードの設定、エージェント入力ノード（「任意」）、設定画面、Factory 画面、経費精算の規程（チェックボックスが最も多い）。
- 既存の UI テスト（`src/ui`）がすべて緑のまま。

---

## ドキュメント（親が書く）

- `docs/06-etl-tool-builder.md`: 結合ノードの節に「最大行数」、§3.16 に「エージェントの引数」の区画。
- `docs/02-tech-stack.md`: `AGENTCONTEXT_MAX_EXECUTION_ROWS`。
- `docs/04-api-spec.md` §3.8: `argumentNullability` と `slot-candidates` の `arguments`。
- `docs/19-troubleshooting.md`: 「結合結果が〈N〉行を超えました」の対処。
- `CHANGELOG.md`。
