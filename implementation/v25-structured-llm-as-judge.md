# v25 実装契約: LLM-as-Judge

> 前提: v24完成。[ADR-0024](../docs/adr/0024-structured-llm-as-judge.md)に従う。

## 1. Domain / Storage

- JudgeRubricはSemVer metadata、instructions、criteria、0..1 score levels、reference policy、`reasonRequired: true`を持つ。
- criteriaは一意なid、正のweight、score 0/1を含む2段階以上を必須とする。
- EvaluatorProfile metricを`code | judge`へ拡張し、judgeはRubricの固定SemVerを参照する。
- InMemory/SQLiteへJudgeRubric Repositoryと共有contractを追加する。
- ExperimentCaseResultはJudge成功・失敗のsnapshotを後方互換な任意フィールドとして保存する。

## 2. Judge Adapter / Experiment

- JudgeEvaluatorPortはpointwiseとpairwiseを提供する。
- StructuredJudgeEvaluatorはstructured-output capability、strict JSON schema、0..1 score、非空reasonを検証する。
- 評価payloadは`<untrusted-evaluation-data>`内のJSONへ隔離し、Rubricだけをsystem命令として扱う。
- pairwiseは決定的seedで提示順を反転し、A/B結果をcandidate/baselineへ正規化する。
- Experimentは既存code scoreとJudge scoreを合成する。Judge障害はcase実行を失敗させずfailure recordへ保存する。

## 3. Gate / API / UI

- required judge metricの失敗・欠損をGateReportの暗黙fail ruleにする。
- optional judge metric障害はscoreを作らず、policyが明示的に要求しない限りGateを失敗させない。
- JudgeRubric save/list/get/versions APIを追加し、EvaluatorProfile APIでjudge metricを扱う。
- Datasets UIへRubric editor、reference policy、criteria/levels編集、ProfileへのRubric固定参照を追加する。
- Experiments UIにRubric版、Judge model/config、reason/failureを表示する。

## 4. Configuration

- `JUDGE_LM_STUDIO_BASE_URL`: Judge専用endpoint。既定`http://127.0.0.1:1234/v1`。
- `JUDGE_LM_STUDIO_MODEL`: Judge専用model。未設定のままJudgeを実行するとprovider errorとして保存する。
- `JUDGE_LM_STUDIO_API_KEY`: Judge endpointが必要とする場合のみ設定する。
- `AppOptions.judgeModelProvider` / `judgeModelSnapshot`でテスト・埋め込み時に明示注入できる。

## 5. DoD

- Scripted Judgeの正常、JSON/schema破損、provider timeout、reference規則をテストする。
- prompt injection文字列がsystem messageへ入らないことを検証する。
- pairwiseのcandidate-first/baseline-firstを固定seedで検証する。
- required障害はgate fail、optional障害は欠損かつgate passになるfixtureを通す。
- test/coverage/typecheck/depcruise/build/Playwrightをgreenにする。

## 6. 実装結果

- Status: Complete (2026-07-10)
- 130 test files / 879 tests green。
- coverage: statements 90.93%、branches 80.04%、functions 90.68%、lines 94.94%。
- typecheck / dependency-cruiser / production build / Playwright 4 tests green。
