/**
 * api層: エージェント応答評価ルート（v20 実装契約 §4 / ADR-0020）
 *
 * 入力・出力（＋任意reference）を受け、Mastra Evals ベースの採点結果 EvaluationResult を返す。
 * scope は任意（採点は決定的でスコープ非依存だが、将来の保存・監査のため受ける）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { EvaluateAgentRunUseCase } from '../application/evaluation/evaluate-agent-run';
import { BadRequestError } from './error-mapping';
import { evaluateBodySchema } from './schemas';

export interface EvaluationRouteDeps {
  readonly evaluateAgentRun: EvaluateAgentRunUseCase;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  }
  return result.data as z.infer<S>;
}

export function registerEvaluationRoutes(app: FastifyInstance, deps: EvaluationRouteDeps): void {
  app.post('/evaluations', async (request) => {
    const body = parse(evaluateBodySchema, request.body);
    const evaluation = await deps.evaluateAgentRun.execute({
      input: body.input,
      output: body.output,
      ...(body.reference !== undefined ? { reference: body.reference } : {}),
    });
    return { evaluation };
  });
}
