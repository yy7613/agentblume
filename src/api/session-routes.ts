import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { CreateAgentSessionUseCase, QueryAgentSessionUseCase } from '../application/session/agent-sessions';
import type { QuerySessionArtifactsUseCase } from '../application/session/session-artifacts';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { closeAgentSessionBodySchema, createAgentSessionBodySchema, sessionArtifactQuerySchema, sessionScopeQuerySchema } from './schemas';

export interface SessionRouteDeps {
  readonly createAgentSession: CreateAgentSessionUseCase;
  readonly queryAgentSession: QueryAgentSessionUseCase;
  readonly querySessionArtifacts: QuerySessionArtifactsUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`invalid request: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}
function parseVersion(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

export function registerSessionRoutes(app: FastifyInstance, deps: SessionRouteDeps): void {
  app.post('/agent-sessions', async (request, reply) => {
    const body = parseWith(createAgentSessionBodySchema, request.body);
    const version = parseVersion(body.agent.version);
    const session = await deps.createAgentSession.execute({ scope: body.scope, agentId: body.agent.internalId, ...(version === undefined ? {} : { version }) });
    return reply.status(201).send({ session });
  });
  app.get<{ Params: { sessionId: string } }>('/agent-sessions/:sessionId', async (request) => {
    const scope = parseWith(sessionScopeQuerySchema, request.query);
    return { session: await deps.queryAgentSession.get(scope, request.params.sessionId) };
  });
  app.post<{ Params: { sessionId: string } }>('/agent-sessions/:sessionId/close', async (request) => {
    const body = parseWith(closeAgentSessionBodySchema, request.body);
    return { session: await deps.queryAgentSession.close(body.scope, request.params.sessionId) };
  });
  app.get<{ Params: { sessionId: string } }>('/agent-sessions/:sessionId/artifacts', async (request) => {
    const scope = parseWith(sessionScopeQuerySchema, request.query);
    return { artifacts: await deps.querySessionArtifacts.list(scope, request.params.sessionId) };
  });
  app.get<{ Params: { sessionId: string; artifactId: string } }>('/agent-sessions/:sessionId/artifacts/:artifactId', async (request) => {
    const query = parseWith(sessionArtifactQuerySchema, request.query);
    return await deps.querySessionArtifacts.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.sessionId, request.params.artifactId, query.limit, query.offset, query.section);
  });
  app.delete<{ Params: { sessionId: string; artifactId: string } }>('/agent-sessions/:sessionId/artifacts/:artifactId', async (request, reply) => {
    const scope = parseWith(sessionScopeQuerySchema, request.query);
    await deps.querySessionArtifacts.delete(scope, request.params.sessionId, request.params.artifactId);
    return reply.status(204).send();
  });
}
