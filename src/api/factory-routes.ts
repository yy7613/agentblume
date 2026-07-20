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
import { BadRequestError } from './error-mapping';
import { cancelFactoryRunBodySchema, factoryRunBodySchema, factoryRunListQuerySchema, factoryRunQuerySchema, resumeFactoryRunBodySchema } from './schemas';

export interface FactoryRouteDeps {
  readonly createFactoryRun: CreateFactoryRunUseCase;
  readonly queryFactoryRuns: QueryFactoryRunsUseCase;
  readonly resumeFactoryRun: ResumeFactoryRunUseCase;
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
    const run = await deps.createFactoryRun.execute({ scope: body.scope, goal: body.goal, dataSourceIds: body.dataSourceIds, ...(body.options === undefined ? {} : { options: body.options }) });
    return reply.status(202).send({ run });
  });

  app.get('/factory-runs', async (request) => {
    const query = parseWith(factoryRunListQuerySchema, request.query, 'invalid query');
    const runs = await deps.queryFactoryRuns.list({ tenantId: query.tenantId, workspaceId: query.workspaceId }, { ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.status === undefined ? {} : { status: query.status }) });
    return { runs };
  });

  app.get<{ Params: { runId: string } }>('/factory-runs/:runId', async (request) => {
    const query = parseWith(factoryRunQuerySchema, request.query, 'invalid query');
    return { run: await deps.queryFactoryRuns.get(query, request.params.runId) };
  });

  app.get<{ Params: { runId: string } }>('/factory-runs/:runId/events', async (request) => {
    const query = parseWith(factoryRunQuerySchema, request.query, 'invalid query');
    const run = await deps.queryFactoryRuns.get(query, request.params.runId);
    return { events: run.events };
  });

  app.post<{ Params: { runId: string } }>('/factory-runs/:runId/responses', async (request) => {
    const body = parseWith(resumeFactoryRunBodySchema, request.body, 'invalid body');
    const run = await deps.resumeFactoryRun.execute({ scope: body.scope, runId: request.params.runId, decision: body.response.decision, ...(body.response.feedback === undefined ? {} : { feedback: body.response.feedback }) }, request.raw.signal);
    return { run };
  });

  app.post<{ Params: { runId: string } }>('/factory-runs/:runId/cancel', async (request) => {
    const body = parseWith(cancelFactoryRunBodySchema, request.body, 'invalid body');
    return { run: await deps.cancelFactoryRun.execute(body.scope, request.params.runId) };
  });
}
