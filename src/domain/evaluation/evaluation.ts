/**
 * ドメイン: エージェント応答の評価結果（v20 実装契約 §1 / ADR-0020）
 *
 * 採点エンジン非依存の値型。各スコアは 0..1 に正規化する（範囲外はクランプ）。
 */
import { EvaluationDomainError } from './errors';

export interface EvaluationScore {
  /** メトリクス識別子（例: keyword-coverage）。非空。 */
  readonly metric: string;
  /** 0..1 の採点値。 */
  readonly score: number;
  /** 採点理由（任意）。 */
  readonly reason?: string;
}

export interface EvaluationResult {
  readonly scores: readonly EvaluationScore[];
  /** scores の score 平均（空なら 0）。 */
  readonly average: number;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** スコア配列を検証・正規化し、平均付きの EvaluationResult を作る。 */
export function createEvaluationResult(scores: readonly EvaluationScore[]): EvaluationResult {
  const normalized = scores.map((entry, index) => {
    if (typeof entry.metric !== 'string' || entry.metric.trim().length === 0) {
      throw new EvaluationDomainError(`createEvaluationResult: scores.${index}.metric must be a non-empty string`);
    }
    if (!Number.isFinite(entry.score)) {
      throw new EvaluationDomainError(`createEvaluationResult: scores.${index}.score must be a finite number`);
    }
    return {
      metric: entry.metric,
      score: clamp01(entry.score),
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
    };
  });
  const average = normalized.length === 0
    ? 0
    : normalized.reduce((sum, entry) => sum + entry.score, 0) / normalized.length;
  return { scores: normalized, average };
}
