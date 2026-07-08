/**
 * application層: エージェント応答を評価するユースケース（v20 実装契約 §2）。
 * 入力/出力を検証し、Port で採点、domain の EvaluationResult へ正規化する。
 */
import { createEvaluationResult, type EvaluationResult } from '../../domain/evaluation/evaluation';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import type { AgentEvaluatorPort, EvaluationInput } from './evaluator';

export class EvaluateAgentRunUseCase {
  constructor(private readonly evaluator: AgentEvaluatorPort) {}

  async execute(input: EvaluationInput): Promise<EvaluationResult> {
    if (typeof input.input !== 'string' || input.input.trim().length === 0) {
      throw new EvaluationDomainError('EvaluateAgentRun: input must be a non-empty string');
    }
    if (typeof input.output !== 'string' || input.output.trim().length === 0) {
      throw new EvaluationDomainError('EvaluateAgentRun: output must be a non-empty string');
    }
    const scores = await this.evaluator.evaluate({
      input: input.input,
      output: input.output,
      ...(input.reference !== undefined && input.reference.trim().length > 0 ? { reference: input.reference } : {}),
    });
    return createEvaluationResult(scores);
  }
}
