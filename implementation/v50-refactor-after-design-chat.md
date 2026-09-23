# v50: 設計アシスタント・テンプレート・プロンプト移行後の整理（挙動を変えないリファクタリング + 日本語化の穴埋め）

## 原則

- **挙動を変えない**（R5 を除く）。既存テストは緩めずにすべて緑のまま。移動・抽出した関数は、移動前と同じ入力に同じ出力を返すことを既存テストで担保する。
- 利用者やモデルに届く**文言は一字も変えない**（R5 の日本語訳の追加を除く）。R5 は英語の原文を照合キーにするため。

## R1. ツール設計の規則を 1 か所にまとめ、設計アシスタントにも結合の規則を効かせる

いま同じ種類の「検証を通っても答えが間違う形」の検査が 2 か所にある。

| 場所 | 中身 |
|---|---|
| `src/application/factory/generate-agent-assets.ts` | `describeToolSemanticViolations`（期間ラベル列を残す・`periodStart` で並べる 等）、`describeJoinDesignViolations`（parse-period は最後の結合の後で 1 回・`注記` をキーにしない 等） |
| `src/application/tool/design-tool-chat.ts` | `describeSemanticProblems`（期間ラベルで並べ替え・0 行・粒度の混在） |

- 新規 `src/application/tool/design-rules.ts` に、**グラフとプロファイルだけで判定できる規則**を純関数で移す: `describeJoinDesignViolations`（そのまま移動）、`sortsOnPeriodLabel`、`missingGranularityFilter`、`emptyPreviewProblem` など。Factory 固有の判定（計画・目的の語から「最新を求めるか」を読むもの等）は Factory に残す。
- `generate-agent-assets.ts` は移した関数を import して使う（re-export は既存の import 元を壊さないために残してよい）。
- 設計アシスタントの意味の検査に `describeJoinDesignViolations` を**硬い問題**として足す（設計アシスタントで結合を作ると、同じ事故＝結合前の parse-period・注記キー、が起き得るため）。これだけは挙動の追加。テストで固定する。

## R2. `design-tool-chat.ts`（713 行）を責務で分ける

- 圧縮 → `src/application/tool/design-chat-compact.ts`（`DesignToolChatUseCase.compact` は薄い委譲として残し、API と root の配線を変えない）。
- agentTool 操作の検査と適用 → `src/application/tool/design-chat-agent-tool.ts`。
- 意味の検査 → R1 の `design-rules.ts`。
- `design-tool-chat.ts` は材料集め・プロンプト・適用と検査の段取りだけにする。

## R3. 同じ定数の二重定義をなくす

- `CODE_LIKE_COLUMN`（`profile-data-sources.ts` と `domain/tool-template/instantiate.ts` の 2 か所）→ domain の新規 `src/domain/data/column-roles.ts` に置き、両方と `scenario-grounding.ts` がそこから import する（application → domain の向き）。
- `agent-output` の既定（`tool-output-dispatcher.ts` の `DEFAULT_OUTPUT` と `normalize-tool-graph.ts` の `AGENT_OUTPUT_DEFAULTS`）→ `src/domain/etl/nodes/agent-output.ts` に `DEFAULT_AGENT_OUTPUT_CONFIG` として置き、両方が使う。UI（`node-catalog.ts`）は domain を import できないので写しのまま（既存の方針）。

## R4. `isRecord` の 7 つの写しを 1 つに

`src/domain/shared/assert.ts`（または同階層の新規 `guards.ts`）に `export function isRecord(value: unknown): value is Record<string, unknown>` を置き、`graph-edit.ts`・`normalize-tool-graph.ts`・`template-tasks.ts`・`tool-design-tasks.ts`・`design-tool-chat.ts`・`mastra-model-provider.ts`・`domain/operations/backup.ts` の写しを置き換える。**写しの実装が同じかを先に確かめる**（配列を record とみなすかどうか等が違えば、違う方は置き換えず報告する）。

## R5. 設計アシスタントの理由・注記を日本語にする（UX の穴埋め）

設計アシスタントの赤枠（`problems`）と黄色の注記（`warnings`）は英語の原文を `localizeDiagnosticDetail` に通しているが、v47〜v49 で増えた文の訳が無く、日本語 UI に英語が出る。この製品の規律（エラーは直し方と場所まで言う）に沿って訳を足す。

対象の英語原文（コードで確認して、すべて拾う）:
- `src/domain/etl/graph-edit.ts` の `GraphEditError`（`operation N ('op'): …`）
- `src/application/tool/design-tool-chat.ts`（R1/R2 の後は `design-rules.ts` / `design-chat-agent-tool.ts`）の意味の検査・agentTool 操作の違反・材料が読めない場合の文
- 訳は `src/ui/api/error-messages.ts` に、既存の ETL 定型文の訳と同じ作法（正規表現で拾い、列名・ノード名を埋め戻す）。訳が無い文は従来どおり原文のまま出る。

## 分担（ファイルの所有を分ける）

| 担当 | 所有 |
|---|---|
| A（R1・R2） | `src/application/tool/design-*.ts` とテスト、`src/application/factory/generate-agent-assets.ts` とテスト。R4 のうち `design-tool-chat.ts` の `isRecord` 置き換えも A |
| B（R3・R4） | `src/domain/shared/*`・`src/domain/data/column-roles.ts`（新規）・`src/domain/etl/nodes/agent-output.ts`・`src/domain/etl/graph-edit.ts`・`src/domain/tool-template/instantiate.ts`・`src/domain/operations/backup.ts`・`src/application/factory/normalize-tool-graph.ts`・`profile-data-sources.ts`・`scenario-grounding.ts`・`tasks/*.ts`・`src/application/tool/tool-output-dispatcher.ts`・`src/adapters/model/mastra-model-provider.ts` とそれらのテスト |
| C（R5） | `src/ui/api/error-messages.ts` とテスト |

## 完了条件

typecheck・depcruise 違反 0・`test:cov` 合格。既存テストの期待値は変えない（R1 の設計アシスタントへの結合規則の追加と R5 の訳の追加で**増える**テストだけ）。

## R6. 値オブジェクト（今回増えた規則）

ドメインプリミティブのロードマップ（ADR-0034、M0〜M5）は完了済みだが、v43〜v49 で増えた値は生の `string` と正規表現の写しのままになっている。

| 値 | 現状 | 導入するもの |
|---|---|---|
| エージェントへ公開する関数名 `^[A-Za-z0-9_-]{1,64}$` | 同じ正規表現が domain / application / api に 7 か所（`domain/tool/tool.ts`・`domain/agent/structured-output.ts`・`domain/tool-template/template.ts`・`application/agent/tool-schema.ts`・`application/tool/design-chat-agent-tool.ts`・`api/schemas.ts`、`mcp-tools.ts` はコメント） | `src/domain/shared/function-name.ts`: `FunctionName = Flavor<string,'FunctionName'>`、`FUNCTION_NAME_PATTERN`、`isFunctionName`、`assertFunctionName(value, label)`（`SharedValidationError`）。各所はこれを使う。**エラー文は各所の既存の文をそのまま使う**（`isFunctionName` で判定し、投げる文は各所が持つ）— 文言を変えると UI の訳が外れるため |
| テンプレート id | `string` | `ToolTemplateId = Flavor<string,'ToolTemplateId'>`（`domain/tool-template/template.ts`）を型に付ける |
| プロンプト id / 版 | `string` | `PromptId` / `PromptVersion` の Flavor（`application/prompt/prompt-template.ts`）を型に付ける |

UI（`src/ui/**`）は domain を import できないので、UI の写し（`store.ts`・`AgentBuilder.tsx`）は既存の方針どおり残す。Flavor なので既存テストの文字列リテラルは修正不要（ADR-0034 の既定）。
