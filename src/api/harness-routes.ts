import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { CompileHarnessUseCase } from '../application/harness/compile-harness';
import type { DeleteHarnessUseCase } from '../application/harness/delete-harness';
import type { QueryHarnessesUseCase } from '../application/harness/query-harnesses';
import { buildHarness, type SaveHarnessInput, type SaveHarnessUseCase } from '../application/harness/save-harness';
import type { ValidateHarnessUseCase } from '../application/harness/validate-harness';
import { serializeAgentHarness } from '../domain/harness/serialization';
import type { HarnessTopology } from '../domain/harness/agent-harness';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { harnessListQuerySchema, saveHarnessBodySchema, scopeQuerySchema, versionQuerySchema } from './schemas';

export interface HarnessRouteDeps {
  readonly saveHarness: SaveHarnessUseCase;
  readonly queryHarnesses: QueryHarnessesUseCase;
  readonly validateHarness: ValidateHarnessUseCase;
  readonly compileHarness: CompileHarnessUseCase;
  readonly deleteHarness: DeleteHarnessUseCase;
}
interface HarnessParams { internalId: string }

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}
function parseVersion(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}
function inputFrom(body: z.infer<typeof saveHarnessBodySchema>): SaveHarnessInput {
  return {
    ...body,
    slots: body.slots.map((slot) => ({
      ...slot,
      assignment: { internalId: slot.assignment.internalId, version: parseVersion(slot.assignment.version) as SemVer },
    })),
    topology: body.topology as HarnessTopology,
  };
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRouteDeps): void {
  app.post('/harnesses', async (request, reply) => {
    const harness = await deps.saveHarness.execute(inputFrom(parseWith(saveHarnessBodySchema, request.body, 'invalid body')));
    return reply.status(201).send({ harness: serializeAgentHarness(harness) });
  });
  app.get('/harnesses', async (request) => {
    const query = parseWith(harnessListQuerySchema, request.query, 'invalid query');
    const harnesses = await deps.queryHarnesses.list(query);
    return { harnesses: harnesses.map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) };
  });
  app.get<{ Params: HarnessParams }>('/harnesses/:internalId', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const harness = await deps.queryHarnesses.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.internalId, parseVersion(query.version));
    return { harness: serializeAgentHarness(harness) };
  });
  app.get<{ Params: HarnessParams }>('/harnesses/:internalId/versions', async (request) => {
    const query = parseWith(scopeQuerySchema, request.query, 'invalid query');
    const versions = await deps.queryHarnesses.versions(query, request.params.internalId);
    return { versions: versions.map((item) => item.toString()) };
  });
  // 論理削除（docs §10）。204で成功を返し、未存在/削除済みは deleteHarness が HarnessNotFoundError → 404 へ変換される。
  app.delete<{ Params: HarnessParams }>('/harnesses/:internalId', async (request, reply) => {
    const query = parseWith(scopeQuerySchema, request.query, 'invalid query');
    await deps.deleteHarness.execute(query, request.params.internalId);
    return reply.status(204).send();
  });
  app.post('/harness-drafts/validate', async (request) => ({ validation: await deps.validateHarness.execute(inputFrom(parseWith(saveHarnessBodySchema, request.body, 'invalid body'))) }));
  app.post('/harness-drafts/compile', async (request) => {
    const input = inputFrom(parseWith(saveHarnessBodySchema, request.body, 'invalid body'));
    const validation = await deps.validateHarness.execute(input);
    if (!validation.valid) return { validation };
    // Draftは保存versionを持たないため、compileは保存済みHarnessと同じ不変条件を通した一時versionを返す。
    return { validation, executable: deps.compileHarness.execute(buildHarness(input, SemVer.of(0, 0, 0))) };
  });
}
