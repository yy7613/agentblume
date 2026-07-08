import { describe, expect, it } from 'vitest';
import { createEvaluationResult } from './evaluation';
import { EvaluationDomainError } from './errors';

describe('createEvaluationResult', () => {
  it('score を 0..1 にクランプし平均を計算・reasonを保持する', () => {
    const result = createEvaluationResult([
      { metric: 'keyword-coverage', score: 0.8, reason: 'covered' },
      { metric: 'completeness', score: 1.4 },   // >1 → 1 へクランプ
      { metric: 'tone', score: -0.2 },           // <0 → 0 へクランプ
    ]);
    expect(result.scores).toEqual([
      { metric: 'keyword-coverage', score: 0.8, reason: 'covered' },
      { metric: 'completeness', score: 1 },
      { metric: 'tone', score: 0 },
    ]);
    expect(result.average).toBeCloseTo((0.8 + 1 + 0) / 3);
  });

  it('空配列は average 0 を返す', () => {
    expect(createEvaluationResult([])).toEqual({ scores: [], average: 0 });
  });

  it('空metric・非有限scoreを拒否する', () => {
    expect(() => createEvaluationResult([{ metric: ' ', score: 0.5 }])).toThrow(EvaluationDomainError);
    expect(() => createEvaluationResult([{ metric: 'x', score: Number.NaN }])).toThrow(/finite/);
  });
});
