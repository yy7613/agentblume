import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { QueryHarnessRunsUseCase, RunHarnessUseCase } from '../application/harness/run-harness';
import { SemVer } from '../domain/tool/semver';
import { clientAbortSignal } from './client-abort';
import { principalOf, scopeOf } from './authentication';
import { authorizeOf, recordAuditDetail } from './authorization';
import { BadRequestError } from './error-mapping';
import { cancelHarnessRunBodySchema, harnessRunListQuerySchema, harnessRunQuerySchema, resumeHarnessRunBodySchema, runHarnessBodySchema } from './schemas';

export interface HarnessRunRouteDeps { readonly runHarness: RunHarnessUseCase; readonly queryHarnessRuns: QueryHarnessRunsUseCase; }
function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}
function version(value: string | undefined): SemVer | undefined { if (value === undefined) return undefined; try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); } }
export function registerHarnessRunRoutes(app: FastifyInstance, deps: HarnessRunRouteDeps): void {
  app.post('/harness-runs', async (request, reply) => {
    const body = parseWith(runHarnessBodySchema, request.body, 'invalid body');
    const requestedVersion = version(body.harness.version);
    return { run: await deps.runHarness.execute({ scope: scopeOf(request), harnessId: body.harness.internalId, ...(requestedVersion === undefined ? {} : { version: requestedVersion }), message: body.message, mode: body.mode }, clientAbortSignal(request, reply)) };
  });
  /**
   * この入口には2種類の応答が来る。Handoffの**追加入力**（`kind: 'input'`）は会話の続きで、
   * Magenticの**計画承認**（`kind: 'approval'`）は実行前承認そのもの。
   * ルート表は最小権限（`harness:execute`）を要求し、承認の場合だけここで `approve` を足す
   * （入力まで Publisher に縛ると、Editor が自分で始めた対話を続けられなくなる）。
   */
  app.post<{ Params: { runId: string } }>('/harness-runs/:runId/responses', async (request, reply) => {
    const body = parseWith(resumeHarnessRunBodySchema, request.body, 'invalid body');
    if (body.response.kind === 'approval') {
      await authorizeOf(request)('approve', { kind: 'harness', id: request.params.runId });
      recordAuditDetail(request, { decision: body.response.decision, respondedBy: principalOf(request).subject });
    } else {
      recordAuditDetail(request, { responseKind: body.response.kind, respondedBy: principalOf(request).subject });
    }
    return { run: await deps.runHarness.resume({ scope: scopeOf(request), runId: request.params.runId, response: body.response }, clientAbortSignal(request, reply)) };
  });
  app.post<{ Params: { runId: string } }>('/harness-runs/:runId/cancel', async (request) => {
    parseWith(cancelHarnessRunBodySchema, request.body, 'invalid body');
    return { run: await deps.runHarness.cancel(scopeOf(request), request.params.runId) };
  });
  app.get('/harness-runs', async (request) => {
    const query = parseWith(harnessRunListQuerySchema, request.query, 'invalid query');
    return { runs: await deps.queryHarnessRuns.list(scopeOf(request), { ...(query.limit === undefined ? {} : { limit: query.limit }), ...(query.status === undefined ? {} : { status: query.status }) }) };
  });
  app.get<{ Params: { runId: string } }>('/harness-runs/:runId', async (request) => {
    parseWith(harnessRunQuerySchema, request.query, 'invalid query');
    return { run: await deps.queryHarnessRuns.get(scopeOf(request), request.params.runId) };
  });
  app.get<{ Params: { runId: string } }>('/harness-runs/:runId/events', async (request) => {
    parseWith(harnessRunQuerySchema, request.query, 'invalid query');
    const run = await deps.queryHarnessRuns.get(scopeOf(request), request.params.runId);
    return { events: run.events };
  });
}
