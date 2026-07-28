import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { RunAgentPreviewUseCase } from '../application/agent/run-agent-preview';
import type { QueryRunsUseCase } from '../application/agent/query-runs';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { resumeRunBodySchema, runAgentBodySchema, runListQuerySchema, runTraceQuerySchema } from './schemas';
import type { RunApprovalCheckpoint, RunRecord } from '../domain/run/run';

/**
 * 保存されたcheckpointのうち、UIが承認判断に必要な部分だけを返す。
 * 会話履歴（messages）はモデルへ渡す再開用データなので、参照系APIでは公開しない。
 */
function checkpointSummary(checkpoint: RunApprovalCheckpoint | undefined) {
  if (checkpoint === undefined) return undefined;
  return {
    kind: checkpoint.kind,
    prompt: checkpoint.prompt,
    expiresAt: checkpoint.expiresAt,
    pendingCalls: checkpoint.pendingCalls.map((call) => ({ id: call.id, name: call.name })),
  };
}

function runView(record: RunRecord) {
  return { ...record, checkpoint: checkpointSummary(record.checkpoint) };
}

export interface RunRouteDeps {
  readonly runAgentPreview: RunAgentPreviewUseCase;
  readonly queryRuns: QueryRunsUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new BadRequestError(`invalid body: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

function parseVersion(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); }
  catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

/**
 * クライアント切断で abort する AbortSignal。**UIの「中断」はこれ1本に懸かっている**。
 *
 * `request.raw.signal` は Node 26.1 で入った新しいAPIで、`@types/node` が 26 系のため
 * 型検査は通るが、このリポジトリが動かす Node 22（.nvmrc / engines >=22.9）では
 * **実行時に undefined** になる。素で参照するとユースケースへ `undefined` が渡り、
 * ブラウザが fetch を abort してもモデル呼び出しは最大10分走り続ける。
 *
 * そのため未提供の実行環境では、応答ストリームが「書き終える前に閉じた」＝クライアントが
 * 切断した、という古典的な判定で同等のシグナルを自前で作る。
 */
export function clientAbortSignal(request: FastifyRequest, reply: FastifyReply): AbortSignal {
  const native = (request.raw as Partial<{ signal: AbortSignal }>).signal;
  if (native !== undefined) return native;
  const controller = new AbortController();
  const raw = reply.raw;
  raw.once('close', () => { if (!raw.writableEnded) controller.abort(); });
  return controller.signal;
}

export function registerRunRoutes(app: FastifyInstance, deps: RunRouteDeps): void {
  app.post('/runs', async (request, reply) => {
    const body = parseWith(runAgentBodySchema, request.body);
    const signal = clientAbortSignal(request, reply);
    let run;
    if ('agent' in body) {
      const version = parseVersion(body.agent.version);
      run = await deps.runAgentPreview.executeSaved({
        scope: body.scope,
        agentId: body.agent.internalId,
        ...(version !== undefined ? { version } : {}),
        message: body.message,
        mode: body.mode,
        ...(body.images !== undefined ? { images: body.images } : {}),
        ...(body.memoryPageIds !== undefined ? { memoryPageIds: body.memoryPageIds } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
        ...(body.history !== undefined ? { history: body.history } : {}),
        // 対話相手（人間）がいる唯一の入口。toolApproval の承認ゲートはここからの実行だけで発火する。
        interactive: true,
      }, signal);
    } else {
      const version = parseVersion(body.tool.version);
      run = await deps.runAgentPreview.execute({
        scope: body.scope,
        toolId: body.tool.internalId,
        ...(version !== undefined ? { version } : {}),
        systemPrompt: body.systemPrompt,
        message: body.message,
        mode: body.mode,
        ...(body.images !== undefined ? { images: body.images } : {}),
        ...(body.sessionId !== undefined ? { sessionId: body.sessionId } : {}),
      }, signal);
    }
    return { run };
  });

  /**
   * 承認待ちで停止したRunを、人間の承認結果とともに同じrunIdで再開する。
   * 応答は POST /runs と同じ形（再開後に別のツールで再び waiting-approval になることもある）。
   */
  app.post<{ Params: { runId: string } }>('/runs/:runId/resume', async (request, reply) => {
    const body = parseWith(resumeRunBodySchema, request.body);
    const run = await deps.runAgentPreview.resumeSavedRun({
      scope: body.scope,
      runId: request.params.runId,
      decision: body.decision,
      ...(body.feedback !== undefined ? { feedback: body.feedback } : {}),
    }, clientAbortSignal(request, reply));
    return { run };
  });

  app.get('/runs', async (request) => {
    const query = parseWith(runListQuerySchema, request.query);
    const scope = { tenantId: query.tenantId, workspaceId: query.workspaceId };
    const records = await deps.queryRuns.list(scope, {
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
    });
    return { runs: records.map((record) => ({
      runId: record.runId, sessionId: record.sessionId, status: record.status, mode: record.mode, purpose: record.purpose, model: record.model, tool: record.tool, tools: record.tools, agent: record.agent,
      startedAt: record.startedAt, completedAt: record.completedAt,
      response: record.response, failure: record.failure, usage: record.usage, latency: record.latency, estimatedCost: record.estimatedCost,
      checkpoint: checkpointSummary(record.checkpoint),
      traceEventCount: record.trace.length,
    })) };
  });

  app.get<{ Params: { runId: string } }>('/runs/:runId/trace', async (request) => {
    const query = parseWith(runTraceQuerySchema, request.query);
    const run = await deps.queryRuns.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.runId);
    return { run: runView(run) };
  });
}
