import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { serializeEvaluationDataset, serializeEvaluatorProfile, serializeJudgeRubric } from '../domain/evaluation/assets-serialization';
import type { ExportEvaluationDatasetUseCase, ImportEvaluationCasesUseCase } from '../application/evaluation/evaluation-dataset-transfer';
import { serializeImportedCases } from '../application/evaluation/evaluation-dataset-transfer';
import type { DeleteEvaluationDatasetUseCase, QueryEvaluationDatasetsUseCase } from '../application/evaluation/query-evaluation-datasets';
import type { DeleteEvaluatorProfileUseCase, QueryEvaluatorProfilesUseCase } from '../application/evaluation/query-evaluator-profiles';
import type { SaveEvaluationDatasetUseCase } from '../application/evaluation/save-evaluation-dataset';
import type { SaveEvaluatorProfileUseCase } from '../application/evaluation/save-evaluator-profile';
import type { SaveJudgeRubricUseCase } from '../application/evaluation/save-judge-rubric';
import type { DeleteJudgeRubricUseCase, QueryJudgeRubricsUseCase } from '../application/evaluation/query-judge-rubrics';
import { SemVer } from '../domain/tool/semver';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import {
  evaluationDatasetExportQuerySchema, importEvaluationDatasetBodySchema, saveEvaluationDatasetBodySchema,
  saveEvaluatorProfileBodySchema, saveJudgeRubricBodySchema, scopeQuerySchema, versionQuerySchema,
} from './schemas';

export interface EvaluationAssetRouteDeps {
  readonly saveEvaluationDataset: SaveEvaluationDatasetUseCase;
  readonly queryEvaluationDatasets: QueryEvaluationDatasetsUseCase;
  readonly deleteEvaluationDataset: DeleteEvaluationDatasetUseCase;
  readonly importEvaluationCases: ImportEvaluationCasesUseCase;
  readonly exportEvaluationDataset: ExportEvaluationDatasetUseCase;
  readonly saveEvaluatorProfile: SaveEvaluatorProfileUseCase;
  readonly queryEvaluatorProfiles: QueryEvaluatorProfilesUseCase;
  readonly deleteEvaluatorProfile: DeleteEvaluatorProfileUseCase;
  readonly saveJudgeRubric: SaveJudgeRubricUseCase;
  readonly queryJudgeRubrics: QueryJudgeRubricsUseCase;
  readonly deleteJudgeRubric: DeleteJudgeRubricUseCase;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return result.data as z.infer<S>;
}
function version(value?: string): SemVer | undefined { if (value === undefined) return undefined; try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }

export function registerEvaluationAssetRoutes(app: FastifyInstance, deps: EvaluationAssetRouteDeps): void {
  app.post('/evaluation-datasets/import', async (request) => {
    const body = parse(importEvaluationDatasetBodySchema, request.body);
    return { cases: serializeImportedCases(deps.importEvaluationCases.execute(body.format, body.content)) };
  });
  app.post('/evaluation-datasets', async (request, reply) => {
    const body = parse(saveEvaluationDatasetBodySchema, request.body);
    const dataset = await deps.saveEvaluationDataset.execute({
      ...body,
      scope: scopeOf(request),
      cases: body.cases.map((entry) => entry.kind === 'turn'
        ? { ...entry }
        : { ...entry, scenario: { id: entry.scenario.id, version: version(entry.scenario.version) as SemVer } }),
    });
    return reply.status(201).send({ dataset: serializeEvaluationDataset(dataset) });
  });
  app.get('/evaluation-datasets', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { datasets: (await deps.queryEvaluationDatasets.list(scopeOf(request))).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId/versions', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryEvaluationDatasets.versions(scopeOf(request), request.params.internalId)).map(String) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId/export', async (request) => {
    const query = parse(evaluationDatasetExportQuerySchema, request.query);
    const dataset = await deps.queryEvaluationDatasets.get(scopeOf(request), request.params.internalId, version(query.version));
    return { format: query.format, content: deps.exportEvaluationDataset.execute(dataset, query.format) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    return { dataset: serializeEvaluationDataset(await deps.queryEvaluationDatasets.get(scopeOf(request), request.params.internalId, version(query.version))) };
  });
  app.delete<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId', async (request, reply) => {
    parse(scopeQuerySchema, request.query);
    await deps.deleteEvaluationDataset.execute(scopeOf(request), request.params.internalId);
    return reply.status(204).send();
  });

  app.post('/evaluator-profiles', async (request, reply) => {
    const body = parse(saveEvaluatorProfileBodySchema, request.body);
    return reply.status(201).send({ profile: serializeEvaluatorProfile(await deps.saveEvaluatorProfile.execute({ ...body, scope: scopeOf(request), metrics: body.metrics.map((metric) => metric.kind === 'code' ? metric : { ...metric, rubric: { id: metric.rubric.id, version: version(metric.rubric.version) as SemVer } }) })) });
  });
  app.get('/evaluator-profiles', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { profiles: (await deps.queryEvaluatorProfiles.list(scopeOf(request))).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluator-profiles/:internalId/versions', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryEvaluatorProfiles.versions(scopeOf(request), request.params.internalId)).map(String) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluator-profiles/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    return { profile: serializeEvaluatorProfile(await deps.queryEvaluatorProfiles.get(scopeOf(request), request.params.internalId, version(query.version))) };
  });
  app.delete<{ Params: { internalId: string } }>('/evaluator-profiles/:internalId', async (request, reply) => {
    parse(scopeQuerySchema, request.query);
    await deps.deleteEvaluatorProfile.execute(scopeOf(request), request.params.internalId);
    return reply.status(204).send();
  });

  app.post('/judge-rubrics', async (request, reply) => { const body = parse(saveJudgeRubricBodySchema, request.body); return reply.status(201).send({ rubric: serializeJudgeRubric(await deps.saveJudgeRubric.execute({ ...body, scope: scopeOf(request) })) }); });
  app.get('/judge-rubrics', async (request) => { parse(scopeQuerySchema, request.query); return { rubrics: (await deps.queryJudgeRubrics.list(scopeOf(request))).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) }; });
  app.get<{ Params: { internalId: string } }>('/judge-rubrics/:internalId/versions', async (request) => { parse(scopeQuerySchema, request.query); return { versions: (await deps.queryJudgeRubrics.versions(scopeOf(request), request.params.internalId)).map(String) }; });
  app.get<{ Params: { internalId: string } }>('/judge-rubrics/:internalId', async (request) => { const query = parse(versionQuerySchema, request.query); return { rubric: serializeJudgeRubric(await deps.queryJudgeRubrics.get(scopeOf(request), request.params.internalId, version(query.version))) }; });
  app.delete<{ Params: { internalId: string } }>('/judge-rubrics/:internalId', async (request, reply) => { parse(scopeQuerySchema, request.query); await deps.deleteJudgeRubric.execute(scopeOf(request), request.params.internalId); return reply.status(204).send(); });
}
