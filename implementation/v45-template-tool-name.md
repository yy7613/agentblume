# v45: テンプレートから作る Tool の名前を、作るときに必ず決めさせる

- 前提: [implementation/v43](./v43-tool-templates.md)（ツールテンプレート）/ [ADR-0049](../docs/adr/0049-tool-templates.md)
- 影響範囲: `POST /tool-templates/:id/instantiate` の契約（破壊的）、ツール作成画面の「テンプレートから作成」

## 1. 問題

テンプレートから作った Tool の名前は**テンプレート側で固定**されている。

| 画面のメタデータ | 今の値 | 出どころ |
|---|---|---|
| 内部ID（`internalId`） | `period-series` | テンプレートの `id`（`toolName` 省略時の既定） |
| 公開名（`publishName`） | `period-series` | 同上 |
| 関数名（`agentName`） | `period-series` | 同上 |
| 表示名 / 作業名 | 「時系列の取り出し」 | テンプレートの `title` |

同じテンプレートから 2 本目を作ると、**内部IDまで同じ**になる。内部IDは Tool の同一性そのものなので、2 本目を保存すると 1 本目の**新しいバージョン**になり、別のツールを作ったつもりが最初のツールを置き換える。関数名が重複したエージェントでは後ろのツールが呼ばれない（[docs/19](../docs/19-troubleshooting.md) の `function-names`）。

人口の推移と賃金の推移を同じ `period-series` から作る、という一番ありふれた使い方で起きる。

## 2. 決定

**作成の時点で名前を必須にする。** 既定値で埋めない（既定があると押し通されて同じ名前が量産される）。

- **表示名**（人が読む名前。日本語可）と **関数名**（モデルに見える名前。英数字・`_`・`-`）の 2 つを必須で入力させる。
- 関数名は `internalId` / `publishName` / `agentName` の 3 つに入る（今の実装と同じ割り当て）。表示名は `displayName` / `workingName` に入る。
- **保存済みの Tool と重複する関数名は、その場で弾く**（保存まで待たない）。
- API は `toolName` を**必須**にする。省略時にテンプレート id へ落とす既定を無くす。

### なぜ 2 つ入力させるか

1 つに減らす案（表示名だけ受け取って関数名を機械生成する）は採らない。関数名はモデルがツールを選ぶときの手掛かりで、`period_series_2` のような機械名は選択の精度を落とす。逆に関数名だけにすると、一覧が英数字だらけになって人が探せない。空のキャンバスから作る経路（「新規作成」）でも人が両方を入力しており、揃えるのが自然である。

## 3. API（破壊的変更）

`POST /tool-templates/:id/instantiate` の body:

```jsonc
{
  "scope": { … }, "dataSourceIds": ["ds-population"], "language": "ja",
  "values": { … },
  "toolName": "population_series"   // 必須になった（以前は省略でテンプレート id）
}
```

- `src/api/schemas.ts`: `toolName: z.string().min(1).max(64)`（`.optional()` を外す）。形式は `^[A-Za-z0-9_-]{1,64}$` を課す（`createTool` の `agentTool.name` と同じ規則。手前で弾いて、保存時に初めて気づくのを避ける）。
- 形式違反・欠落は既存の 400（`invalid body`）で返る。エラー文は「何が悪いか」と「どう直すか」を含める（`toolName` は英数字・`_`・`-` で 1〜64 文字）。
- `src/application/tool-template/template-use-cases.ts`: `InstantiateToolTemplateRequest.toolName` を必須（`readonly toolName: string;`）にし、`request.toolName ?? template.id` の既定を消す。
- `src/api/tool-template-routes.ts`: 条件付きスプレッドをやめて常に渡す。

`GET /tool-templates` と `slot-candidates` は変えない。

## 4. 画面（ツール作成画面の「テンプレートから作成」）

スロットの入力欄の**下**、「作成」ボタンの直前に「名前」欄を 2 つ置く（テンプレートとデータソースを選んでから名前を考える順になる）。

| 欄 | 必須 | 規則 | 例・補足 |
|---|---|---|---|
| ツール名（表示名） | 必須 | 1〜80 文字。前後の空白は落とす | 「都道府県別人口の推移」。一覧とエージェントの選択画面に出る |
| 関数名 | 必須 | `^[A-Za-z0-9_-]{1,64}$` | `population_series`。モデルがこの名前でツールを選ぶ |

- **どちらも空で始める**。テンプレートの `title` や `id` を初期値に入れない。
- 「作成」は、スロットの必須が埋まっていることに加えて**両方が規則を満たすまで押せない**。押せない理由は既存の作法どおり欄の真下に出す（「ツール名を入力してください」「関数名は英数字・`_`・`-` で 1〜64 文字です」）。
- **重複チェック**: 保存済み Tool の `publishName` と一致する関数名は、その場で「この関数名はツール『〈表示名〉』が使っています。別の名前にしてください」と欄の下に出し、作成させない。比較は大文字小文字を区別しない。一覧は `client.listTools()` で取得する（ダイアログを開いたときに 1 回。取得に失敗してもダイアログは使える＝重複チェックだけ諦める。失敗を理由に作成を止めない）。
- 作成後の通知文は、名前を決め終えている前提に直す: 「テンプレート 〈id@version〉 から作成しました。所有者を設定して保存してください。」（今は「所有者と名前を確認して」）。

`loadTemplate(instantiated, displayName)` の呼び出しは、入力した表示名を渡す（今はテンプレートの `title` を渡している）。ストア側の割り当て（関数名 → `internalId` / `publishName` / `agentName`、表示名 → `displayName` / `workingName`）は変えない。

## 5. テスト（観点）

`src/api/tool-template-routes.test.ts`
- 正常: `toolName` を渡すと 200 で、その名前が `agentTool.name` に入る（既存テストの更新）。
- 異常: `toolName` が無い → 400。形式違反（日本語・空白・65 文字）→ 400 で、直し方を含む文言。

`src/application/tool-template/template-use-cases.test.ts`
- 正常: 渡した `toolName` が使われる。
- 従来どおり: 他の返り値（graph / inputSchema / pendingExpressions / template）は変わらない。
- 既定へ落ちる経路が無くなったことを型と合わせて更新する（テンプレート id が名前になるテストは消す・書き換える）。

`src/ui/tool-builder/TemplateDialog.test.tsx`
- 正常: 名前を 2 つ入れると「作成」が押せ、`instantiateToolTemplate` に入力した `toolName` が渡り、`loadTemplate` に入力した表示名が渡る。
- 異常: どちらかが空 → 作成は押せず、理由が欄の下に出る。
- 異常: 関数名に日本語・空白 → その場で指摘（API を呼ばない）。
- 異常: 既存 Tool と同じ関数名（大文字小文字違いを含む）→ その場で指摘し、API を呼ばない。
- 境界: 関数名 64 文字は可、65 文字は不可。表示名 80 文字は可、81 文字は不可。前後の空白だけの入力は空と同じ扱い。
- 例外: 一覧の取得に失敗しても、名前を入れれば作成できる（重複チェックだけ効かない）。
- 従来どおり: テンプレートを選ぶ・データソースを選ぶ・スロットを埋める既存の流れは変わらない。

`src/ui/tool-builder/ToolBuilder.templates.test.tsx`
- 従来どおり: 作成するとキャンバスへ移り、どのテンプレートから作ったかを通知する（通知文の更新に追随）。

it 名は日本語（`正常:` / `異常:` / `境界:` / `例外:` / 既存固定は `従来どおり:`）。

## 6. ドキュメント

- `docs/04-api-spec.md` §3.8: body の `toolName` を必須として書き直す（「省略するとテンプレート id」の記述を消す）。
- `docs/06-etl-tool-builder.md` §3.16: 流れの 4 番目として「名前を決める」を足し、なぜ必須か（同じテンプレートから 2 本目を作ると内部IDが衝突して 1 本目の新しいバージョンになってしまう）を 1 文で書く。
- `CHANGELOG.md`: 「変更」に 1 項目。利用者向けの言葉で、何が変わり、なぜ必要だったかを書く。

## 7. 非スコープ

- 既に同じ名前で保存されてしまった Tool の救済（内部IDの変更・分離）。
- 「新規作成」（空のキャンバス）の経路の入力順の変更。
- 表示名の重複チェック（表示名は重複しても壊れない）。
