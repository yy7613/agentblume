/**
 * api層: シナリオ検証ルート（v16 実装契約 §5）
 *
 * Persona / Scenario の Save・Query、シナリオ実行（同期）、ScenarioRun の一覧・詳細を公開する。
 * scope は明示（body / query）で受け、serialize 済み DTO を返す。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { QueryPersonasUseCase } from '../application/validation/query-personas';
import type { QueryScenarioRunsUseCase } from '../application/validation/query-scenario-runs';
import type { QueryScenariosUseCase } from '../application/validation/query-scenarios';
import type { RunScenarioUseCase } from '../application/validation/run-scenario';
import type { RegisterPseudoUserAgentUseCase } from '../application/validation/register-pseudo-user-agent';
import type { SavePersonaUseCase } from '../application/validation/save-persona';
import type { SaveScenarioUseCase } from '../application/validation/save-scenario';
import { serializeAgent } from '../domain/agent/serialization';
import { serializePersona, serializeScenario, serializeScenarioRun } from '../domain/validation/serialization';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import {
  registerPseudoUserAgentBodySchema, runScenarioBodySchema, savePersonaBodySchema, saveScenarioBodySchema,
  scenarioRunListQuerySchema, scopeQuerySchema, versionQuerySchema,
} from './schemas';

export interface ValidationRouteDeps {
  readonly savePersona: SavePersonaUseCase;
  readonly queryPersonas: QueryPersonasUseCase;
  readonly registerPseudoUserAgent: RegisterPseudoUserAgentUseCase;
  readonly saveScenario: SaveScenarioUseCase;
  readonly queryScenarios: QueryScenariosUseCase;
  readonly runScenario: RunScenarioUseCase;
  readonly queryScenarioRuns: QueryScenarioRunsUseCase;
}

interface IdParams { internalId: string }

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  }
  return result.data as z.infer<S>;
}

function version(value?: string): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); }
  catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

export function registerValidationRoutes(app: FastifyInstance, deps: ValidationRouteDeps): void {
  // Persona: Save / 一覧 / 取得（latest・version）/ バージョン列挙。
  app.post('/personas', async (request, reply) => {
    const body = parse(savePersonaBodySchema, request.body);
    const persona = await deps.savePersona.execute(body);
    return reply.status(201).send({ persona: serializePersona(persona) });
  });
  app.get('/personas', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    const personas = await deps.queryPersonas.list(query);
    return { personas: personas.map((persona) => ({ ...persona, latestVersion: persona.latestVersion.toString() })) };
  });
  app.get<{ Params: IdParams }>('/personas/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    const persona = await deps.queryPersonas.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.internalId, version(query.version));
    return { persona: serializePersona(persona) };
  });
  app.get<{ Params: IdParams }>('/personas/:internalId/versions', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryPersonas.versions(query, request.params.internalId)).map(String) };
  });
  // Persona → 疑似ユーザーAgent 登録（v18）。
  app.post<{ Params: IdParams }>('/personas/:internalId/register-agent', async (request, reply) => {
    const body = parse(registerPseudoUserAgentBodySchema, request.body);
    const agent = await deps.registerPseudoUserAgent.execute({
      scope: body.scope,
      personaId: request.params.internalId,
      ...(body.personaVersion !== undefined ? { personaVersion: version(body.personaVersion) as SemVer } : {}),
      ...(body.agentInternalId !== undefined ? { agentInternalId: body.agentInternalId } : {}),
      ...(body.bump !== undefined ? { bump: body.bump } : {}),
      ...(body.promptOverride !== undefined ? { promptOverride: body.promptOverride } : {}),
    });
    return reply.status(201).send({ agent: serializeAgent(agent) });
  });

  // Scenario: Save（参照整合検証はユースケース側）/ 一覧 / 取得 / バージョン列挙。
  app.post('/scenarios', async (request, reply) => {
    const body = parse(saveScenarioBodySchema, request.body);
    const { persona, pseudoUser, ...rest } = body;
    const scenario = await deps.saveScenario.execute({
      ...rest,
      target: { agentId: body.target.agentId, version: version(body.target.version) as SemVer },
      ...(persona !== undefined ? { persona: { personaId: persona.personaId, version: version(persona.version) as SemVer } } : {}),
      ...(pseudoUser !== undefined ? { pseudoUser: { agentId: pseudoUser.agentId, version: version(pseudoUser.version) as SemVer } } : {}),
    });
    return reply.status(201).send({ scenario: serializeScenario(scenario) });
  });
  app.get('/scenarios', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    const scenarios = await deps.queryScenarios.list(query);
    return { scenarios: scenarios.map((scenario) => ({ ...scenario, latestVersion: scenario.latestVersion.toString() })) };
  });
  app.get<{ Params: IdParams }>('/scenarios/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    const scenario = await deps.queryScenarios.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.internalId, version(query.version));
    return { scenario: serializeScenario(scenario) };
  });
  app.get<{ Params: IdParams }>('/scenarios/:internalId/versions', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryScenarios.versions(query, request.params.internalId)).map(String) };
  });

  // シナリオ実行（同期）: 疑似ユーザー × 対象Agent の会話 + アンケート。
  app.post<{ Params: IdParams }>('/scenarios/:internalId/run', async (request) => {
    const body = parse(runScenarioBodySchema, request.body);
    const parsedVersion = version(body.version);
    const run = await deps.runScenario.execute({
      scope: body.scope,
      scenarioId: request.params.internalId,
      ...(parsedVersion !== undefined ? { version: parsedVersion } : {}),
      mode: body.mode,
    }, request.raw.signal);
    return { run: serializeScenarioRun(run) };
  });

  // ScenarioRun: 一覧（新しい順・scenarioId絞り込み）/ 詳細。
  app.get('/scenario-runs', async (request) => {
    const query = parse(scenarioRunListQuerySchema, request.query);
    const runs = await deps.queryScenarioRuns.list(
      { tenantId: query.tenantId, workspaceId: query.workspaceId },
      query.scenarioId !== undefined ? { scenarioId: query.scenarioId } : undefined,
    );
    return { runs: runs.map(serializeScenarioRun) };
  });
  app.get<{ Params: { id: string } }>('/scenario-runs/:id', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    const run = await deps.queryScenarioRuns.get(query, request.params.id);
    return { run: serializeScenarioRun(run) };
  });
}
