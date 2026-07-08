/**
 * application層: エージェント応答評価の Port（v20 実装契約 §2 / ADR-0020）
 *
 * 採点エンジン（Mastra Evals 等）は adapters 層の実装に隔離し、application は本 Port に依存する。
 */
import type { EvaluationScore } from '../../domain/evaluation/evaluation';

export interface EvaluationInput {
  /** 評価対象の入力（利用者の発話・指示）。 */
  readonly input: string;
  /** 評価対象の出力（エージェント応答）。 */
  readonly output: string;
  /** 期待応答（任意）。指定時は類似度系メトリクスの基準になる。 */
  readonly reference?: string;
}

export interface AgentEvaluatorPort {
  evaluate(input: EvaluationInput): Promise<readonly EvaluationScore[]>;
}
