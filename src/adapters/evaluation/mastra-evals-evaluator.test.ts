import { MastraEvalsEvaluator } from './mastra-evals-evaluator';
import { runAgentEvaluatorContract } from './evaluator.contract';

// 本物の @mastra/evals code系スコアラーで契約を満たす（オフライン・決定的）。
runAgentEvaluatorContract('MastraEvalsEvaluator', () => new MastraEvalsEvaluator());
