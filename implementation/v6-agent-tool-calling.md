# v6 実装契約: Agent Tool Calling 縦切り

> Increment 6 の単一の真実。前提は Increment 1〜5。

## 1. 目的

保存済み Tool をローカル LLM へ function tool として提示し、LLM が生成した引数を検証して ETL を実行し、その結果を使った最終応答と最小トレースを Tool Builder の横並びチャットで確認できるようにする。

## 2. Agent input

- `agent-input` source node を追加する。
- config は `{ schema, sample }`。draft preview では `sample` を1行として使う。
- Tool 保存時は `agent-input.schema` を `Tool.inputSchema`、終端ノードの伝播結果を `Tool.outputSchema` として保存する。
- Agent 実行時は Tool Calling 引数を `inputSchema` で検証・正規化し、`agent-input.sample` を置換して ETL を実行する。
- `date` 引数は JSON の ISO文字列を `Date` へ正規化する。

## 3. ModelProviderPort

- application 所有の共通 message / tool / completion 型を定義する。
- `complete(request)` と `capabilities()` を公開する。
- v6 は非ストリーミング chat completion と `tool-calling` capability に限定する。
- adapter 固有のレスポンス・例外・JSON文字列 arguments は境界内で共通型へ変換する。

## 4. LM Studio adapter

- OpenAI互換 `POST /v1/chat/completions` を使用する。
- base URL / model / API key / timeout は Composition Root で `LM_STUDIO_BASE_URL` / `LM_STUDIO_MODEL` / `LM_STUDIO_API_KEY` / `LM_STUDIO_TIMEOUT_MS` から注入する（modelはAgent実行時必須、timeout既定120秒）。
- HTTP失敗、timeout、不正response、不正tool argumentsを `ModelProviderError` へ正規化する。
- test profile は外部通信しない `ScriptedModelProvider` を使用する。

## 5. Agent preview use case

`RunAgentPreviewUseCase` は次を行う。

1. scope + internalId + version で Tool を取得する。
2. preview/test では `read-only` Tool だけを許可する。
3. Tool metadata / Input Schema を function tool definition へ変換する。
4. modelへ system + user message + tool definition を送る。
5. tool call が無ければその応答を返す。
6. tool名と引数を検証し、ETLを行数制限付きで実行する。
7. 宣言済み Output Schema と実出力を検証する。
8. tool resultをmodelへ返し、最終応答を得る。
9. model request / tool call / node outputs / model response の最小traceを返す。

v6 は1回の実行につき1 Tool・最大1 Tool callとする。Agent永続化、複数Tool選択、ストリーミング、Mastra adapter、trace永続化は後続Incrementへ分離する。

## 6. HTTP / UI

- `POST /runs`: `{ scope, tool: { internalId, version? }, systemPrompt, message, mode }` → `{ run }`。
- Tool Builder 下部へ Agent Chat を追加し、保存済みversionを固定して実行する。
- 応答、tool call引数、各ノード行数・truncated、エラーを表示する。
- UI は既存どおり HTTP DTO だけに依存する。

## 7. 完了条件

- agent-input / schema変換 / 引数・出力検証の単体テスト。
- ModelProviderPort契約を Scripted provider と mocked LM Studio adapterへ適用。
- direct response と tool call 2段推論の use case / HTTP 統合テスト。
- UI chat の保存前抑止・実行・trace表示テスト。
- `npm run typecheck`, `npm test`, `npm run test:cov`, `npm run depcruise`, `npm run build` が成功する。
