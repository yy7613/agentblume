import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { serializeEvaluationDataset, serializeEvaluatorProfile, serializeJudgeRubric } from '../domain/evaluation/assets-serialization';
import type { ExportEvaluationDatasetUseCase, ImportEvaluationCasesUseCase } from '../application/evaluation/evaluation-dataset-transfer';
import { serializeImportedCases } from '../application/evaluation/evaluation-dataset-transfer';
import type { QueryEvaluationDatasetsUseCase } from '../application/evaluation/query-evaluation-datasets';
import type { QueryEvaluatorProfilesUseCase } from '../application/evaluation/query-evaluator-profiles';
import type { SaveEvaluationDatasetUseCase } from '../application/evaluation/save-evaluation-dataset';
import type { SaveEvaluatorProfileUseCase } from '../application/evaluation/save-evaluator-profile';
import type { SaveJudgeRubricUseCase } from '../application/evaluation/save-judge-rubric';
import type { QueryJudgeRubricsUseCase } from '../application/evaluation/query-judge-rubrics';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import {
  evaluationDatasetExportQuerySchema, importEvaluationDatasetBodySchema, saveEvaluationDatasetBodySchema,
  saveEvaluatorProfileBodySchema, saveJudgeRubricBodySchema, scopeQuerySchema, versionQuerySchema,
} from './schemas';

export interface EvaluationAssetRouteDeps {
  readonly saveEvaluationDataset: SaveEvaluationDatasetUseCase;
  readonly queryEvaluationDatasets: QueryEvaluationDatasetsUseCase;
  readonly importEvaluationCases: ImportEvaluationCasesUseCase;
  readonly exportEvaluationDataset: ExportEvaluationDatasetUseCase;
  readonly saveEvaluatorProfile: SaveEvaluatorProfileUseCase;
  readonly queryEvaluatorProfiles: QueryEvaluatorProfilesUseCase;
  readonly saveJudgeRubric: SaveJudgeRubricUseCase;
  readonly queryJudgeRubrics: QueryJudgeRubricsUseCase;
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
      cases: body.cases.map((entry) => entry.kind === 'turn'
        ? { ...entry }
        : { ...entry, scenario: { id: entry.scenario.id, version: version(entry.scenario.version) as SemVer } }),
    });
    return reply.status(201).send({ dataset: serializeEvaluationDataset(dataset) });
  });
  app.get('/evaluation-datasets', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { datasets: (await deps.queryEvaluationDatasets.list(query)).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId/versions', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryEvaluationDatasets.versions(query, request.params.internalId)).map(String) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId/export', async (request) => {
    const query = parse(evaluationDatasetExportQuerySchema, request.query);
    const dataset = await deps.queryEvaluationDatasets.get(query, request.params.internalId, version(query.version));
    return { format: query.format, content: deps.exportEvaluationDataset.execute(dataset, query.format) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluation-datasets/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    return { dataset: serializeEvaluationDataset(await deps.queryEvaluationDatasets.get(query, request.params.internalId, version(query.version))) };
  });

  app.post('/evaluator-profiles', async (request, reply) => {
    const body = parse(saveEvaluatorProfileBodySchema, request.body);
    return reply.status(201).send({ profile: serializeEvaluatorProfile(await deps.saveEvaluatorProfile.execute({ ...body, metrics: body.metrics.map((metric) => metric.kind === 'code' ? metric : { ...metric, rubric: { id: metric.rubric.id, version: version(metric.rubric.version) as SemVer } }) })) });
  });
  app.get('/evaluator-profiles', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { profiles: (await deps.queryEvaluatorProfiles.list(query)).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluator-profiles/:internalId/versions', async (request) => {
    const query = parse(scopeQuerySchema, request.query);
    return { versions: (await deps.queryEvaluatorProfiles.versions(query, request.params.internalId)).map(String) };
  });
  app.get<{ Params: { internalId: string } }>('/evaluator-profiles/:internalId', async (request) => {
    const query = parse(versionQuerySchema, request.query);
    return { profile: serializeEvaluatorProfile(await deps.queryEvaluatorProfiles.get(query, request.params.internalId, version(query.version))) };
  });

  app.post('/judge-rubrics', async (request, reply) => { const body = parse(saveJudgeRubricBodySchema, request.body); return reply.status(201).send({ rubric: serializeJudgeRubric(await deps.saveJudgeRubric.execute(body)) }); });
  app.get('/judge-rubrics', async (request) => { const query = parse(scopeQuerySchema, request.query); return { rubrics: (await deps.queryJudgeRubrics.list(query)).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) }; });
  app.get<{ Params: { internalId: string } }>('/judge-rubrics/:internalId/versions', async (request) => { const query = parse(scopeQuerySchema, request.query); return { versions: (await deps.queryJudgeRubrics.versions(query, request.params.internalId)).map(String) }; });
  app.get<{ Params: { internalId: string } }>('/judge-rubrics/:internalId', async (request) => { const query = parse(versionQuerySchema, request.query); return { rubric: serializeJudgeRubric(await deps.queryJudgeRubrics.get(query, request.params.internalId, version(query.version))) }; });
}
