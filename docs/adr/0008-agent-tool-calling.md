# ADR-0008: Agent previewをModelProviderPortと非永続runで縦切りする

- Status: Accepted
- Date: 2026-07-03
- Context doc: [04-api-spec.md](../04-api-spec.md), [07-execution-model.md](../07-execution-model.md)

## Context

Increment 5 で Tool の編集・preview・version保存がUIから完結した。代表ジャーニー⑤の Agent 接続には、LLM provider固有型を中核へ漏らさず、Tool Input Schemaをfunction toolへ変換し、生成引数を実際のETL入力へ渡す境界が必要である。既存sourceは固定サンプルだけであり、LLM引数を受け取れない。

## Decision

- application所有の `ModelProviderPort` を定義し、local profileはLM StudioのOpenAI互換chat completions adapter、test profileはscripted adapterを注入する。
- `agent-input` source nodeを追加し、draftでは固定sample、Agent実行では検証済みTool Calling引数を使う。
- v6のAgentは永続化せず、保存済みTool 1本とinline system promptを使うpreview構成とする。
- model orchestrationは `RunAgentPreviewUseCase` に置き、1 Tool・最大1 Tool call・非ストリーミングに制限する。
- preview/testはread-only Toolだけを実行する。write/external-actionは認可・承認導入までfail closedとする。
- 応答と同時に最小traceを返し、Tool Builderの横並びchatで表示する。

## Consequences

- Tool Calling引数が固定sampleではなくETLへ実際に流れる。
- LM Studio固有のHTTP形式と障害はadapter内に閉じる。
- Agent/traceの永続化、複数Tool、streaming、Mastra `AgentRuntimePort` は未実装であり、共通契約が安定した後続Incrementで追加する。

## 実装契約

[implementation/v6-agent-tool-calling.md](../../implementation/v6-agent-tool-calling.md) を単一の真実とする。
