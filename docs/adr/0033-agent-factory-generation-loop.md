# ADR-0033: Agent Factory — データソースと目的からの自動生成と自動改善ループ

- Status: Accepted
- Date: 2026-07-20
- 関連: [docs/16-agent-factory.md](../16-agent-factory.md) / [implementation/v33-agent-factory.md](../../implementation/v33-agent-factory.md) / [ADR-0017](./0017-scenario-validation-pseudo-users.md) / [ADR-0021](./0021-versioned-evaluation-assets.md)〜[ADR-0025](./0025-observability-cost-feedback-retention.md) / [ADR-0032](./0032-versioned-agent-harness-orchestration.md)

## 文脈

Agentはシステムプロンプト・Skill・Toolの組み合わせで構成でき、各Builderと検証基盤（疑似ユーザーシナリオ v16/v18、評価資産〜品質ゲート〜LLM-as-Judge v22–v25）は実装済みである。しかし「登録済みデータソースと目的の自然文から資産一式を組み上げ、疑似ユーザー検証の結果で改訂を繰り返す」工程は全て人手であり、次のギャップがある。

1. データソースからToolを生成する仕組みがない（LLM支援は分析ノード単体の設定提案 `SuggestAnalysisConfigUseCase` のみ）。
2. Persona / Scenario の設計も人手であり、検証結果（アンケート・感想・Tool適合率）を資産改訂へ反映する経路は [llmops-roadmap.md](../../implementation/llmops-roadmap.md) の改善ループ図でも人手工程である。

## 決定

**Agent Factory** を新設し、次の5点を採用する。

### 1. 決定的パイプラインでオーケストレートする専門ロール型マルチエージェントにする

生成・改善は Planner / ToolSmith / SkillWriter / Assembler / ScenarioDesigner / Analyst の内蔵ロールへ分割する。各ロールは温度0・構造化出力の独立したLLM呼び出しであり、ロール間の順序・分岐・修復・停止はアプリの決定的なパイプライン（`RunFactoryUseCase`）が制御する。Harness（Group Chat / Magentic等）上の自由会話としては実装しない。

理由: 生成物は保存資産であり再現性・失敗解析・予算管理が最優先であること。Harnessのslotは保存済みAgentを前提とし、資産の保存・検証というメタ操作をAgentのTool呼び出しへ公開すると権限境界が崩れること。シナリオ検証のオーケストレータ（決定的ループ + 構造化出力）で確立済みのパターンであること。

### 2. 内蔵ロールはアプリのコード資産とし、保存済みAgentにしない

ロールのプロンプトテンプレートと出力スキーマはコードとして版管理する。ユーザーのワークスペースへ「生成用Agent」を作らない。

理由: 生成主体が生成対象（ユーザー資産）と同じ空間にあると、自己改変・改ざん・bootstrap循環（Factoryを直すためのFactory）が生じる。挙動の変更はアプリのリリースとして追跡する。

### 3. 生成物は既存資産型のdraft版として既存Save系ユースケース経由で保存する

Tool / Skill / Agent / Persona / Scenario の専用形式や別テーブルを作らず、`SaveToolUseCase` 等を経由した通常のSemVer版として保存する。出所は `FactoryRun.artifacts` 台帳（Run→資産のSemVer固定参照）で管理し、資産側の共通メタデータへ出所フィールドを追加しない。

理由: 生成直後から既存Builder・検証・評価・昇格の全機能がそのまま使える（エスケープハッチ原則）。保存時バリデーション・命名規則・契約テストを重複させない。

### 4. 自律の境界は「draft空間内は全自動・公開は人手」とする

改善ループ（検証 → 分析 → 改訂新版 → 再検証）はhard budget（イテレーション・時間・LLM呼び出し・シナリオ実行数）の範囲で無承認で回す。ただし (a) 生成Toolの副作用は `read-only` / `session-write` に制限、(b) 公開・昇格は既存の品質ゲート + 人手承認のみ、(c) 計画承認 `requirePlanApproval` をオプションとして提供（Magentic計画承認と同じcheckpoint型）。Scenario集合はRun内で凍結し、イテレーション間の回帰比較を成立させる。

理由: draft資産の生成は可逆で外部副作用がなく、自動化の価値（回転数）が大きい。一方、公開・昇格・write系は既存ADRの fail closed 方針を維持する。シナリオを動かせると「テストに合わせる」最適化が可能になり評価が自壊する。

### 5. LLM出力は全て構造化出力 + アプリ側再検証、データ値はuntrusted隔離

ロール出力は型付きスキーマで受け、ToolグラフはETLエンジン（スキーマ伝播 + preview）で、参照はrepositoryで再検証する。不合格は修復ループ（上限付き）または破棄。データソースの値・疑似ユーザー発話・アンケート自由記述はADR-0024と同じくuntrusted dataとしてsystem命令から隔離する。

## 検討した代替案

| 代替案 | 不採用の理由 |
|---|---|
| Harness（Magentic）上に生成チームを構成する | 資産保存・検証実行というメタ操作をAgent Toolとして公開する必要があり権限境界が崩れる。停止性・再現性がモデル判定依存になる。Harness slotは保存済みAgent前提で決定2と矛盾する |
| 外部SDK（Mastra workflows等）でパイプラインを記述する | domain/applicationへ外部SDKを持ち込まない既存方針（ADR-0020ほか）に反する。必要になればPort/Adapterで後付け可能 |
| 完全自動昇格（人手承認なしで公開まで） | fail closed方針（ADR-0023）に反する。自己申告メトリクス（疑似ユーザーのself-report）のみでの公開は品質保証にならない |
| 改善ループを既存Experiment（v23）の拡張として実装する | Experimentは「固定資産の測定」であり、資産を書き換えるループとはライフサイクルが異なる。測定はループから既存機構を呼び出す方が責務が明確 |
| 生成のたびに人手承認（全ステージcheckpoint） | 自動化の価値が失われる。draft空間内は可逆であり、計画承認オプション + 最終レポートで十分な統制になる |

## 帰結

- (+) データソースと目的文だけから、検証済みメトリクス付きのAgent候補一式がdraftとして得られる。改善はイテレーション単位で回帰比較できる。
- (+) 生成物は通常資産なので、既存のBuilder・検証・評価・昇格・観測がそのまま適用される。
- (+) ロール・修復・停止条件が決定的なため、ScriptedModelProviderで全経路をテストできる。
- (−) 内蔵ロールのプロンプト改善はアプリのリリースが必要（ユーザーが直接調整できない。エスケープハッチは生成後の資産編集）。
- (−) 疑似ユーザーのself-reportを主指標とするため、指標の妥当性はPersona / Scenario品質に依存する。Judge統合（M5）で補強する。
- (−) ローカルLLM構成ではRun 1回あたりのLLM呼び出しが多い（ロール + シナリオ会話）。hard budgetと逐次workerで抑制する。
