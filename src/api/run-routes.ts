import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import type { QueryRunsUseCase } from '../application/agent/query-runs';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { runAgentBodySchema, runListQuerySchema, runTraceQuerySchema } from './schemas';

export interface RunRouteDeps {
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new BadRequestError(`invalid body: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

function parseVersion(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); }
  catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post('/runs', async (request) => {
    const body = parseWith(runAgentBodySchema, request.body);
    const version = parseVersion(body.tool.version);
    const run = await deps.runAgentPreview.execute({
      scope: body.scope,
      toolId: body.tool.internalId,
      ...(version !== undefined ? { version } : {}),
      systemPrompt: body.systemPrompt,
      message: body.message,
      mode: body.mode,
    }, request.raw.signal);
    return { run };
  });

  app.get('/runs', async (request) => {
    const query = parseWith(runListQuerySchema, request.query);
    const scope = { tenantId: query.tenantId, workspaceId: query.workspaceId };
    const records = await deps.queryRuns.list(scope, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    });
    return { runs: records.map((record) => ({
      runId: record.runId, status: record.status, mode: record.mode, tool: record.tool,
      startedAt: record.startedAt, completedAt: record.completedAt,
      response: record.response, failure: record.failure, usage: record.usage,
      traceEventCount: record.trace.length,
    })) };
  });

  app.get<{ Params: { runId: string } }>('/runs/:runId/trace', async (request) => {
    const query = parseWith(runTraceQuerySchema, request.query);
    const run = await deps.queryRuns.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.runId);
    return { run };
  });
}
