/**
 * AgentEvaluatorPort の共有契約テスト（v20 実装契約 §3）。
 * 任意の実装に対し、判別性・スコア範囲・reference依存を検証する。オフラインで完結する。
 */
import { describe, expect, it } from 'vitest';
import type { EvaluationScore } from '../../domain/evaluation/evaluation';
import type { AgentEvaluatorPort } from '../../application/evaluation/evaluator';

function scoreOf(scores: readonly EvaluationScore[], metric: string): number | undefined {
  return scores.find((score) => score.metric === metric)?.score;
}

export function runAgentEvaluatorContract(name: string, make: () => AgentEvaluatorPort): void {
  describe(`AgentEvaluatorPort contract: ${name}`, () => {
    const query = 'Give me last month sales summary with total revenue';

    it('良い応答は悪い応答より keyword-coverage が高く、全スコアが 0..1', async () => {
      const evaluator = make();
      const good = await evaluator.evaluate({ input: query, output: 'Last month sales summary: total revenue was $128,000 across 512 orders.' });
      const bad = await evaluator.evaluate({ input: query, output: 'I like turtles.' });
      const goodKw = scoreOf(good, 'keyword-coverage');
      const badKw = scoreOf(bad, 'keyword-coverage');
      expect(goodKw).toBeDefined();
      expect(goodKw!).toBeGreaterThan(badKw ?? 0);
      for (const score of [...good, ...bad]) {
        expect(score.score).toBeGreaterThanOrEqual(0);
        expect(score.score).toBeLessThanOrEqual(1);
      }
    });

    it('reference 指定時のみ content-similarity メトリクスが加わる', async () => {
      const evaluator = make();
      const withRef = await evaluator.evaluate({ input: 'q', output: 'total revenue was 128000', reference: 'total revenue was 128000' });
      expect(withRef.some((score) => score.metric === 'content-similarity')).toBe(true);
      const noRef = await evaluator.evaluate({ input: 'q', output: 'total revenue was 128000' });
      expect(noRef.some((score) => score.metric === 'content-similarity')).toBe(false);
    });
  });
}
