# ADR-0025: Run観測、推定コスト、Feedback、retentionを分離して保存する

## Status

Accepted — 2026-07-10

## Context

v22-v25で固定評価資産、バッチ実験、回帰Gate、LLM-as-Judgeを実装した。しかし、通常Runのprovider/model設定、latency、cost、利用者評価を同じRun IDで追跡できず、改善候補を運用データから判断できなかった。また、payloadを削除すると運用傾向まで失われる構造は、プライバシーと長期分析を両立できない。

## Decision

1. `RunRecord`の観測項目はoptional追加とし、旧JSON recordを読み続けられるようにする。
2. model設定はprovider、model、config hashを実行時snapshotとして保存する。秘密値やendpointそのものは保存しない。
3. costは`estimated`のみを扱い、使用した単価と価格時点をRunへsnapshot保存する。未知modelを0 USDにしない。
4. telemetryはapplicationの`TelemetryPort`を通す。OpenTelemetry SDK依存はadapterへ閉じ込め、すべてのtelemetry呼び出しを非致命境界で保護する。
5. FeedbackはRunと実行時Agent版へ紐付け、同一Runの再送はupsertする。
6. 匿名日次集計はRun ID、入力、出力、trace、commentを保持しない。Raw Run/Feedbackとは別Repository・別tableに保存する。
7. retentionはpayload、trace、aggregateの日数をscope単位で設定する。payloadとtraceがともに期限切れになったRunは削除し、aggregateは独立した期限まで残す。

## Consequences

- exporterや集計保存の障害でAgent実行を失敗させない。
- 単価表を更新しても過去Runの推定costは変化しない。
- 日次集計からp50/p95を再現するためlatency sample配列を保持する。大規模運用ではhistogramや外部時系列DB adapterへ置き換える余地がある。
- aggregateは匿名であり、個別Runへの逆引きや削除済みpayloadの復元には使えない。
- 認証、RBAC、監査、外部Collector/exporterのホスト設定は別incrementで扱う。
