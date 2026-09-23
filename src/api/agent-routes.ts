import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DeleteAgentUseCase } from '../application/agent/delete-agent';
import { buildDraftAgent, type DiagnoseAgentToolsUseCase } from '../application/agent/diagnose-agent-tools';
import type { GenerateAgentPromptUseCase } from '../application/agent/generate-agent-prompt';
import type { QueryAgentsUseCase } from '../application/agent/query-agents';
import type { SaveAgentUseCase } from '../application/agent/save-agent';
import { serializeAgent } from '../domain/agent/serialization';
import { SemVer } from '../domain/tool/semver';
import { scopeOf } from './authentication';
import { withResolvedOwner } from './owner';
import { BadRequestError } from './error-mapping';
import { agentDraftPromptBodySchema, agentListQuerySchema, agentPromptBodySchema, saveAgentBodySchema, scopeQuerySchema, versionQuerySchema } from './schemas';

export interface AgentRouteDeps {
  readonly saveAgent: SaveAgentUseCase;
  readonly queryAgents: QueryAgentsUseCase;
  readonly generateAgentPrompt: GenerateAgentPromptUseCase;
  readonly deleteAgent: DeleteAgentUseCase;
  readonly diagnoseAgentTools: DiagnoseAgentToolsUseCase;
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
      ...withResolvedOwner(request, body),
      scope: scopeOf(request),
      skills: body.skills.map((skill) => ({ internalId: skill.internalId, version: version(skill.version) as SemVer })),
      tools: body.tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer })),
      agents: body.agents.map((sub) => ({ internalId: sub.internalId, version: version(sub.version) as SemVer, usage: sub.usage })),
      wikis: body.wikis,
      mcpServers: body.mcpServers,
      ...(body.harness !== undefined ? { harness: body.harness } : {}),
    });
    return reply.status(201).send({ agent: serializeAgent(agent) });
  });

  app.get('/agents', async (request) => {
    const query = parseWith(agentListQuerySchema, request.query, 'invalid query');
    const agents = await deps.queryAgents.list(scopeOf(request), query.kind);
    return { agents: agents.map((agent) => ({ ...agent, latestVersion: agent.latestVersion.toString() })) };
  });

  app.get<{ Params: AgentParams }>('/agents/:internalId', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const agent = await deps.queryAgents.get(
      scopeOf(request),
      request.params.internalId,
      version(query.version),
    );
    return { agent: serializeAgent(agent) };
  });

  // Tool呼び出しのプリフライト診断。実行せずに「どの段階で呼び出せなくなるか」を一覧で返す。
  app.get<{ Params: AgentParams }>('/agents/:internalId/diagnostics', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const agent = await deps.queryAgents.get(scopeOf(request), request.params.internalId, version(query.version));
    const diagnostics = await deps.diagnoseAgentTools.execute(scopeOf(request), agent);
    return { diagnostics };
  });

  app.get<{ Params: AgentParams }>('/agents/:internalId/versions', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    const versions = await deps.queryAgents.versions(scopeOf(request), request.params.internalId);
    return { versions: versions.map((item) => item.toString()) };
  });

  // 論理削除。204で成功を返し、未存在/削除済みは deleteAgent が AgentNotFoundError → 404 へ変換される。
  app.delete<{ Params: AgentParams }>('/agents/:internalId', async (request, reply) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    await deps.deleteAgent.execute(scopeOf(request), request.params.internalId);
    return reply.status(204).send();
  });

  // 未保存 Agent のプリフライト診断。保存と同じ body を受け、保存と同じ createAgent 検証を通した
  // Agent を検査する（保存はしない）。版は未保存の印として 0.0.0 で報告する。
  app.post('/agent-drafts/diagnose', async (request) => {
    const body = parseWith(saveAgentBodySchema, request.body, 'invalid body');
    const scope = scopeOf(request);
    const agent = buildDraftAgent({
      ...withResolvedOwner(request, body),
      scope,
      skills: body.skills.map((skill) => ({ internalId: skill.internalId, version: version(skill.version) as SemVer })),
      tools: body.tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer })),
      agents: body.agents.map((sub) => ({ internalId: sub.internalId, version: version(sub.version) as SemVer, usage: sub.usage })),
      wikis: body.wikis,
      mcpServers: body.mcpServers,
      ...(body.harness !== undefined ? { harness: body.harness } : {}),
    });
    const diagnostics = await deps.diagnoseAgentTools.execute(scope, agent);
    return { diagnostics };
  });

  app.post('/agent-drafts/generate-prompt', async (request) => {
    const body = parseWith(agentDraftPromptBodySchema, request.body, 'invalid body');
    const draft = await deps.generateAgentPrompt.execute({
      ...body,
      scope: scopeOf(request),
      skills: body.skills.map((skill) => ({ internalId: skill.internalId, version: version(skill.version) as SemVer })),
      tools: body.tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer })),
      agents: body.agents.map((sub) => ({ internalId: sub.internalId, version: version(sub.version) as SemVer, usage: sub.usage })),
    });
    return { draft };
  });

  app.post<{ Params: AgentParams }>('/agents/:internalId/generate-prompt', async (request) => {
    const body = parseWith(agentPromptBodySchema, request.body, 'invalid body');
    const agent = await deps.queryAgents.get(scopeOf(request), request.params.internalId, version(body.version));
    const draft = await deps.generateAgentPrompt.execute({
      scope: scopeOf(request),
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
