import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { QueryHarnessRunsUseCase, RunHarnessUseCase } from '../application/harness/run-harness';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { harnessRunListQuerySchema, harnessRunQuerySchema, runHarnessBodySchema } from './schemas';

export interface HarnessRunRouteDeps { readonly runHarness: RunHarnessUseCase; readonly queryHarnessRuns: QueryHarnessRunsUseCase; }
function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}
function version(value: string | undefined): SemVer | undefined { if (value === undefined) return undefined; try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }
export function registerHarnessRunRoutes(app: FastifyInstance, deps: HarnessRunRouteDeps): void {
  app.post('/harness-runs', async (request) => {
    const body = parseWith(runHarnessBodySchema, request.body, 'invalid body');
    return { run: await deps.runHarness.execute({ scope: body.scope, harnessId: body.harness.internalId, ...(version(body.harness.version) === undefined ? {} : { version: version(body.harness.version) }), message: body.message, mode: body.mode }, request.raw.signal) };
  });
  app.get('/harness-runs', async (request) => {
    const query = parseWith(harnessRunListQuerySchema, request.query, 'invalid query');
    return { runs: await deps.queryHarnessRuns.list({ tenantId: query.tenantId, workspaceId: query.workspaceId }, { ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.status === undefined ? {} : { status: query.status }) }) };
  });
  app.get<{ Params: { runId: string } }>('/harness-runs/:runId', async (request) => {
    const query = parseWith(harnessRunQuerySchema, request.query, 'invalid query');
    return { run: await deps.queryHarnessRuns.get(query, request.params.runId) };
  });
  app.get<{ Params: { runId: string } }>('/harness-runs/:runId/events', async (request) => {
    const query = parseWith(harnessRunQuerySchema, request.query, 'invalid query');
    const run = await deps.queryHarnessRuns.get(query, request.params.runId);
    return { events: run.events };
  });
}
