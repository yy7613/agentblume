# v49: 設計アシスタントの文脈管理（消費比率・履歴の圧縮とクリア）と、Tool Calling 契約の説明の更新

- 前提: [implementation/v47](./v47-tool-design-chat.md)（設計アシスタント）/ [ADR-0051](../docs/adr/0051-tool-design-chat.md)
- 実装契約の追補（ADR は増やさない。v47 の決定の範囲内）

## 1. 問題

1. **会話は反映されているが、どれだけ文脈を使っているかが見えない。** 毎ターン、system（規則 + 29 種のノードカタログ）+ グラフ + スキーマ + プロファイル + 会話 + 指示を送る。ローカルモデルではコンテキスト長が小さく設定されていることが多く（LM Studio の既定は 4,096）、超えると黙って先頭が切られるか失敗する。
2. **会話を減らす手段が「別のツールを開く」しかない。** 直近 12 ターンで切ってはいるが、長い返答が続くと 12 ターンでも大きい。人が「もう要らない」と判断した会話を圧縮・消去できない。
3. **Tool Calling 契約の説明（`agentTool.description`）を変えられない。** 操作の語彙がノードとエッジだけで、説明文は要求にも含まれていない。実測（ADR-0047）で、引数の書式・粒度の綴り・日付の意味を説明文に書くことが正答率に直結した。引数を足したのに説明文が古いままだと、エージェントが誤った値を渡す。

## 2. 決定

| 項目 | 決定 |
|---|---|
| 消費比率 | 直前の呼び出しの `usage.promptTokens`（モデルが数えた実数）と、プロバイダから取れるコンテキスト長で `promptTokens / contextWindow` を出す。コンテキスト長が取れなければトークン数だけ出す（推定はしない） |
| コンテキスト長の取得 | `ModelProviderPort.contextWindow?(): Promise<number \| undefined>`（任意メソッド）。LM Studio は `<host>/api/v0/models/<id>` の `loaded_context_length ?? max_context_length`（best-effort・失敗は undefined・プロセス内で 60 秒キャッシュ）。他のプロバイダは未実装 = undefined |
| 圧縮 | **モデルに要約させる**。古いターン（指示・返答・適用した変更の要約）を材料として渡し、決定・意図・未解決の点を短い覚え書きにまとめさせる。直近 4 ターンは原文のまま残す。要約は会話の先頭に 1 ブロックとして送る |
| クリア | 会話と要約を消す。キャンバスは変えない |
| 説明文の更新 | 操作 `set-agent-tool { description, name? }` を語彙に足す。要求に現在の `agentTool` を載せ、応答に更新後の `agentTool` を返す |

圧縮をモデルに任せる理由: 会話には「全国は除きたい」「地域は引数にする」のような**決定と意図**が散らばっており、機械的な切り詰めでは落ちる。適用した操作の要約（`changes[].summary`）は正確な記録なので、材料として一緒に渡す。要約の文は untrusted data として次のターンに載る（system には混ぜない）。

## 3. API

### 3.1 `POST /tool-drafts/design-chat/compact`（新設。認可: `execute` on `tool`）

```jsonc
// request
{
  "scope": { … },
  "previousSummary": "…",                                          // 任意。前回までの要約（あれば新しい要約に取り込む）
  "turns": [                                                       // 畳む古いターン（古い順。最大 40）
    { "user": "都道府県別の総人口を年次に絞って…", "assistant": "…", "changes": ["added parse-period 'period' after 'src' …", "…"] }
  ],
  "language": "ja"
}
// → 200
{ "summary": "…", "usage": { "promptTokens": 1200, "completionTokens": 180, "contextWindow": 200192 } }
```

- モデルは `prompts/tool/design-chat-compact.md`（新設）の system で呼ぶ: 「ツール設計の会話の古いターンを、次のターンで読む**覚え書き**にまとめる。残すもの = 利用者の目的・決めたこと（何を引数にした、何を除いた）・適用した変更の要点・未解決の質問。落とすもの = 挨拶・言い直し・途中の失敗。指示と同じ言語。800 字以内。箇条書き」。材料（`previousSummary` と `turns`）は `wrapUntrusted('tool-design-compact-input', …)` で user メッセージへ。構造化出力 `{ "summary": string }`。
- 空の要約・800 字超（末尾を切らずに 1 回だけ「短くして」と差し戻す。それでも超えたらそのまま返す）。モデル未設定は 502 `MODEL_PROVIDER`（既存）。
- `usage` は §3.2 と同じ形。

### 3.2 `POST /tool-drafts/design-chat` の追加項目

```jsonc
// request（追加のみ）
{
  "agentTool": { "name": "population_top", "description": "…" },   // 任意。いまの Tool Calling 契約（画面のメタデータ）
  "transcriptSummary": "…",                                        // 任意。圧縮済みの古い会話（画面が作る。最大 4,000 字）
  "transcript": [ … ]                                              // 従来どおり直近の会話
}
// response（追加のみ）
{
  "agentTool": { "name": "population_top", "description": "…" },   // set-agent-tool を適用したときだけ
  "usage": { "promptTokens": 6812, "completionTokens": 240, "contextWindow": 200192 }  // 直前の呼び出し。取れない項目は省略
}
```

- `changes` に `{ "op": "set-agent-tool", "nodeId": "agent-tool", "summary": "set the tool description for the agent (…先頭 80 字…)" }`。`nodeId` は強調の対象にならない固定値。
- `usage` は差し戻しがあれば **2 回目**の呼び出しの値（次のターンの目安に近い方）。`contextWindow` は `provider.contextWindow()` の結果。

## 4. サーバー側

- `src/application/model/model-provider.ts`: `contextWindow?(): Promise<number | undefined>` を `ModelProviderPort` に任意で足す。
- `src/adapters/model/lm-studio-model-provider.ts`: 実装。`baseUrl` が `…/v1` で終わるときだけ `…/api/v0/models/<model>` を GET（タイムアウト 3 秒）。応答の `loaded_context_length ?? max_context_length` が正の整数ならそれ。失敗・非数は undefined。60 秒キャッシュ。ログは debug のみ（失敗は正常系）。
- `src/domain/etl/graph-edit.ts` は変えない（`set-agent-tool` はグラフの操作ではない）。`design-tool-chat.ts` が応答の操作を **グラフ操作**と **agentTool 操作**に分け、前者は従来どおり、後者は `agentTool` に当てる。検査: `description` は 1〜4,000 字、`name` は `^[A-Za-z0-9_-]{1,64}$`。違反は `GraphEditError` と同じ形の文で `apply` 段の差し戻し。
- プロンプト（`prompts/tool/design-chat.md`）: 語彙に `set-agent-tool` を足し、規則に 2 行: 「`agentTool.description` はエージェントが呼ぶ前に読む唯一の文。引数の書式（日付は ISO・期間の開始日）、粒度の綴り、データの範囲、返る列を書く」「引数を足した・変えたときは `set-agent-tool` で説明文も更新する（説明が古いと誤った値を渡す）」。payload に `agentTool` と `earlierConversationSummary` を足し、system に「`earlierConversationSummary` はこの会話の古いターンを畳んだもの」を 1 行。
- 応答に `usage`。差し戻し無しなら 1 回目、有りなら 2 回目の `completion.usage` と `contextWindow()`。
- **圧縮**: `DesignToolChatUseCase.compact({ scope, previousSummary, turns, language })` → `{ summary, usage }`。プロンプトは `prompts/tool/design-chat-compact.md`（spec `DESIGN_CHAT_COMPACT_PROMPT`、節 `system` / `repair.shorten`）。応答は zod（`{ summary: string }`）で読み、空なら 1 回だけ差し戻し、800 字超も 1 回だけ「短くして」（`repair.shorten`）。2 回目も駄目なら得られた文をそのまま返す（要約が長くても会話全体よりは短い）。

## 5. 画面

- **メーター**: パネルの見出しの下に 1 行。`contextWindow` があれば「文脈 6.8k / 200k（3%）」、無ければ「文脈 約 6.8k トークン」。70% 以上で黄、90% 以上で赤にし、赤のときは「履歴を圧縮するか、クリアしてください」を添える。値は直前の応答の `usage`（送信前には出さない。推定しない）。
- **圧縮**（「履歴を圧縮」）: `turns` が 5 以上のとき押せる（モデル未設定なら押せない）。直近 4 ターンを残し、それより古いターンを `POST /tool-drafts/design-chat/compact` に渡す（`turns[].changes` は `changes[].summary` の配列、`previousSummary` は現在の要約）。送信中は「要約しています…」でボタンと入力欄を無効にする。応答の `summary` を `designChat.summary` に**置き換え**（前回の要約は材料として渡してあるので、足さない）。畳んだターンは一覧から消え、先頭に「圧縮済み（N ターン）」のブロック（畳んで要約を読める）になる。**畳んだターンの「取り消し」は効かなくなる**ので、ボタンの補助文に書く。失敗（502 など）は会話を変えずに、既存のエラー表示に出す。
- **クリア**（「履歴をクリア」）: 会話・要約・メーターを消す。キャンバスは変えない。1 クリックで消す（下書きの会話は資産ではない）。
- **説明文の更新**: 応答に `agentTool` があれば `metadata.agentName` / `agentDescription` へ反映し、`changes` の要約に出す。取り消しは `before` に `agentTool` も含めて戻す。
- 送信本文に `agentTool: { name: metadata.agentName, description: metadata.agentDescription }`（両方空なら省略）と `transcriptSummary`。

## 6. テスト（観点）

- adapter: `contextWindow()` が `loaded_context_length` を優先し、無ければ `max_context_length`、失敗・非数は undefined、60 秒キャッシュ、`/v1` で終わらない baseUrl では呼ばない。
- use case: `set-agent-tool` の適用と検査（空・4,001 字・不正な name）、応答の `agentTool` と `changes`、`usage` と `contextWindow` の合成（差し戻し時は 2 回目）、`transcriptSummary` が payload の `earlierConversationSummary` に入り system に混ざらない、`contextWindow()` の無いプロバイダでも動く（従来どおり）。
- API: 本文の新項目の検証（summary 4,001 字は 400）。
- use case（圧縮）: 材料が untrusted に入る・`previousSummary` が材料に入る・空の要約は 1 回差し戻す・800 字超は 1 回「短くして」・2 回目も駄目ならそのまま返す・`usage` が付く。API: `turns` 41 件は 400、モデル未設定は 502。
- UI: メーターの 3 状態（不明 / 通常 / 警告）、圧縮（4 ターン残る・API に古いターンと `previousSummary` が渡る・応答の要約で置き換わる・送信中の表示・失敗時は会話を変えない・取り消し不能の表示・4 ターン以下と未設定では押せない）、クリア、`agentTool` の反映と取り消し、送信本文の新項目。
- 実機（親）: 長い会話を作って比率が上がること、圧縮後に比率が下がること、「説明文に粒度の綴りと日付の渡し方を書いて」で説明文が更新されること。

## 7. 非スコープ

- 圧縮の自動実行（比率が高いときに勧めるだけで、勝手には畳まない）。送信前のトークン推定。LM Studio 以外のコンテキスト長の取得。
- グラフ・カタログ側の削減（消費の大半はここだが、別の増分）。
