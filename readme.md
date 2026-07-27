# agentblume

ノーコードでAIエージェントを組み立て・実行・検証するためのローカルIDE。ETLツールエンジンを中心に、エージェント／スキル／ツールの定義、動作確認、検証を1つのUIから行える。

- **スタック**: TypeScript / React 19 / Fastify / Vite / Vitest / Playwright
- **状態**: プレビュー（ローカル実行向け）

## 画面

サンプルデータを投入して実行中のアプリ（日本語UI）。画像は `npm run docs:screenshots` が実画面を操作して再生成する。操作手順は[デモデータ操作マニュアル](docs/13-demo-operation-manual.md)を参照。

| | |
|---|---|
| **チャット** — 保存済みAgentがToolを呼び出して応答（ライブモデル実行） ![チャット実行結果](docs/assets/demo-manual/07-chat-result.png) | **Tool Builder** — ETLノードフローの編集と固定サンプルプレビュー ![Tool Builder](docs/assets/demo-manual/02-tool-preview.png) |
| **Harness Builder** — マルチエージェント構成をパターン別の構造図で編集（Concurrentのfan-out＋集約） ![Harness Builder](docs/assets/demo-manual/08-harness-builder.png) | **Agent Factory** — やりたいこと＋データソースからAgent一式を自動生成・自動改善 ![Agent Factory](docs/assets/demo-manual/09-factory.png) |
| **データソース** — CSV/JSON登録とDB接続カタログ ![データソース](docs/assets/demo-manual/01-data-sources.png) | **長期記憶** — Wikiページの編集・検索とAgentへのアタッチ ![長期記憶](docs/assets/demo-manual/04-wiki-memory.png) |

## ローカル開発

PowerShellからAPIとUIをまとめて起動する。

```powershell
.\scripts\start-dev.ps1
```

ツール、スキル、エージェント、Wiki、CSV/JSONデータソースを含めて手動確認する場合は、専用のサンプルデータを投入して起動できる。既存IDがある場合は再作成しない。

```powershell
npm run dev:sample
# または .\scripts\start-dev.ps1 -SampleData
```

サンプルデータは既定の永続DBへ投入される（既存データは上書きしない）。使い捨てにしたい場合は `AGENTCONTEXT_DB_PATH=:memory:` を指定する。

画面付きの起動・操作・ライブAgent実行手順は[デモデータ操作マニュアル](docs/13-demo-operation-manual.md)を参照。

既定はAPI `3030`、UI `5173`。使用中の場合は既存プロセスを自動停止せず、起動前にエラーを返す。別ポートで起動する場合:

```powershell
.\scripts\start-dev.ps1 -ApiPort 3031 -UiPort 5174
```

主なオプション:

- `-Profile local|test`
- `-ApiOnly` / `-UiOnly`
- `-SampleData`: 手動確認用のCSV/JSON、Tool、Skill、Agent、Wikiを投入する。
- `-ApiPort <1-65535>` / `-UiPort <1-65535>`
- `-DryRun`: 子プロセスを起動せず、実行予定のコマンドと接続先を表示する。
- `-Stop`: API/UIポートを占有している開発プロセス(このリポジトリ由来と判定できたもの)を停止して終了する。異常終了などで残留したプロセスの掃除に使う。

テストと検証:

```powershell
npm test
npm run test:e2e
npm run typecheck
npm run build
```

## データの保存先

作成したTool・Skill・Agent・Wiki・実行履歴・モデル設定は SQLite に保存する。

- 既定の保存先は **`~/.agentblume/agentblume.db`**（親ディレクトリは自動作成）。起動時にログへ実際のパスを出す。
- 別の場所に置く場合は `AGENTCONTEXT_DB_PATH` を設定する。
- `AGENTCONTEXT_DB_PATH=:memory:` を指定したときだけ、プロセス終了で全データが消える（使い捨て検証用）。
- スキーマは起動時に自動でマイグレーションする。DBがこのビルドより新しい場合は、データを壊さないよう起動を中止する。
- UIから保存したAPIキーは暗号化して保存し、鍵は `~/.agentblume/secret.key`（`AGENTCONTEXT_SECRET_KEY_PATH` で変更可）に置く。**DBファイルをバックアップ・共有するときは鍵ファイルを一緒に運ばない**こと。
- DBファイル・鍵ファイルは `.gitignore` 済み。

読まれている環境変数の全量は [.env.example](.env.example) を参照。

## データソースとDB接続

CSV/JSONは「データソース」画面で登録し、Tool Builderのsourceノードから選択できる。DB接続情報とパスワードはbrowserに入力せず、backend環境変数で管理する。

- 設定例: [.env.example](.env.example)
- DBはPostgreSQLの読み取り専用sourceに対応する。`allowedTables`に列挙したtable/viewだけを、行数上限付きで読み取る。
- 任意SQL、書き込み、資格情報のUI入力・API返却は提供しない。

設計上の安全境界は[ADR-0029](docs/adr/0029-data-source-registry.md)を参照。

Web検索sourceは、Tavily、TinyFish、Google Custom Searchのキーをbackend環境変数で有効化して利用する。設定されていないproviderはTool Builderに表示されず、検索は作成者の「検索結果を取得」操作でだけ実行する。結果は15分のサーバー内キャッシュとしてTool graphから参照する。自動更新・永続キャッシュ・利用量予算は後続範囲であり、詳細は[ADR-0030](docs/adr/0030-optional-web-search-providers.md)を参照。

## ライセンス

[MIT License](LICENSE) © 2026 yy7613
