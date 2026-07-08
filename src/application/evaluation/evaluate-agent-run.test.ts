import { describe, expect, it, vi } from 'vitest';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import { EvaluateAgentRunUseCase } from './evaluate-agent-run';
import type { AgentEvaluatorPort } from './evaluator';

function evaluator(scores = [{ metric: 'keyword-coverage', score: 0.5 }]): AgentEvaluatorPort {
  return { evaluate: vi.fn().mockResolvedValue(scores) };
}

describe('EvaluateAgentRunUseCase', () => {
  it('Portで採点し EvaluationResult(平均付き)へ正規化する', async () => {
    const port = evaluator([{ metric: 'a', score: 0.8 }, { metric: 'b', score: 0.4 }]);
    const result = await new EvaluateAgentRunUseCase(port).execute({ input: 'q', output: 'a' });
    expect(result.scores).toHaveLength(2);
    expect(result.average).toBeCloseTo(0.6);
  });

  it('referenceは非空のときだけPortへ渡す', async () => {
    const port = evaluator();
    await new EvaluateAgentRunUseCase(port).execute({ input: 'q', output: 'a', reference: '  ' });
    expect(port.evaluate).toHaveBeenCalledWith({ input: 'q', output: 'a' });
    await new EvaluateAgentRunUseCase(port).execute({ input: 'q', output: 'a', reference: 'expected' });
    expect(port.evaluate).toHaveBeenLastCalledWith({ input: 'q', output: 'a', reference: 'expected' });
  });

  it('空input/outputを拒否する', async () => {
    const port = evaluator();
    await expect(new EvaluateAgentRunUseCase(port).execute({ input: ' ', output: 'a' })).rejects.toBeInstanceOf(EvaluationDomainError);
    await expect(new EvaluateAgentRunUseCase(port).execute({ input: 'q', output: '' })).rejects.toThrow(/output/);
  });
});
