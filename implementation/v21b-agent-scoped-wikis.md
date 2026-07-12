# v21b 実装契約: 複数WikiとAgent参照

## 目的

長期記憶を単一のWorkspace検索空間から複数の名前付きWikiへ分離し、Agentごとに利用可能なWikiを明示する。

## ドメイン契約

- `WikiSpace`: scope内で一意な`id`、表示名、説明、作成・更新日時を持つ。
- `WikiPage.wikiId`: ページは1つのWikiにのみ所属する。既存値の欠損は`default`として扱う。
- `Agent.wikis`: `{ wikiId }`の重複なしallowlist。Agent versionの一部として直列化する。
- 既存ページを別Wiki IDで保存し直す操作は拒否する。

## 実行契約

- 保存済みAgentの入力文をallowlist内でキーワード検索する。
- 各Wiki最大2ページ、全体最大6ページ、各ページ最大600文字、context全体最大2400文字とする。
- system promptにはWiki名、ページ名、本文抜粋をデータ領域として注入する。
- allowlist外のページを`memoryPageIds`で指定した場合はfail closedする。
- Wiki未設定の旧Agentは従来の手動ページアタッチを許可する。

## API/UI契約

- `GET /wikis`, `POST /wikis`, `GET /wikis/:wikiId`
- ページAPIは`wikiId`でfilter/saveでき、旧`/wiki` APIも互換維持する。
- Memory画面でWiki作成・選択・Wiki内ページ編集を行う。
- Agent Builderで利用可能Wikiを複数選択してAgent版へ保存する。

## DoD

- 同じ語を含むページが複数Wikiにあっても、Agent allowlist外の本文がmodel requestへ入らない。
- Agent保存時に存在しないWikiを拒否する。
- Memory提案の承認先Wikiが維持される。
- InMemory/SQLite、API、Agent実行、UI、E2Eがgreen。
