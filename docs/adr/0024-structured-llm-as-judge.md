# ADR-0024: LLM-as-Judgeを独立モデルとstrict structured outputで実行する

- Status: Accepted
- Date: 2026-07-10
- Context: [LLMOps実装計画](../../implementation/llmops-roadmap.md)、[ADR-0023](./0023-regression-quality-gates-and-promotion.md)

## Context

code scorerは再現性が高い一方、正確性、指示遵守、安全性、回答品質のような定性的観点を十分に測れない。評価対象と同じモデルや自由形式出力をJudgeに使うと、自己評価、schema破損、prompt injection、提示順バイアスが品質ゲートへ混入する。

## Decision

1. `JudgeRubric`を独立したSemVer資産とし、観点、重み、0..1の採点レベル、reference利用規則、必須理由を保持する。
2. EvaluatorProfileをcode/judge metricの判別Unionへ拡張し、judge metricはRubric版を固定参照する。
3. `JudgeEvaluatorPort`を追加し、評価対象モデルとは別のprovider/model/config snapshotを明示的に注入する。ローカル既定は`JUDGE_LM_STUDIO_*`設定を使う。
4. Judge応答はstrict JSON schemaを必須にし、0..1のscoreと非空reasonを検証する。JSON/schema/provider障害を区別して保存する。
5. 評価対象のinput/output/referenceはsystem命令へ展開せず、untrusted dataタグ内のJSON値としてuser messageへ隔離する。
6. pairwise評価は決定的seedのSHA-256でcandidate-first/baseline-firstを切り替え、A/B応答をcandidate/baselineへ戻して返す。
7. ExperimentCaseResultへscorer名、metric、Rubric版、Judge model/config、score/reasonまたはfailureをsnapshot保存する。失敗recordへscoreを保存しない。
8. required judge metricは全caseで成功しなければGateReportを暗黙failにする。optional障害はscore欠損として保持し、0点へ変換しない。

## Consequences

- 同じRubric版とJudge model snapshotから評価根拠を追跡できる。
- prompt injection文字列がJudgeの命令領域へ混ざらない。
- Judge障害とAgent実行障害を分離でき、optional評価の一時障害でExperiment全体を失敗させない。
- Judgeは確率的評価であり、決定的metric、性能、required caseと組み合わせてGatePolicyを構成する必要がある。

## Implementation

[implementation/v25-structured-llm-as-judge.md](../../implementation/v25-structured-llm-as-judge.md)を単一の実装契約とする。
