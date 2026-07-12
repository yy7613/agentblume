# Increment 26 実装契約: 観測、コスト、利用者Feedback

## 目的

評価実験以外のRunも同じ識別子で観測し、性能・コスト・利用者評価を改善判断へ利用できるようにする。観測基盤の障害はAgentの業務実行から隔離する。

## 実装範囲

- `RunRecord`へ後方互換な`purpose`、model snapshot、`total/model/tool` latency、推定cost snapshotを追加する。
- `TelemetryPort`から`agent.run`、`model.complete`、`tool.execute`、`evaluation.case` spanを出力する。
- exporter未設定時は`NoopTelemetryAdapter`、有効時は`OpenTelemetryAdapter`を使用する。
- `PricingPort`はprovider/model/実行時点に対応する最新単価を返す。未知modelまたはtoken内訳不足ではcostを保存しない。
- Feedbackは1 Runにつき1件をupsertし、thumb、1..5 rating、comment、issue tagsと実行時Agent版を保存する。
- payloadを含まない日次匿名集計へrun数、失敗数、latency sample、tokens、推定cost、feedback数を記録する。
- scope別retention policyでpayload、trace、aggregateの保持期間を分離する。payloadとtraceの両方が期限切れのRunは削除する。
- Status UIへ30日集計、日次時系列、Run観測詳細、Feedback入力を追加する。

## API

- `PUT /runs/:runId/feedback`
- `GET /runs/:runId/feedback`
- `GET /operations/status?tenantId=&workspaceId=&days=`
- `GET|PUT /operations/retention`
- `POST /operations/retention/apply`

## 設定

- `AGENTCONTEXT_OTEL_ENABLED=true`: OpenTelemetry API adapterを有効化する。TracerProvider/exporterはホスト側で登録する。
- `AGENTCONTEXT_MODEL_PRICING_JSON`: 料金snapshot配列。各要素は`provider`、`model`、`inputPerMillionTokens`、`outputPerMillionTokens`、`effectiveAt`を持つ。currencyはUSD固定。

例:

```json
[
  {
    "provider": "lm-studio",
    "model": "local-model",
    "inputPerMillionTokens": 0,
    "outputPerMillionTokens": 0,
    "effectiveAt": "2026-07-01T00:00:00.000Z"
  }
]
```

## 完了条件

- exporterの`start/set/end`失敗がRunを失敗させない。
- model単価とtoken内訳がある場合だけ`estimatedCost`を保存する。
- Feedback更新でfeedback件数を二重加算しない。
- retention適用後にRun/Feedbackが消えても、保持期間内の匿名集計は残る。
- InMemory/SQLite repository contract、API縦断、Status UIテストがgreen。

