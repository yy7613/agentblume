# ADR-0029: Data Source Registry and Backend-managed Database Credentials

> Status: Accepted (2026-07-12)

## Context

Tool BuilderでCSV/JSONファイルとDBを再利用可能なデータソースとして扱う。ブラウザやTool定義にDBの接続文字列・パスワードを保存すると、Run trace、画面状態、エクスポート、ブラウザストレージから漏えいするおそれがある。

## Decision

- サイドバーに`Data sources`（日本語: `データソース`）を`Tool`より上に置く。
- ファイルデータソースはbackendが管理するpayload storeへ保存する。UIはCSV/JSONをアップロードするだけで、Toolはopaqueな`dataSourceId`を参照する。
- DBデータソースはUIから接続文字列やパスワードを受け取らない。UIで登録するのは`connectionId`、driver、表示名、任意のdefault schemaだけとする。
- `connectionId`に対応する実接続情報はバックエンド環境変数で管理する。初期契約はJSONマップの`AGENTCONTEXT_DB_CONNECTIONS`とする。

```json
{
  "sales": {
    "driver": "postgresql",
    "host": "db.internal.example",
    "port": 5432,
    "database": "sales",
    "username": "agentcontext_reader",
    "passwordEnv": "SALES_DB_PASSWORD",
    "ssl": true,
    "allowedTables": ["reporting.sales_daily", "reporting.customer_summary"]
  }
}
```

- `passwordEnv`が示す環境変数をbackendだけが解決する。API・UI・Tool定義・ログには値を返さない。
- `database-source`は、登録済みDBデータソース、`allowedTables`内のtable/view、固定の行数上限だけを指定する。任意SQL・任意のschema/table名・書き込み操作は提供しない。
- backendは`BEGIN READ ONLY`内で、allowlistと完全一致する識別子だけを引用して`SELECT * ... LIMIT $1`を実行する。`LIMIT`は1〜10,000へクランプする。
- Data Source画面は接続可否・driverなどの安全なメタデータのみを表示する。実DBへの接続テストはbackend経由で実施する。

## Consequences

- frontendのlocalStorageにはファイルpayloadもDB資格情報も保持しない。
- Tool Builderの`csv-source`/`json-source`はファイルの`dataSourceId`を、`database-source`はDBの`dataSourceId`とallowlist済みtable/viewを選択する。いずれも実行直前だけbackendがpayload/行データへ解決し、Tool定義・Run traceへ資格情報やファイル本文を保存しない。
- ローカル開発では環境変数を設定しないDB connectionを`unavailable`として表示し、Tool実行をfail closedにする。
