# v20 実装契約: Mastra Evals によるエージェント応答評価

> 本書は Increment 20（[ADR-0020](../docs/adr/0020-mastra-evals-agent-evaluation.md)）の**単一の真実**。
> 前提: v18まで完成・全green。外部SDK `@mastra/evals`（+peer `@mastra/core`）は **adapters 層のみ**で import する。

## 0. 規約
strict / `noUncheckedIndexedAccess` / ESM・拡張子なしimport / Zod v4 / Vitest / 既存エラー型 / 非mutate / テスト同居 / 閾値維持 / 設定ファイルは親管理。**既存テスト変更禁止**（本増分は純増分）。

## 1. domain/evaluation（新規）
`evaluation.ts`:
```typescript
export interface EvaluationScore { readonly metric: string; readonly score: number; readonly reason?: string }
export interface EvaluationResult { readonly scores: readonly EvaluationScore[]; readonly average: number }
export function createEvaluationResult(scores: readonly EvaluationScore[]): EvaluationResult;
```
- 各 `metric` 非空、`score` は有限で 0..1 にクランプ（範囲外は `EvaluationDomainError`）。`reason` は指定時のみ保持。
- `average` = scores の score 平均（空なら 0）。空配列も許容。
- `errors.ts`: `EvaluationDomainError`。

## 2. application/evaluation（新規）
`evaluator.ts`:
```typescript
export interface EvaluationInput { readonly input: string; readonly output: string; readonly reference?: string }
export interface AgentEvaluatorPort { evaluate(input: EvaluationInput): Promise<readonly EvaluationScore[]> }
```
`evaluate-agent-run.ts`:
```typescript
export class EvaluateAgentRunUseCase {
  constructor(private readonly evaluator: AgentEvaluatorPort);
  async execute(input: EvaluationInput): Promise<EvaluationResult>;  // input/output 非空を検証→port→createEvaluationResult
}
```
- `input`/`output` 空は `EvaluationDomainError`（`GenerateAgentPrompt` 等と同流儀のメッセージ接頭辞）。

## 3. adapters/evaluation（新規）
`mastra-evals-evaluator.ts` — `implements AgentEvaluatorPort`:
- 本物の `@mastra/evals/scorers/prebuilt` の code系 factory を使う: `createKeywordCoverageScorer`・`createCompletenessScorer`・`createToneScorer`（常時）、`createContentSimilarityScorer`（`reference` 指定時のみ）。
- 各スコアラーを Mastra の agent I/O 形へ写像して `.run()`:
  - keyword-coverage / completeness: `{ input:{inputMessages:[{role:'user',content: input}]}, output:[{role:'assistant',content: output}] }`
  - tone-consistency: input=output=応答テキスト。
  - content-similarity: input=reference, output=応答テキスト。
- 結果を `{ metric, score: clamp01(run.score), ...(run.reason? {reason}) }` に正規化。スコアラー個別の失敗はそのメトリクスを飛ばし他は返す（fail-soft）。
- コンストラクタで採点対象メトリクスの選択を options 化可能（既定は上記4種）。**LLM採点系の差込口**（追加スコアラー配列）を型で用意するが本増分では未使用。
- モジュール副作用で `process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true'` を設定（外部送信抑止）。
- `evaluator.contract.ts`: 任意の `AgentEvaluatorPort` 実装に対し「良い応答＞悪い応答（keyword-coverage）」「score∈[0,1]」「referenceで content-similarity が増える」を検証する共有スイート。Mastra実装で実行（オフライン）。

## 4. api
- `schemas.ts`: `evaluateBodySchema = { scope?, input: string(min1), output: string(min1), reference?: string }`。
- `evaluation-routes.ts`: `POST /evaluations` → `EvaluateAgentRunUseCase.execute` → `{ evaluation: EvaluationResult }`（scoresはそのままJSON化）。`EvaluationRouteDeps { evaluateAgentRun }`。
- `server.ts`: `registerEvaluationRoutes` を配線（deps union に追加）。
- 統合テスト: 良い/悪い応答で keyword-coverage の差、reference 付きで content-similarity 出現。

## 5. composition
- `App` に `evaluateAgentRun: EvaluateAgentRunUseCase`。`evaluator = new MastraEvalsEvaluator()`（profile非依存・オフライン）→ `new EvaluateAgentRunUseCase(evaluator)`。
- エントリ（`src/server.ts`）起動時に `process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true'`（アダプタ側でも冪等設定）。

## 6. ui
- 型: `EvaluationScoreDto { metric, score, reason? }`、`EvaluationResultDto { scores, average }`。client `evaluate({ scope, input, output, reference? })`。
- **AgentInspectorPage**: アシスタントturnに「Evaluate」ボタン → `client.evaluate({ scope, input: <対応するユーザー発話>, output: <応答> })` → スコアをメトリクスバー（既存 survey-scale 風 or ins-metric 風）で表示。実行は turn 単位、状態は turn index で保持。
- i18n en/ja。テスト: Evaluate クリック→ scores 描画、client 呼び出し形。

## 7. 完了条件（DoD）
- [ ] typecheck 3構成 0エラー / `vitest run` 全green（既存無変更＋新規）/ depcruise 違反0（`@mastra/*` は adapters のみ）/ カバレッジ閾値
- [ ] Mastra実スコアラーのオフライン契約テストがgreen（ネットワーク不要）
- [ ] Playwright e2e 4本green
