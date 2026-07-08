/**
 * adapters層: Mastra Evals による AgentEvaluatorPort 実装（v20 実装契約 §3 / ADR-0020）。
 *
 * 本物の @mastra/evals の code系（LLM不要・決定的・オフライン）prebuilt スコアラーを、
 * Mastra のエージェントI/O形へ写像して実行し、EvaluationScore[] へ正規化する。
 * 外部SDK(@mastra/*)への依存は本アダプタ内に隔離する（depcruise）。
 */
import {
  createCompletenessScorer,
  createContentSimilarityScorer,
  createKeywordCoverageScorer,
  createToneScorer,
} from '@mastra/evals/scorers/prebuilt';
import type { EvaluationScore } from '../../domain/evaluation/evaluation';
import type { AgentEvaluatorPort, EvaluationInput } from '../../application/evaluation/evaluator';

// @mastra/core 同梱の posthog テレメトリを無効化する（オフラインファースト・外部送信抑止）。
process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true';

/** 利用する Mastra スコアラーの最小I/F（run の戻りから score/reason だけ読む）。 */
interface MastraScorer {
  run(io: unknown): Promise<{ readonly score: number; readonly reason?: string }>;
}

/** Mastra の agent スコアラーが期待する run 入出力（1発話・1応答）を組み立てる。 */
function scorerIO(input: string, output: string): unknown {
  return {
    input: { inputMessages: [{ role: 'user', content: input }] },
    output: [{ role: 'assistant', content: output }],
  };
}

interface ScorerSpec {
  readonly metric: string;
  readonly scorer: MastraScorer;
  readonly input: string;
  readonly output: string;
}

export class MastraEvalsEvaluator implements AgentEvaluatorPort {
  async evaluate(input: EvaluationInput): Promise<readonly EvaluationScore[]> {
    const asScorer = (scorer: unknown): MastraScorer => scorer as MastraScorer;
    const specs: ScorerSpec[] = [
      { metric: 'keyword-coverage', scorer: asScorer(createKeywordCoverageScorer()), input: input.input, output: input.output },
      { metric: 'completeness', scorer: asScorer(createCompletenessScorer()), input: input.input, output: input.output },
      { metric: 'tone-consistency', scorer: asScorer(createToneScorer()), input: input.output, output: input.output },
    ];
    if (input.reference !== undefined && input.reference.trim().length > 0) {
      specs.push({ metric: 'content-similarity', scorer: asScorer(createContentSimilarityScorer()), input: input.reference, output: input.output });
    }

    const scores = await Promise.all(specs.map(async (spec): Promise<EvaluationScore | undefined> => {
      try {
        const run = await spec.scorer.run(scorerIO(spec.input, spec.output));
        return {
          metric: spec.metric,
          score: run.score,
          ...(typeof run.reason === 'string' && run.reason.length > 0 ? { reason: run.reason } : {}),
        };
      } catch {
        // fail-soft: 個別スコアラーの失敗はそのメトリクスのみ除外し、他は返す。
        return undefined;
      }
    }));
    return scores.filter((score): score is EvaluationScore => score !== undefined);
  }
}
