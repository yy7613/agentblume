import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { CompareExperimentsUseCase, DecidePromotionUseCase, EvaluateQualityGateUseCase, QueryQualityGatesUseCase, RequestPromotionUseCase, SaveGatePolicyUseCase } from '../application/evaluation/quality-gate-actions';
import { serializeGatePolicy, serializeGateReport, serializePromotionRequest } from '../domain/evaluation/quality-gate-serialization';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { decidePromotionBodySchema, evaluateGateBodySchema, experimentComparisonBodySchema, gateReportListQuerySchema, promotionListQuerySchema, requestPromotionBodySchema, saveGatePolicyBodySchema, scopeQuerySchema, versionQuerySchema } from './schemas';

export interface QualityGateRouteDeps {
  readonly compareExperiments: CompareExperimentsUseCase; readonly saveGatePolicy: SaveGatePolicyUseCase; readonly queryQualityGates: QueryQualityGatesUseCase;
  readonly evaluateQualityGate: EvaluateQualityGateUseCase; readonly requestPromotion: RequestPromotionUseCase; readonly decidePromotion: DecidePromotionUseCase;
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> { const result = schema.safeParse(value); if (!result.success) throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`); return result.data as z.infer<S>; }
function version(value: string): SemVer { try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }

export function registerQualityGateRoutes(app: FastifyInstance, deps: QualityGateRouteDeps): void {
  app.post('/experiment-comparisons', async (request) => { const body = parse(experimentComparisonBodySchema, request.body); return { comparison: await deps.compareExperiments.execute(body.scope, body.baselineExperimentId, body.candidateExperimentId) }; });
  app.post('/gate-policies', async (request, reply) => { const body = parse(saveGatePolicyBodySchema, request.body); return reply.status(201).send({ policy: serializeGatePolicy(await deps.saveGatePolicy.execute(body)) }); });
  app.get('/gate-policies', async (request) => { const query = parse(scopeQuerySchema, request.query); return { policies: (await deps.queryQualityGates.listPolicies(query)).map((item) => ({ ...item, latestVersion: item.latestVersion.toString() })) }; });
  app.get<{ Params: { id: string } }>('/gate-policies/:id/versions', async (request) => { const query = parse(scopeQuerySchema, request.query); return { versions: (await deps.queryQualityGates.policyVersions(query, request.params.id)).map(String) }; });
  app.get<{ Params: { id: string } }>('/gate-policies/:id', async (request) => { const query = parse(versionQuerySchema, request.query); return { policy: serializeGatePolicy(await deps.queryQualityGates.getPolicy(query, request.params.id, query.version === undefined ? undefined : version(query.version))) }; });
  app.post('/gate-reports', async (request, reply) => { const body = parse(evaluateGateBodySchema, request.body); const report = await deps.evaluateQualityGate.execute({ ...body, policy: { id: body.policy.id, version: version(body.policy.version) } }); return reply.status(201).send({ report: serializeGateReport(report) }); });
  app.get('/gate-reports', async (request) => { const query = parse(gateReportListQuerySchema, request.query); return { reports: (await deps.queryQualityGates.listReports(query, query.candidateExperimentId)).map(serializeGateReport) }; });
  app.get<{ Params: { id: string } }>('/gate-reports/:id', async (request) => { const query = parse(scopeQuerySchema, request.query); return { report: serializeGateReport(await deps.queryQualityGates.getReport(query, request.params.id)) }; });
  app.post<{ Params: { id: string; version: string } }>('/agents/:id/versions/:version/promotion-requests', async (request, reply) => { const body = parse(requestPromotionBodySchema, request.body); const promotion = await deps.requestPromotion.execute({ ...body, agentId: request.params.id, version: version(request.params.version) }); return reply.status(201).send({ promotion: serializePromotionRequest(promotion) }); });
  app.get('/promotion-requests', async (request) => { const query = parse(promotionListQuerySchema, request.query); return { promotions: (await deps.queryQualityGates.listPromotions(query, query.agentId)).map(serializePromotionRequest) }; });
  app.post<{ Params: { id: string } }>('/promotion-requests/:id/approve', async (request) => { const body = parse(decidePromotionBodySchema, request.body); return { promotion: serializePromotionRequest(await deps.decidePromotion.execute({ ...body, requestId: request.params.id, decision: 'approved' })) }; });
  app.post<{ Params: { id: string } }>('/promotion-requests/:id/reject', async (request) => { const body = parse(decidePromotionBodySchema, request.body); return { promotion: serializePromotionRequest(await deps.decidePromotion.execute({ ...body, requestId: request.params.id, decision: 'rejected' })) }; });
}
