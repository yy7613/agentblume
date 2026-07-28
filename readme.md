# agentblume

ノーコードでAIエージェントを組み立て・実行・検証するためのローカル開発スタジオ。ETLツールエンジンを中心に、エージェント／スキル／ツールの定義、動作確認、検証を1つのUIから行える。

- **スタック**: TypeScript / React 19 / Fastify / Vite / Vitest / Playwright
- **状態**: プレビュー（ローカル実行向け・**認証機能は未実装**）

> **はじめての方へ** → **[クイックスタート](docs/18-quickstart.md)**（インストール → 起動 → モデル設定 → サンプル → 自分のデータ）
> **動かない** → [トラブルシューティング](docs/19-troubleshooting.md)

## できること

| | |
|---|---|
| **データを繋ぐ** | CSV/JSONのアップロード、読み取り専用のPostgreSQL接続、Web検索（要APIキー） |
| **ツールを作る** | ETLノードをつないで、決定的で再実行可能なデータ処理を作る。LLMを使わないのでプレビューが速く、結果が毎回同じ |
| **エージェントを組み立てる** | スキル・ツール・Wikiを割り当て、システムプロンプトを自動生成。バージョン付きで保存する |
| **複数エージェントを連携させる** | Sequential / Concurrent / Handoff / Group Chat / Magentic / Agent-as-tools の6パターン |
| **自動生成する** | 「やりたいこと」とデータソースから、ツール・スキル・エージェント・検証資産一式をAgent Factoryが生成し、疑似ユーザー検証で自動改善する |
| **検証する** | ペルソナ×シナリオの疑似ユーザー会話、バッチ実験、LLM-as-judge採点、品質ゲートと昇格承認 |
| **運用する** | 実行トレース、長期記憶（Wiki）、MCPサーバー設定、バックアップ／復元 |

モデルは**ローカル（LM Studio等のOpenAI互換サーバー）でもクラウドAPIでも**動く。プロバイダとモデルは設定画面から選べ、APIキーは暗号化して保存される。

## 画面

サンプルデータを投入して実行中のアプリ（日本語UI）。画像は `npm run docs:screenshots` が実画面を操作して再生成する。操作手順は[デモデータ操作マニュアル](docs/13-demo-operation-manual.md)を参照。

| | |
|---|---|
| **チャット** — 保存済みAgentがToolを呼び出して応答（ライブモデル実行） ![チャット実行結果](docs/assets/demo-manual/07-chat-result.png) | **ツールビルダー** — ETLノードフローの編集と固定サンプルプレビュー ![ツールビルダー](docs/assets/demo-manual/02-tool-preview.png) |
| **マルチエージェント** — 複数Agentの連携をパターン別の構造図で編集（Concurrentのfan-out＋集約） ![マルチエージェントビルダー](docs/assets/demo-manual/08-harness-builder.png) | **Agent Factory** — やりたいこと＋データソースからAgent一式を自動生成・自動改善 ![Agent Factory](docs/assets/demo-manual/09-factory.png) |
| **データソース** — CSV/JSON登録とDB接続カタログ ![データソース](docs/assets/demo-manual/01-data-sources.png) | **長期記憶** — Wikiページの編集・検索とAgentへのアタッチ ![長期記憶](docs/assets/demo-manual/04-wiki-memory.png) |

## 必要なもの

| | 要件 | 備考 |
|---|---|---|
| **Node.js** | **22.9.0 以上**（`.nvmrc` は 22.19.0） | 組み込みSQLite（`node:sqlite`）が 22.5.0 以降、`.env` 読み込みに使う `--env-file-if-exists` が 22.9.0 以降。`package.json` の `engines` にも明記している |
| **npm** | Node 同梱のもの | |
| **PowerShell 7+** (`pwsh`) | 開発用スクリプトのみ | 本番起動（`npm start`）には不要 |
| **LLMの接続先**（任意） | Agent実行・Factory・評価を動かす場合 | **ローカル**（[LM Studio](https://lmstudio.ai/) 等のOpenAI互換サーバー。既定の接続先は `http://127.0.0.1:1234/v1`）か、**クラウドAPI**（OpenAI等。APIキーが要る）のどちらか。**Tool Calling対応モデル**が必要。未設定でもUI・ツールビルダー・データソースは動く |

セットアップ:

```powershell
nvm use          # .nvmrc がある場合
npm install
copy .env.example .env   # 任意。設定を書き換える場合
```

`.env` はAPIプロセスが Node の `--env-file-if-exists=.env` で読む（無くてもエラーにならない）。
**シェルに既に設定されている環境変数は `.env` より優先される。**
読まれるenvの全量と既定値は [.env.example](.env.example) にある。起動時に全項目をまとめて検証し、
不正な値があれば「どの変数の、どの値が、何を期待されているか」を並べて起動を中止する。

## ローカル開発

PowerShellからAPIとUIをまとめて起動する。UIはVite開発サーバー（5173）が配信し、APIへはプロキシする。

```powershell
.\scripts\start-dev.ps1
```

ツール、スキル、エージェント、Wiki、CSV/JSONデータソースを含めて手動確認する場合は、専用のサンプルデータを投入して起動できる。既存IDがある場合は再作成しない。

```powershell
npm run dev:sample
# または .\scripts\start-dev.ps1 -SampleData
```

サンプルデータは既定の永続DBへ投入される（既存データは上書きしない）。使い捨てにしたい場合は `AGENTCONTEXT_DB_PATH=:memory:` を指定する。

起動オプションを使わなくても、**画面からサンプルを投入できる**（「チャット」画面の「サンプルを読み込んで試す」、または「データソース」画面の「サンプルを読み込む」）。

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
npm run depcruise
npm run test:cov
npm run build
```

`test:e2e` 以外は GitHub Actions（`.github/workflows/ci.yml`）が push(main) と pull request で
`ubuntu-latest` 上でも回す。e2e は所要時間が長く、まだ Actions 上での安定性を確認できていないため
`.github/workflows/e2e.yml` の**手動トリガー**（Actions タブ → E2E (manual) → Run workflow）にしてある。

## ビルドと本番起動

```powershell
npm run build   # UI（dist/ui）とサーバー（dist/server）の両方を出力する
npm start       # dist/server/server.js を node が直接実行する（tsx は開発専用）
```

`npm start` は `dist/ui` を見つけるとAPIと**同じポート**からUIを配信する。ブラウザで
`http://127.0.0.1:3030` を開けばそのまま使える（Vite開発サーバーは不要）。
`dist/ui` が無ければAPIだけを提供する。開発用の `npm run serve` は `dist/ui` を配信しない
（古いビルドを掴むとソースを直しても画面が変わらないため）。UI付きで確認したいときは `npm start` を使う。

| エンドポイント | 用途 |
|---|---|
| `GET /health` | liveness。プロセスが生きているかだけを見る（依存は叩かない）。落ちたら再起動する判断に使う |
| `GET /ready` | readiness。DBへ実際に読み取りを1本通す。失敗時は `503` と失敗した依存名を返す |

どちらも `AGENTCONTEXT_SOURCE_REVISION` を設定していれば `revision` を返すので、
「今動いているのがどのビルドか」を外から確認できる。

補足:

- 既定のlistenは `127.0.0.1:3030`。別マシンから触らせる場合は `AGENTCONTEXT_HOST=0.0.0.0`。
  **認証はまだ実装していない**ので、公開網へは直接出さないこと。
- Agent実行・マルチエージェント実行（最大1時間）はHTTPリクエストの中で動く。この経路を切らないため、
  Fastifyの `connectionTimeout`（無通信でソケットを切る設定）は無効のままにしている。
  リバースプロキシを挟む場合は、そちらのタイムアウトも長時間実行に合わせる必要がある。
- ビルド成果物（`dist/`）は `.gitignore` 済み。

### 停止（graceful shutdown）

`Ctrl+C`（SIGINT）または SIGTERM で停止する。処理中のHTTPリクエストを終わらせたあと、
**実行中**の実験・Factory Runの完了を既定10秒まで待ってから中断する
（`AGENTCONTEXT_SHUTDOWN_GRACE_MS` で変更、`0` なら待たない）。
待たずに落としたいときは **もう一度 `Ctrl+C`** を押すと猶予を打ち切って即終了する。

> ジョブの永続化と再起動後の再開はまだ実装していない。猶予を過ぎて中断されたジョブは
> 失敗として記録され、再開されない。長い実験の最中は停止を避けること。

## データの保存先

作成したTool・Skill・Agent・Wiki・実行履歴・モデル設定は SQLite に保存する。

- 既定の保存先は **`~/.agentblume/agentblume.db`**（親ディレクトリは自動作成）。起動時にログへ実際のパスを出す。
- 別の場所に置く場合は `AGENTCONTEXT_DB_PATH` を設定する。
- `AGENTCONTEXT_DB_PATH=:memory:` を指定したときだけ、プロセス終了で全データが消える（使い捨て検証用）。
- セッションアーティファクト（表・グラフのpayload）の実体はDBの外、`<DBファイル>.session-artifacts/` に置く。DBはカタログだけを持つので、**この2つは常に一緒に扱う**。
- スキーマは起動時に自動でマイグレーションする。DBがこのビルドより新しい場合は、データを壊さないよう起動を中止する。
- UIから保存したAPIキーは暗号化して保存し、鍵は `~/.agentblume/secret.key`（`AGENTCONTEXT_SECRET_KEY_PATH` で変更可）に置く。**DBファイルをバックアップ・共有するときは鍵ファイルを一緒に運ばない**こと。
- DBファイル・鍵ファイルは `.gitignore` 済み。

読まれている環境変数の全量は [.env.example](.env.example) を参照。

## バックアップと復元

WALで動作中のDBを**ファイルコピーしてはいけない**（直近のコミットが `-wal` 側にしか無く、整合しないコピーになる）。
agentblume は SQLite のオンラインバックアップでスナップショットを取り、アーティファクトの実体と一緒に
1つのディレクトリ（`backup-YYYYMMDD-HHMMSSmmm/`）へ出力する。既定の出力先は `<DBファイル>.backups`
（`AGENTCONTEXT_BACKUP_DIR` で変更可）。

```powershell
npm run backup                            # バックアップを作る（サーバー起動中でも停止中でも可）
npm run backup -- --list                  # 一覧
npm run backup -- --restore <名前|パス>   # 復元（**サーバーを止めてから**）
npm run backup -- --include-secret-key    # 引っ越し用。暗号鍵も含める（機密度が上がる）
```

画面からも取れる（**ステータス**画面 →「バックアップと掃除」）。保存先パスと直近の一覧、
保持期限（retention）の手動適用もここにある。バックアップは**サーバーのファイルシステムへ書く**ので、
ブラウザへのダウンロードではない（できたフォルダを別ドライブへコピーして保全する）。

**暗号鍵は既定で含めない。** 含めると「DBだけが流出しても平文APIキーは守られる」という前提が消えるため、
別マシンへの引っ越しのときだけ明示的に含める。含めなかった場合、別マシンではAPIキーの再入力が要る。

復元は稼働中のプロセスの足元でファイルを差し替えることになるためHTTP APIからは実行できず、
CLI（サーバー停止中）専用にしている。手順・鍵の扱い・トラブルシュートは
[運用 runbook](docs/17-operations-runbook.md) を参照。

## データソースとDB接続

CSV/JSONは「データソース」画面で登録し、Tool Builderのsourceノードから選択できる。DB接続情報とパスワードはbrowserに入力せず、backend環境変数で管理する。

- 設定例: [.env.example](.env.example)
- DBはPostgreSQLの読み取り専用sourceに対応する。`allowedTables`に列挙したtable/viewだけを、行数上限付きで読み取る。
- 任意SQL、書き込み、資格情報のUI入力・API返却は提供しない。

設計上の安全境界は[ADR-0029](docs/adr/0029-data-source-registry.md)を参照。

Web検索sourceは、Tavily、TinyFish、Google Custom Searchのキーをbackend環境変数で有効化して利用する。設定されていないproviderはTool Builderに表示されず、検索は作成者の「検索結果を取得」操作でだけ実行する。結果は15分のサーバー内キャッシュとしてTool graphから参照する。自動更新・永続キャッシュ・利用量予算は後続範囲であり、詳細は[ADR-0030](docs/adr/0030-optional-web-search-providers.md)を参照。

## モデルの設定

プロバイダとモデルは**画面から選べる**（「設定」画面 →「モデルプロバイダ」）。スロットは2つある。

- **メインモデル** (`main`) … エージェントの実行に使う。**これを設定しないとエージェントは応答できない。**
- **評価モデル** (`judge`) … 検証画面のLLM採点に使う。

「ソース」で **プロバイダレジストリ**（OpenAI等。モデル一覧はカタログから取得）か **OpenAI互換エンドポイント**（LM Studio等。「モデル一覧を取得」で列挙）を選ぶ。どちらもモデル名の手入力に切り替えられる。「テスト」で接続を確認できる。

未設定のスロットは環境変数の既定（`LM_STUDIO_BASE_URL` / `LM_STUDIO_MODEL` / `LM_STUDIO_TIMEOUT_MS`）を使う。**サーバー側の環境変数はブラウザから変更できない。**

APIキーは暗号化して保存され、**ブラウザへ戻されることはない**（末尾4文字だけ表示）。鍵は `~/.agentblume/secret.key`（`AGENTCONTEXT_SECRET_KEY_PATH` で変更可）に置く。

手順の詳細は[クイックスタート §3](docs/18-quickstart.md#3-モデルを設定する)を参照。

## ドキュメント

| | |
|---|---|
| **[クイックスタート](docs/18-quickstart.md)** | インストールから自分のデータでエージェントを作るまで（非エンジニア向け） |
| [トラブルシューティング](docs/19-troubleshooting.md) | 症状別の対処 |
| [デモデータ操作マニュアル](docs/13-demo-operation-manual.md) | サンプルデータを1画面ずつ確認する |
| [マルチエージェントの操作チュートリアル](docs/15-agent-harness-tutorial.md) | 複数エージェントの連携を組む |
| [運用 runbook](docs/17-operations-runbook.md) | バックアップ・復元・引っ越し・ディスク管理 |
| [仕様書の索引・用語集](docs/README.md) | 設計文書の全体像 |
| [CHANGELOG](CHANGELOG.md) | 主要な機能追加の履歴 |

アプリ内にも画面ごとのヘルプがある（左ナビ下部の「**? ヘルプ**」）。

## ライセンス

[MIT License](LICENSE) © 2026 yy7613
