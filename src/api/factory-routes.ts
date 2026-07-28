/**
 * api層: Agent Factory ルート（v33 実装契約 §4 / docs/16-agent-factory.md §9）。
 * `harness-run-routes.ts` の `parseWith` パターン・`experiment-routes.ts` の 202 パターンを踏襲する。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { CancelFactoryRunUseCase } from '../application/factory/cancel-factory-run';
import type { CreateFactoryRunUseCase } from '../application/factory/create-factory-run';
import type { QueryFactoryRunsUseCase } from '../application/factory/query-factory-runs';
import type { ResumeFactoryRunUseCase } from '../application/factory/resume-factory-run';
import type { RetryFactoryRunUseCase } from '../application/factory/retry-factory-run';
import { clientAbortSignal } from './client-abort';
import { principalOf, scopeOf } from './authentication';
import { recordAuditDetail } from './authorization';
import { BadRequestError } from './error-mapping';
import { cancelFactoryRunBodySchema, factoryRunBodySchema, factoryRunListQuerySchema, factoryRunQuerySchema, resumeFactoryRunBodySchema, retryFactoryRunBodySchema } from './schemas';

export interface FactoryRouteDeps {
  readonly createFactoryRun: CreateFactoryRunUseCase;
  readonly queryFactoryRuns: QueryFactoryRunsUseCase;
  readonly resumeFactoryRun: ResumeFactoryRunUseCase;
  readonly retryFactoryRun: RetryFactoryRunUseCase;
  readonly cancelFactoryRun: CancelFactoryRunUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

export function registerFactoryRoutes(app: FastifyInstance, deps: FactoryRouteDeps): void {
  app.post('/factory-runs', async (request, reply) => {
    const body = parseWith(factoryRunBodySchema, request.body, 'invalid body');
    const run = await deps.createFactoryRun.execute({
      scope: scopeOf(request),
      goal: body.goal,
      dataSourceIds: body.dataSourceIds,
      ...(body.baseAgent === undefined ? {} : { baseAgent: body.baseAgent }),
      ...(body.options === undefined ? {} : { options: body.options }),
    });
    return reply.status(202).send({ run });
  });

  app.get('/factory-runs', async (request) => {
    const query = parseWith(factoryRunListQuerySchema, request.query, 'invalid query');
    const runs = await deps.queryFactoryRuns.list(scopeOf(request), { ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.status === undefined ? {} : { status: query.status }) });
    return { runs };
  });

  app.get<{ Params: { runId: string } }>('/factory-runs/:runId', async (request) => {
    parseWith(factoryRunQuerySchema, request.query, 'invalid query');
    return { run: await deps.queryFactoryRuns.get(scopeOf(request), request.params.runId) };
  });

  app.get<{ Params: { runId: string } }>('/factory-runs/:runId/events', async (request) => {
    parseWith(factoryRunQuerySchema, request.query, 'invalid query');
    const run = await deps.queryFactoryRuns.get(scopeOf(request), request.params.runId);
    return { events: run.events };
  });

  /** 計画承認しか来ない入口なので `approve` 権限が要る（`api/authorization.ts` の表）。承認者は監査へ残す。 */
  app.post<{ Params: { runId: string } }>('/factory-runs/:runId/responses', async (request, reply) => {
    const body = parseWith(resumeFactoryRunBodySchema, request.body, 'invalid body');
    recordAuditDetail(request, { decision: body.response.decision, decidedBy: principalOf(request).subject });
    const run = await deps.resumeFactoryRun.execute({ scope: scopeOf(request), runId: request.params.runId, decision: body.response.decision, ...(body.response.feedback === undefined ? {} : { feedback: body.response.feedback }) }, clientAbortSignal(request, reply));
    return { run };
  });

  // 失敗Runの再実行: 元Runは書き換えず、同じ入力の新しいRunを起票するため POST /factory-runs と同じ202を返す。
  app.post<{ Params: { runId: string } }>('/factory-runs/:runId/retry', async (request, reply) => {
    parseWith(retryFactoryRunBodySchema, request.body, 'invalid body');
    const run = await deps.retryFactoryRun.execute({ scope: scopeOf(request), runId: request.params.runId });
    return reply.status(202).send({ run });
  });

  app.post<{ Params: { runId: string } }>('/factory-runs/:runId/cancel', async (request) => {
    parseWith(cancelFactoryRunBodySchema, request.body, 'invalid body');
    return { run: await deps.cancelFactoryRun.execute(scopeOf(request), request.params.runId) };
  });
}
