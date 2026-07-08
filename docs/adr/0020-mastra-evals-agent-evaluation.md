# ADR-0020: Mastra Evals によるエージェント応答評価

- Status: Accepted
- Date: 2026-07-08
- Context doc: [docs/09-roadmap.md](../09-roadmap.md)（Phase 4 評価）, [docs/07-execution-model.md](../07-execution-model.md), [ADR-0017](./0017-scenario-validation-pseudo-users.md)（シナリオ検証）

## Context

ロードマップ Phase 4 は「評価・回帰・LLM-as-Judge」を掲げる。エージェント応答の質を機械的に採点する機能が要る。採点エンジンとして **Mastra の Evals（`@mastra/evals`）** を採用する指示が出た（当初検討した Langfuse は不採用）。

制約: 本プロジェクトは lean・単一パッケージ・オフラインファースト（[ADR-0001](./0001-layered-single-package.md)）で、外部SDKは **adapters 層に隔離**する（depcruise 強制）。Mastra の code系スコアラー（`createKeywordCoverageScorer` / `createCompletenessScorer` / `createContentSimilarityScorer` / `createToneScorer`）は LLM不要で決定的・オフライン動作する。LLM採点系（AnswerRelevancy / Faithfulness / Hallucination / Toxicity 等）は Vercel AI SDK の `LanguageModel` を要求し、本プロジェクトの `ModelProviderPort`（LM Studio）とは別配線・実モデル稼働が必要。

## Decision

1. **`AgentEvaluatorPort` を application 層に定義する。** `evaluate(input: { input; output; reference? }) → EvaluationScore[]`。採点結果は `EvaluationScore { metric, score(0..1), reason? }` の配列。domain に `EvaluationResult`（scores + average）値型を置く。
2. **Mastra Evals は adapters 層の `MastraEvalsEvaluator` にのみ隔離する。** 本物の `@mastra/evals` prebuilt **code系スコアラー**を、Mastra のエージェントI/O形（`{ input: { inputMessages:[{role:'user',content}] }, output: [{role:'assistant',content}] }`）へ写像して実行し、`EvaluationScore[]` へ正規化する。domain/application は `@mastra/evals` を一切importしない。
3. **既定メトリクス**（すべて code系・オフライン・決定的）:
   - `keyword-coverage`: ユーザー入力のキーワードが応答にどれだけ現れるか。
   - `completeness`: 入力要素の網羅率。
   - `tone-consistency`: 応答の口調の一貫性。
   - `content-similarity`: `reference`（期待応答）指定時のみ、reference と応答の類似度（無指定時はスキップ）。
4. **決定的なので既定で有効。** LLM採点系のような外部呼び出しはしないため、Langfuse等のような opt-in ゲートは不要。Mastra のテレメトリ（`@mastra/core` 同梱の posthog）は起動時に `MASTRA_TELEMETRY_DISABLED` で無効化する。
5. **LLM-as-judge は config-gated 拡張として設計する（本増分では非活性）。** 追加で `@ai-sdk/openai-compatible` を導入し LM Studio 設定から `LanguageModel` を構築、`createAnswerRelevancyScorer` 等を `MastraEvalsEvaluator` の追加スコアラーとして注入する差込口を用意する。実モデル稼働がないと検証できないため、有効化は別増分（実 LM Studio で確認）とする。
6. **評価入力は明示 (input, output, reference?)。** RunRecord は入力メッセージを保持しないため、評価はUI/呼び出し側が持つ入力・応答を渡す（保存済みRunの再評価は将来の拡張）。`POST /evaluations` で受け、動作確認(Inspector)画面から応答に対して実行し、スコアを表示する。

## Consequences

- ✅ 本物の Mastra Evals を使いつつ、オフライン・決定的で完全にテスト可能な評価が手に入る（Phase 4 の入口）。
- ✅ Port/Adapter により採点エンジンを差し替え可能（将来 LLM採点・別エンジン・シナリオ検証メトリクスとの統合）。
- ✅ 動作確認画面で応答→即評価の観測ループが閉じる。
- ⚠️ `@mastra/evals` は peer `@mastra/core`（約30依存・posthogテレメトリ）を引き込む重い依存。テレメトリは既定無効化し、外部呼び出しはしない。将来 Mastra を薄い自前実装へ置換する退避路は Port 抽象で確保。
- ⚠️ 現状メトリクスは字句・網羅ベースで意味的正しさは測れない。意味評価は LLM-as-judge（config-gated 拡張）で補う。

## Alternatives considered

- **Langfuse**: トレース/スコア基盤として検討したが不採用（外部SaaS前提・観測寄り）。
- **Mastra の新 scorers を application で直接使用**: 外部SDKがコアへ漏れ、depcruise 違反かつ差し替え不能。却下（adapters 隔離）。
- **LLM採点を本増分で有効化**: AI-SDKモデル＋実 LM Studio が必要で本環境で検証不能。config-gated 拡張として分離。

## 実装契約

[implementation/v20-mastra-evals-evaluation.md](../../implementation/v20-mastra-evals-evaluation.md) を単一の真実とする。
