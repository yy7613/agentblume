# v13 実装契約: 残り4画面

> Increment 13 の単一の真実。Increment 1〜12を前提とする。

## 1. 目的

左ナビで無効だったChat、MCP、Validation、Settingsを有効化し、既存の保存・実行APIを使って安全に操作できる8画面構成を完成させる。

## 2. 画面契約

- Chat: 保存済みAgentのlatest versionを選び、preview実行して応答とtraceを表示する。
- MCP: 保存済みToolを選び、version固定manifestをpreviewする。認証・認可・監査アダプターがない間は外部公開をfail closedとする。
- Validation: 保存済みAgentをtest modeで実行し、期待Tool公開名とRun記録を照合してPASS/FAILを表示する。
- Settings: API health、local scope、Model Provider環境変数、安全ゲートを表示する。サーバー環境変数や秘密値はブラウザから変更しない。

## 3. 非目標

- MCP endpointの実公開。
- ValidationCase/Reportの永続化と複数ケース集計。
- ブラウザからのサーバー環境変数・秘密値変更。

## 4. 完了条件

- 8つのナビがすべて有効である。
- 各画面にcomponent testがある。
- Playwrightで4画面を横断し、Chat実行、MCP manifest、Validation判定、Settings healthを確認する。
- typecheck、全test、coverage、depcruise、production buildが成功する。
