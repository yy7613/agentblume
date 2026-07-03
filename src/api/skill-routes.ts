import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { GenerateSkillPromptUseCase } from '../application/skill/generate-skill-prompt';
import type { QuerySkillsUseCase } from '../application/skill/query-skills';
import type { SaveSkillUseCase } from '../application/skill/save-skill';
import { serializeSkill } from '../domain/skill/serialization';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { saveSkillBodySchema, scopeQuerySchema, skillDraftPromptBodySchema, skillPromptBodySchema, versionQuerySchema } from './schemas';
export interface SkillRouteDeps { readonly saveSkill: SaveSkillUseCase; readonly querySkills: QuerySkillsUseCase; readonly generateSkillPrompt: GenerateSkillPromptUseCase }
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`); return result.data as z.infer<S>; }
function version(value?: string): SemVer | undefined { if (value === undefined) return undefined; try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }
const refs = (tools: readonly { internalId: string; version: string }[]) => tools.map((tool) => ({ internalId: tool.internalId, version: version(tool.version) as SemVer }));
export function registerSkillRoutes(app: FastifyInstance, deps: SkillRouteDeps): void {
  app.post('/skills', async (request, reply) => { const body = parse(saveSkillBodySchema, request.body); const skill = await deps.saveSkill.execute({ ...body, tools: refs(body.tools) }); return reply.status(201).send({ skill: serializeSkill(skill) }); });
  app.get('/skills', async (request) => { const query = parse(scopeQuerySchema, request.query); const skills = await deps.querySkills.list(query); return { skills: skills.map((skill) => ({ ...skill, latestVersion: skill.latestVersion.toString() })) }; });
  app.get<{ Params: { internalId: string } }>('/skills/:internalId', async (request) => { const query = parse(versionQuerySchema, request.query); return { skill: serializeSkill(await deps.querySkills.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.internalId, version(query.version))) }; });
  app.get<{ Params: { internalId: string } }>('/skills/:internalId/versions', async (request) => { const query = parse(scopeQuerySchema, request.query); return { versions: (await deps.querySkills.versions(query, request.params.internalId)).map(String) }; });
  app.post('/skill-drafts/generate-prompt', async (request) => { const body = parse(skillDraftPromptBodySchema, request.body); return { draft: await deps.generateSkillPrompt.execute({ ...body, tools: refs(body.tools) }) }; });
  app.post<{ Params: { internalId: string } }>('/skills/:internalId/generate-prompt', async (request) => { const body = parse(skillPromptBodySchema, request.body); const skill = await deps.querySkills.get(body.scope, request.params.internalId, version(body.version)); return { draft: await deps.generateSkillPrompt.execute({ scope: body.scope, displayName: skill.metadata.displayName, responsibility: skill.responsibility, activationCondition: skill.activationCondition, inputDescription: skill.inputDescription, outputDescription: skill.outputDescription, tools: skill.tools }) }; });
}
