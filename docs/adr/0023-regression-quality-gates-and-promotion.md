# ADR-0023: 回帰比較、品質ゲート、承認付き昇格を分離する

- Status: Accepted
- Date: 2026-07-10
- Context: [LLMOps実装計画](../../implementation/llmops-roadmap.md)、[ADR-0022](./0022-persisted-batch-experiments.md)

## Context

永続ExperimentでAgent版ごとのケース結果は再現できるが、baselineとcandidateの差分、自動リリース判定、人手承認の監査記録がない。単一の平均値だけでは反復実行のばらつきや特定ケースの劣化も見落とす。

## Decision

1. 集計と比較は保存済みExperiment/CaseResultから再計算できる純粋なドメインロジックとする。
2. 集計はサンプル列、件数、平均、中央値、p50/p95、標準偏差、最小/最大を持つ。失敗率、latency、tokensは低いほど良く、それ以外は高いほど良いと判定する。
3. 比較可能条件を同一Dataset版、EvaluatorProfile版、反復回数に固定し、case idと反復番号で対応付ける。片側欠損は`incomparable`とする。
4. `GatePolicy`をSemVer資産にし、絶対閾値、最大回帰、required tagケース成功の規則を持たせる。欠損metric、欠損baseline、対象ケースなしはfail closedとする。
5. `GateReport`は評価時点のpolicy版、Experiment参照、規則別結果、有効期限を持つ不変の監査記録とする。
6. 昇格申請はpass済み・未失効のGateReportとcandidate Agent版の一致を必須にする。申請で`draft -> in-review`、承認で`in-review -> published`、差し戻しで`in-review -> draft`へ遷移し、操作者と時刻を保存する。
7. MVPでは外部環境へdeployしない。CIはcandidateに対する最新GateReportを読み、pass=0、fail=1、欠損・失効・入力不備=2を返す。

## Consequences

- UI、API、CIが同じGateReportを判定根拠として共有できる。
- GateReport失効後や対象版不一致では昇格できず、古い評価結果の再利用を防げる。
- Agent版の内容を変えず同一SemVerのライフサイクル状態だけを更新するため、Repositoryに明示的な`updateState`能力が必要になる。
- 複数Repositoryをまたぐ厳密な分散transactionはMVPの対象外であり、将来外部queue/DBへ移行する際にUnit of Workを追加する余地を残す。

## Implementation

[implementation/v24-regression-quality-gates.md](../../implementation/v24-regression-quality-gates.md)を単一の実装契約とする。
