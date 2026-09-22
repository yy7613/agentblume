# v47: ツール作成画面の設計アシスタント（チャットで指示するとノードが増える）

- 決定の記録: [ADR-0051](../docs/adr/0051-tool-design-chat.md)
- 前提: [ADR-0046](../docs/adr/0046-calculate-expression-assistant.md)（関数電卓の式提案: 提案 → 検分 → 1 回だけ差し戻し）/ [ADR-0047](../docs/adr/0047-factory-lessons-from-estat.md)（12B の機械的な書き間違いは正規化で消す）/ [ADR-0048](../docs/adr/0048-staged-tool-generation.md)

## 1. ねらい

ツール作成画面に、Claude Code や Codex のように**自由な文章で指示するとキャンバスのノードが増えたり変わったりする**アシスタントを付ける。

- 「都道府県別の人口を、年次に絞って、人口の多い順に 10 件返すツールにして」→ source の後ろに parse-period / filter / sort / limit が繋がる。
- 「地域を引数で絞れるようにして」→ agent-input に引数が増え、filter に valueBinding が付く。
- 「この結合、キーが足りない？」→ ノードを変えずに答えだけ返す。

保存はしない。返るのはキャンバスへ展開する**編集後のグラフ**で、保存は従来の「バージョンを保存」。

## 2. 方針

1. **モデルはグラフ全体を書かず、編集操作（operation）を返す。** 人が組んだ部分（配置・設定）を壊さず、何が変わったかを見せられる。語彙は 5 つ（§4）。
2. **適用は決定的。** 操作をグラフに当てるのは純関数で、鎖への挿入・除去の配線は関数が行う（モデルにエッジを書かせない場面を減らす）。
3. **検査してから返す。** 適用後のグラフを既存の正規化（`normalizeProposedGraph`）→ スキーマ伝播 → 設計時プレビューに掛け、落ちたら **1 回だけ**理由を添えて出し直させる（ADR-0046 と同じ）。それでも通らなければ**グラフは変えずに**、説明と理由だけ返す。
4. **前の状態へ戻せる。** 画面は各ターンの適用前のグラフを持ち、「この変更を取り消す」で戻す。
5. **既存の関数電卓アシスタントと同じモデル・同じ有効化条件**（メインモデルが設定されていれば使える）。

## 3. API

`POST /tool-drafts/design-chat`（認可: `execute` on `tool`。設計時プレビューでデータを読むため `preview` と同じ）

```jsonc
// request
{
  "scope": { … },
  "graph": { "nodes": [ … ], "edges": [ … ] },          // いまのキャンバス（position つき。`currentGraph()` そのまま）
  "inputSchema": { "columns": [ … ] },                   // 任意。agent-input の宣言（無ければ graph の agent-input から読む）
  "instruction": "地域を引数で絞れるようにして",
  "transcript": [                                         // 直近の会話（画面が持つ。最大 12 ターン、古い順）
    { "role": "user", "content": "…" },
    { "role": "assistant", "content": "…" }
  ]
}
// → 200
{
  "message": "地域コードを引数 region にして、filter を束縛しました。省略すると全地域を返します。",
  "graph": { "nodes": [ … ], "edges": [ … ] },          // 編集後。変えなかったノードは position を保つ。変更が無ければ省略
  "changes": [                                            // 画面が一覧に出し、ノードを強調する
    { "op": "set-config", "nodeId": "agent-input", "summary": "引数 region (string, 省略可) を追加" },
    { "op": "set-config", "nodeId": "filter-1", "summary": "地域コード eq → 引数 region に束縛" }
  ],
  "repaired": false,                                      // 1 回差し戻して通った
  "problems": []                                          // 適用できなかったときだけ。理由と直し方（人向け）
}
```

- 変更なし（質問への回答・曖昧で聞き返す）は `graph` を省略し `changes: []`。
- 適用できなかった（差し戻しても通らない）ときは `graph` を省略し、`problems` に理由（英語の原文。画面側で既存の `localizeDetail` 経路へ通す）と、モデルの説明 `message` を返す。HTTP は 200（失敗はアシスタントの応答であって API の失敗ではない）。
- モデル未設定は関数電卓アシスタントと同じ 502 `MODEL_PROVIDER`（`not configured` を含む文言。当初は 409 `MODEL_NOT_CONFIGURED` を想定したが、そのコードは存在せず、画面は先に `/runtime/capabilities` で案内するため、ここへ落ちるのは競合時だけ）。モデル呼び出しの失敗も同じ系。
- 応答には `promptTemplateVersion`（どの文面で得た応答か）と、差し戻したときだけ `repairedFrom`（1 回目の失敗理由の英文。画面には出さず、プロンプトを調整する運用者の材料）が付く。
- `GET /runtime/capabilities` に `designAssistant: { enabled: boolean }` を足す（`calculateAssistant` と同じ判定）。

## 4. 編集操作の語彙（モデルの出力）

構造化出力（strict JSON schema）:

```jsonc
{
  "message": "人が読む説明（指示の言語で。何をしたか / 何が足りないか / 確認したいこと）",
  "operations": [
    { "op": "add-node", "id": "sort-1", "type": "sort", "config": { … }, "after": "filter-1" },
    { "op": "remove-node", "id": "distinct-1" },
    { "op": "set-config", "id": "filter-1", "config": { … } },
    { "op": "connect", "from": "csv-2", "to": "join-1", "toInput": 1 },
    { "op": "disconnect", "from": "a", "to": "b" }
  ]
}
```

| op | 意味 | 決定的な配線 |
|---|---|---|
| `add-node` | ノードを足す。`after` を指定すると**その直後の鎖に挿入**する | `after → id` を張り、`after` の既存の出力エッジ（1 本のとき）を `id → 元の宛先` に付け替える。`after` 省略は孤立ノード（続く `connect` で繋ぐ。source を足すときはこれ） |
| `remove-node` | ノードを外す | 入力 1・出力 1 なら上流と下流を直結する。それ以外は繋がずに外す |
| `set-config` | config を**丸ごと**置き換える | — |
| `connect` / `disconnect` | エッジの追加・削除 | `toInput` は 2 入力ノード（join / union）だけ |

- `id` は `^[a-z][a-z0-9-]{0,39}$`。既存と重複する `add-node` は違反。存在しない `id` への操作も違反。
- 適用は `src/domain/etl/graph-edit.ts` の純関数 `applyGraphOperations(graph, operations): { graph, applied: GraphChange[] }`。違反は `GraphEditError`（op の位置と理由）。
- 適用の前に `canonicalizeOperationIds` で id の綴りの揺れ（大小・`_`・空白）を畳む（実測: 同じ応答の中で `source-e-stat` と `source-e_stat` が混在し、差し戻しでも直らなかった）。一意に決まるものだけ直し、曖昧なものは触らずに弾かせる。
- `normalizeProposedGraph` は、引数に束縛した単一値の filter の空の `value` に実在値を種として置き（画面のプレビューが 0 行にならないように）、`agent-output` の書き忘れた必須項目（`maxRows` / `maxBytes` / `overflow`）を既定で埋める（実測: どちらも毎回 1 回目で落ちていた）。

## 5. 使えるノードとカタログ

モデルに見せるのは **パレットにある種別すべて**（業務テンプレート専用ノードは除く）。種別ごとの config 契約は `src/application/tool/node-catalog.ts` に**英語 1〜3 行**で持つ（ToolSmith の文を再利用し、無い種別を足す: cast / calculate / group-by / fill-null / replace / union / outlier-filter / correlation-analysis / time-series-analysis / chart-output / workspace-output / current-datetime / ai-judge）。`calculate` の式の書き方は関数電卓の文法（角括弧で列参照）を 1 行で示す。

カタログはテストで**レジストリと突き合わせる**（載っている種別がすべて登録済み、パレットの種別がすべて載っている）。

## 6. サーバー側の流れ（`DesignToolChatUseCase`）

1. **材料**: `ResolveDataSourceGraphUseCase` で source を解決 → `engine.propagateSchemas` で各ノードの出力列 → 終端の設計時プレビュー（`rowLimit` 5、失敗しても材料から外すだけ）→ 登録済みデータソースの一覧（id・名前・形式）と、グラフが参照するソース + 先頭 6 件までのプロファイル（列・型・期間列・カテゴリ列。`ProfileDataSourcesUseCase`）。
2. **プロンプト**: system = 役割 + 規則 + ノードカタログ + 操作の語彙。user = `wrapUntrusted('tool-design-input', { graph, schemasByNode, terminalSample, dataSources, transcript, instruction })`。**指示文も会話もデータ側**（untrusted）に置く。
3. **適用**: 応答を zod で読む → `applyGraphOperations` → `normalizeProposedGraph`（既存。`toInput` 欠落・型名の揺れ・`value`/`values` などを直す）→ `engine.propagateSchemas`（構造・列の存在）→ 設計時プレビュー（`agent-input` の sample を束縛。行が作れるか）。
4. **差し戻し 1 回**: 3 のどこかで落ちたら、エラー文（nodeId つき）と「操作は元のグラフに対して書き直す」を添えて再依頼。2 回目も落ちたら `graph` 無し・`problems` あり。
5. **返す**: 変えなかったノードの `position` を元のグラフから写す。`changes` は適用した操作から人向けの要約を決定的に作る（種別・ノード id・config の要点）。

規則（system。ADR-0047 で効いた文を流用）:
- 操作は**いまのグラフ**に対して書く。書き直しではなく差分。関係ないノードに触らない。
- 列名はスキーマにある名前だけ。期間の文字列列は parse-period → 粒度 filter → 日付 filter。引数は agent-input の schema に宣言し filter の valueBinding で束縛。日付引数は `type: "date"`。
- 終端は agent-output ちょうど 1 つ。出力は sort + limit で必ず抑える。
- 指示が曖昧なら、操作を空にして `message` で聞き返す。質問には操作なしで答える。
- `message` は指示と同じ言語。

## 6b. 意味の検査（実測で足したもの）

検証を通っても答えが間違う形を、差し戻しの理由にする。**硬い問題**（直らなければ適用しない）: 期間ラベルの文字列列での並べ替え / 設計時プレビューが 0 行（`diagnoseEmptyResult` の空振り条件つき）。**柔らかい問題**（1 回目だけ差し戻し、2 回目は `warnings` として適用する）: 粒度が混在する期間列に粒度の filter が無い。応答の `warnings: string[]`（英語の原文）を画面は黄色の注記（`design-chat-warnings`, role=note）で出す。差し戻しの段は `semantic`（`prompts/tool/design-chat.md` の `repair.semantic`）。

## 7. 画面

- ツール作成画面のヘッダ（`MetadataBar`）に「**設計アシスタント**」ボタン。押すと右側に縦のチャットパネルが開く（`NodeInspector` の隣、幅 320px。もう一度押すか × で閉じる。開閉は localStorage に覚える）。モデル未設定なら関数電卓と同じ文言で案内し、入力欄は無効。
- パネル: 会話（自分の指示 / アシスタントの返答 + 変更一覧）・入力欄（複数行、Enter で送信・Shift+Enter で改行）・送信中は入力を無効にして「考えています…」。
- 返答に `graph` があれば **即座にキャンバスへ適用**する（確認ダイアログは出さない。取り消しで戻せる）。新しいノードは `after` の右（x+220）に置き、`after` が無ければ既存の最右列の右に縦に並べる。追加・変更したノードは 4 秒間強調（`node-highlight` クラス）し、最初の変更ノードを選択状態にする。
- 各アシスタントの返答に「**この変更を取り消す**」。押すとそのターンの適用前のグラフへ戻す（以後のターンの変更も戻る。会話は残し、返答に「取り消し済み」と付く）。
- `problems` があるときは返答の下に赤い枠で理由（`localizeDetail` で日本語化）を出す。キャンバスは変えない。
- ストア: `designChat: { open, turns: [{ id, user, assistant?, changes, before?: {nodes, edges}, reverted, problems }], busy, error }`。会話は下書き（`ToolBuilderDraft`）には入れない。別のツールを開く / 新規作成 / テンプレートから作成で会話は消える。
- 送るのは直近 12 ターン（`role` と `content` だけ。変更一覧は送らない）。

## 8. 検証

- domain `graph-edit.test.ts`: 挿入の配線・除去の直結・2 入力への connect・重複 id・未知 id・鎖の途中への挿入で既存エッジが付け替わる・disconnect。
- application `design-tool-chat.test.ts`（`ScriptedModelProvider`）: 正常（操作が適用され、変えないノードの position が保たれ、changes が出る）/ 変更なしの返答 / 1 回目が列名を間違え、差し戻しで通る（`repaired: true`）/ 2 回とも落ちる（graph 無し・problems あり・元のグラフに触らない）/ 正規化が効く（`toInput` 欠落）/ untrusted の隔離（指示文が system に混ざらない）/ 会話が 12 ターンに切られる / モデル未設定。
- `node-catalog.test.ts`: レジストリとの突き合わせ。
- API: 200 / 409 / 400（本文）/ 認可。
- UI（`DesignChatPanel.test.tsx` / `store.test.ts`）: 送信 → 適用 → 強調と選択 / 取り消し / problems の表示 / モデル未設定 / Enter と Shift+Enter / 別ツールを開くと消える。
- **実機**（親が行う）: LM Studio + e-Stat の CSV で、①空のキャンバスから「都道府県別の総人口を年次に絞って多い順に 10 件」②続けて「地域を引数で絞れるように」③「この結合のキーは足りている？」の 3 ターンを通す。

## 9. 非スコープ

- 保存・公開の自動化。会話の永続化。複数ツールにまたがる操作。
- チャットからのデータソース登録（未登録のファイルは「データソース画面で登録して」と返す）。
- ノードの位置の細かな整列（自動配置は「右に 1 つ」だけ）。
