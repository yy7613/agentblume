import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { CancelExperimentUseCase } from '../application/evaluation/cancel-experiment';
import type { CreateExperimentUseCase } from '../application/evaluation/create-experiment';
import type { QueryExperimentsUseCase } from '../application/evaluation/query-experiments';
import type { ResumeExperimentUseCase } from '../application/evaluation/resume-experiment';
import { serializeExperiment, serializeExperimentCaseResult } from '../domain/evaluation/experiment-serialization';
import { SemVer } from '../domain/tool/semver';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { createExperimentBodySchema, experimentActionBodySchema, experimentListQuerySchema, scopeQuerySchema } from './schemas';

export interface ExperimentRouteDeps {
  readonly createExperiment: CreateExperimentUseCase;
  readonly queryExperiments: QueryExperimentsUseCase;
  readonly cancelExperiment: CancelExperimentUseCase;
  readonly resumeExperiment: ResumeExperimentUseCase;
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`); return result.data as z.infer<S>; }
function version(value: string): SemVer { try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }

export function registerExperimentRoutes(app: FastifyInstance, deps: ExperimentRouteDeps): void {
  app.post('/experiments', async (request, reply) => {
    const body = parse(createExperimentBodySchema, request.body);
    const experiment = await deps.createExperiment.execute({ scope: scopeOf(request), target: { agentId: body.target.agentId, version: version(body.target.version) }, dataset: { id: body.dataset.id, version: version(body.dataset.version) }, evaluatorProfile: { id: body.evaluatorProfile.id, version: version(body.evaluatorProfile.version) }, ...(body.repetitions !== undefined ? { repetitions: body.repetitions } : {}) });
    return reply.status(202).send({ experiment: serializeExperiment(experiment) });
  });
  app.get('/experiments', async (request) => { const query = parse(experimentListQuerySchema, request.query); return { experiments: (await deps.queryExperiments.list(scopeOf(request), query.status)).map(serializeExperiment) }; });
  app.get<{ Params: { id: string } }>('/experiments/:id/results', async (request) => { parse(scopeQuerySchema, request.query); return { results: (await deps.queryExperiments.results(scopeOf(request), request.params.id)).map(serializeExperimentCaseResult) }; });
  app.post<{ Params: { id: string } }>('/experiments/:id/cancel', async (request) => { parse(experimentActionBodySchema, request.body); return { experiment: serializeExperiment(await deps.cancelExperiment.execute(scopeOf(request), request.params.id)) }; });
  app.post<{ Params: { id: string } }>('/experiments/:id/resume', async (request) => { parse(experimentActionBodySchema, request.body); return { experiment: serializeExperiment(await deps.resumeExperiment.execute(scopeOf(request), request.params.id)) }; });
  app.get<{ Params: { id: string } }>('/experiments/:id', async (request) => { parse(scopeQuerySchema, request.query); return { experiment: serializeExperiment(await deps.queryExperiments.get(scopeOf(request), request.params.id)) }; });
}
