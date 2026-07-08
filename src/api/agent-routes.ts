import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { GenerateAgentPromptUseCase } from '../application/agent/generate-agent-prompt';
import type { QueryAgentsUseCase } from '../application/agent/query-agents';
import type { SaveAgentUseCase } from '../application/agent/save-agent';
import { serializeAgent } from '../domain/agent/serialization';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { agentDraftPromptBodySchema, agentPromptBodySchema, saveAgentBodySchema, scopeQuerySchema, versionQuerySchema } from './schemas';

export interface AgentRouteDeps {
  readonly saveAgent: SaveAgentUseCase;
  readonly queryAgents: QueryAgentsUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
}

interface AgentParams { internalId: string }

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new BadRequestError(`${label}: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

function version(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); }
  catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRouteDeps): void {
  app.post('/agents', async (request, reply) => {
    const body = parseWith(saveAgentBodySchema, request.body, 'invalid body');
    const agent = await deps.saveAgent.execute({
      ...body,
      skills: body.skills.map((skill) => ({ internalId: skill.internalId, version: version(skill.version) as SemVer })),
      tools: body.tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer })),
      agents: body.agents.map((sub) => ({ internalId: sub.internalId, version: version(sub.version) as SemVer, usage: sub.usage })),
    });
    return reply.status(201).send({ agent: serializeAgent(agent) });
  });

  app.get('/agents', async (request) => {
    const query = parseWith(scopeQuerySchema, request.query, 'invalid query');
    const agents = await deps.queryAgents.list({ tenantId: query.tenantId, workspaceId: query.workspaceId });
    return { agents: agents.map((agent) => ({ ...agent, latestVersion: agent.latestVersion.toString() })) };
  });

  app.get<{ Params: AgentParams }>('/agents/:internalId', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const agent = await deps.queryAgents.get(
      { tenantId: query.tenantId, workspaceId: query.workspaceId },
      request.params.internalId,
      version(query.version),
    );
    return { agent: serializeAgent(agent) };
  });

  app.get<{ Params: AgentParams }>('/agents/:internalId/versions', async (request) => {
    const query = parseWith(scopeQuerySchema, request.query, 'invalid query');
    const versions = await deps.queryAgents.versions({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.internalId);
    return { versions: versions.map((item) => item.toString()) };
  });

  app.post('/agent-drafts/generate-prompt', async (request) => {
    const body = parseWith(agentDraftPromptBodySchema, request.body, 'invalid body');
    const draft = await deps.generateAgentPrompt.execute({
      ...body,
      skills: body.skills.map((skill) => ({ internalId: skill.internalId, version: version(skill.version) as SemVer })),
      tools: body.tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer })),
      agents: body.agents.map((sub) => ({ internalId: sub.internalId, version: version(sub.version) as SemVer, usage: sub.usage })),
    });
    return { draft };
  });

  app.post<{ Params: AgentParams }>('/agents/:internalId/generate-prompt', async (request) => {
    const body = parseWith(agentPromptBodySchema, request.body, 'invalid body');
    const agent = await deps.queryAgents.get(body.scope, request.params.internalId, version(body.version));
    const draft = await deps.generateAgentPrompt.execute({
      scope: body.scope,
      displayName: agent.metadata.displayName,
      kind: agent.kind,
      skills: agent.skills,
      tools: agent.tools,
      agents: agent.agents,
      ...(agent.output !== undefined ? { output: agent.output } : {}),
    });
    return { draft };
  });
}
