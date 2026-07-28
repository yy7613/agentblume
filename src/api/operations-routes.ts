import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CreateBackupUseCase, ListBackupsUseCase } from '../application/operations/backup';
import type { SubmitRunFeedbackUseCase, QueryRunFeedbackUseCase } from '../application/operations/feedback';
import type { QueryOperationsStatusUseCase } from '../application/operations/query-operations-status';
import type { RetentionUseCase } from '../application/operations/retention';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';

export interface OperationsRouteDeps {
  readonly submitRunFeedback: SubmitRunFeedbackUseCase;
  readonly queryRunFeedback: QueryRunFeedbackUseCase;
  readonly queryOperationsStatus: QueryOperationsStatusUseCase;
  readonly retention: RetentionUseCase;
  readonly createBackup: CreateBackupUseCase;
  readonly listBackups: ListBackupsUseCase;
}

// スコープは Principal から取るのでここでは形だけ受ける（値は読まない）。
const scopeSchema = z.object({ tenantId: z.string().min(1).optional(), workspaceId: z.string().min(1).optional() });
const scopeQuerySchema = scopeSchema;
const feedbackBodySchema = z.object({ scope: scopeSchema, thumb: z.enum(['up', 'down']), rating: z.number().int().min(1).max(5).optional(), comment: z.string().max(2000).optional(), issueTags: z.array(z.string().min(1).max(50)).max(10).default([]) });
const statusQuerySchema = scopeQuerySchema.extend({ days: z.coerce.number().int().min(1).max(365).default(30) });
const retentionBodySchema = z.object({ scope: scopeSchema, payloadDays: z.number().int().min(0).max(3650), traceDays: z.number().int().min(0).max(3650), aggregateDays: z.number().int().min(0).max(3650) });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  return parsed.data as z.infer<S>;
}

export function registerOperationsRoutes(app: FastifyInstance, deps: OperationsRouteDeps): void {
  app.put<{ Params: { runId: string } }>('/runs/:runId/feedback', async (request) => {
    const body = parse(feedbackBodySchema, request.body);
    return { feedback: await deps.submitRunFeedback.execute({ ...body, scope: scopeOf(request), runId: request.params.runId }) };
  });
  app.get<{ Params: { runId: string } }>('/runs/:runId/feedback', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { feedback: await deps.queryRunFeedback.get(scopeOf(request), request.params.runId) };
  });
  app.get('/operations/status', async (request) => {
    const query = parse(statusQuerySchema, request.query);
    return { status: await deps.queryOperationsStatus.execute(scopeOf(request), query.days) };
  });
  app.get('/operations/retention', async (request) => {
    parse(scopeQuerySchema, request.query);
    return { policy: await deps.retention.get(scopeOf(request)) };
  });
  app.put('/operations/retention', async (request) => {
    const body = parse(retentionBodySchema, request.body);
    return { policy: await deps.retention.save({ ...body, scope: scopeOf(request) }) };
  });
  app.post('/operations/retention/apply', async (request) => {
    parse(z.object({ scope: scopeSchema }), request.body);
    return { result: await deps.retention.apply(scopeOf(request)) };
  });

  /**
   * バックアップの作成。**サーバーのファイルシステムへ書き、そのパスを返す**。
   *
   * ブラウザへのダウンロードにしなかった理由:
   * バックアップの実体は「DBファイル + アーティファクトのディレクトリ」の2つで、
   * 1本のレスポンスにするには zip/tar が要る（Nodeの標準ライブラリにアーカイバは無い）。
   * agentblume はローカル実行が前提で、サーバーのファイルシステム＝利用者のPCなので、
   * 保存先パスを返すほうが素直で、数GBのアーティファクトをメモリへ載せずに済む。
   * 別マシンへ持ち出すのは利用者がそのディレクトリをコピーする（docs/17-operations-runbook.md）。
   *
   * テナントスコープを取らないのは、バックアップの単位が**プロセスの保存先ファイル全体**であり、
   * 特定テナントのデータだけを切り出すものではないため（切り出しは evaluation dataset の export が担う）。
   */
  app.post('/operations/backups', async (request) => {
    const body = parse(z.object({ includeSecretKey: z.boolean().default(false) }), request.body ?? {});
    return { backup: await deps.createBackup.execute({ includeSecretKey: body.includeSecretKey }) };
  });
  app.get('/operations/backups', async () => ({ root: deps.listBackups.root(), backups: await deps.listBackups.execute() }));
}

