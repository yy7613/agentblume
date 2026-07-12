# v24 実装契約: 回帰比較と品質ゲート

> 前提: v23完成。[ADR-0023](../docs/adr/0023-regression-quality-gates-and-promotion.md)に従う。

## 1. Domain / Storage

- Experiment集計はcase success、failure、latency、tokens、全score metricの分布統計を返す。
- baseline/candidateは同一Dataset版、EvaluatorProfile版、反復回数を必須にし、case id + repetitionで比較する。
- GatePolicyはSemVer管理し、metric threshold、max regression、required tag caseを評価する。
- GateReportとPromotionRequestは不変の監査情報としてInMemory/SQLiteへ保存する。
- AgentRepositoryは同一版の定義を変えず、ライフサイクル状態だけを更新できる。

## 2. Application / Promotion

- Compare/SavePolicy/EvaluateGate/Query use caseを提供する。
- metric欠損、baseline欠損、required tag対象なし・未完了はfail closedとする。
- promotionはGateReport pass、未失効、candidate Agent版一致を検証する。
- 申請、承認、差し戻しで`draft -> in-review -> published`または`in-review -> draft`を実行し、操作者・時刻・理由を記録する。

## 3. API / UI / CI

- comparison、GatePolicy、GateReport、PromotionRequestのHTTP APIを提供する。
- `POST /agents/:id/versions/:version/promotion-requests`を昇格入口にする。
- ValidationのQuality gatesタブでbaseline選択、metric/case差分、悪化絞り込み、policy保存、gate判定、承認・差し戻しを提供する。
- `npm run llmops:gate -- --experiment <id>`は最新reportを読み、pass=0 / fail=1 / invalid=2を返す。永続DBは`AGENTCONTEXT_DB_PATH`または`--db`で指定できる。

## 4. DoD

- 固定fixtureの改善版はpassし、承認後publishedになる。
- 劣化版はmax-regressionでfailし、昇格申請を拒否する。
- report失効、Agent版不一致、required case失敗を拒否する。
- test/coverage/typecheck/depcruise/build/Playwrightがgreen。

## 5. 実装結果

- Status: Complete (2026-07-10)
- 127 test files / 867 tests green。
- coverage: statements 90.96%、branches 80.20%、functions 90.65%、lines 94.84%。
- typecheck / dependency-cruiser / production build / Playwright 4 tests green。
