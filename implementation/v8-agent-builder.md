# v8 実装契約: Agent Builder とプロンプト自動生成

> Increment 8 の単一の真実。Increment 1〜7 を前提とする。

## 1. 目的

Agentをバージョン付き定義として保存し、選択したToolの公開名・固定バージョン・入出力・副作用から編集可能なsystem prompt草案を生成する。Agent画面でTool選択、草案生成、編集、保存までを完結させる。

## 2. Agent集約

- 共通メタデータ: internalId / workingName / displayName / publishName / version / owner / state / tenant。
- kind: `normal | pseudo-user | evaluator`。
- systemPromptと、バージョン固定したTool参照を保持する。
- Tool参照は保存時に存在確認し、暗黙にlatestへ追従させない。
- structured output、Skill参照、複数Tool実行は後続Incrementで追加する。

## 3. Prompt generation

- ToolのdisplayName / publishName / sideEffect / inputSchema / outputSchemaを入力に、役割・Tool使用ガイド・安全規則を決定的に生成する。
- `systemPromptDraft`、セクション別テキスト、参照元を返す。
- 草案は保存を伴わず、常に人が編集できる。
- LLM Providerは使用しない。同じ入力から同じ草案を再生成できることを優先する。

## 4. Repository / API

- AgentRepository PortとInMemory / SQLite adapterを実装する。
- `POST /agents`、`GET /agents`、`GET /agents/:id`、`GET /agents/:id/versions`。
- `POST /agent-drafts/generate-prompt` は未保存定義向け。
- `POST /agents/:id/generate-prompt` は保存済みバージョン向け。
- Agent BuilderのTool選択用に `GET /tools` で各internalIdのlatest summaryを返す。

## 5. UI

- Agentナビを有効化する。
- メタデータ、kind、Tool複数選択、system prompt編集欄を表示する。
- Generate draftとSave versionを明示的に分離する。
- 保存結果のversionとエラーを画面内に表示する。

## 6. 完了条件

- Agent domain / serialization / repository contract tests。
- save / query / prompt generation use case tests。
- API validation・scope分離・version conflict tests。
- Agent Builder UI tests。
- Playwright E2EでTool preview/saveとAgent prompt生成/saveを、実ブラウザと実HTTP境界で確認する。
- typecheck、全test、coverage、depcruise、production buildが成功する。

## 7. E2E実行

- 初回のみ `npm run test:e2e:install` でChromiumを取得する。
- `npm run test:e2e` はtest profileのAPIを3035、Vite UIを5175で自動起動する。
- E2Eは既存の開発サーバーを再利用せず、終了時に起動プロセスを停止する。
