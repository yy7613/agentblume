import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import type { QueryRunsUseCase } from '../application/agent/query-runs';
import type { QueryWikiUseCase } from '../application/memory/query-wiki';
import type { TenantScope } from '../domain/tool/ids';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { runAgentBodySchema, runListQuerySchema, runTraceQuerySchema } from './schemas';

export interface RunRouteDeps {
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
  readonly queryWiki: QueryWikiUseCase;
}

/** アタッチした Wiki ページを最小コンテキスト（見出し + 字数制限本文）へ整形する。未存在は黙って除外。 */
async function buildMemoryContext(queryWiki: QueryWikiUseCase, scope: TenantScope, pageIds: readonly string[]): Promise<string | undefined> {
  const sections: string[] = [];
  for (const id of pageIds) {
    try {
      const page = await queryWiki.get(scope, id);
      const body = page.body.length > 600 ? `${page.body.slice(0, 600)}…` : page.body;
      sections.push(`## ${page.title}\n${body}`);
    } catch { /* 削除済みなどは無視して他ページを注入する。 */ }
  }
  return sections.length === 0 ? undefined : sections.join('\n\n');
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
    let run;
    if ('agent' in body) {
      const version = parseVersion(body.agent.version);
      const memoryContext = body.memoryPageIds !== undefined && body.memoryPageIds.length > 0
        ? await buildMemoryContext(deps.queryWiki, body.scope, body.memoryPageIds)
        : undefined;
      run = await deps.runAgentPreview.executeSaved({
        scope: body.scope,
        agentId: body.agent.internalId,
        ...(version !== undefined ? { version } : {}),
        message: body.message,
        mode: body.mode,
        ...(memoryContext !== undefined ? { memoryContext } : {}),
      }, request.raw.signal);
    } else {
      const version = parseVersion(body.tool.version);
      run = await deps.runAgentPreview.execute({
        scope: body.scope,
        toolId: body.tool.internalId,
        ...(version !== undefined ? { version } : {}),
        systemPrompt: body.systemPrompt,
        message: body.message,
        mode: body.mode,
      }, request.raw.signal);
    }
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
      runId: record.runId, status: record.status, mode: record.mode, tool: record.tool, tools: record.tools, agent: record.agent,
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
