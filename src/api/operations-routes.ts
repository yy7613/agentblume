import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CreateBackupUseCase, ListBackupsUseCase } from '../application/operations/backup';
import type { SubmitRunFeedbackUseCase, QueryRunFeedbackUseCase } from '../application/operations/feedback';
import type { QueryOperationsStatusUseCase } from '../application/operations/query-operations-status';
import type { RetentionUseCase } from '../application/operations/retention';
import { MAX_AUDIT_PAGE_SIZE, type QueryAuditLogUseCase } from '../application/security/audit';
import { AUDIT_OUTCOMES } from '../domain/security/audit';
import { AUTHORIZATION_ACTIONS, AUTHORIZATION_RESOURCE_KINDS } from '../domain/security/authorization';
import { DEFAULT_RETENTION_DAYS, MINIMUM_AUDIT_RETENTION_DAYS } from '../domain/operations/operations';
import { scopeOf } from './authentication';
import { recordAuditDetail } from './authorization';
import { BadRequestError } from './error-mapping';

export interface OperationsRouteDeps {
  readonly submitRunFeedback: SubmitRunFeedbackUseCase;
  readonly queryRunFeedback: QueryRunFeedbackUseCase;
  readonly queryOperationsStatus: QueryOperationsStatusUseCase;
  readonly retention: RetentionUseCase;
  readonly createBackup: CreateBackupUseCase;
  readonly listBackups: ListBackupsUseCase;
  readonly queryAuditLog: QueryAuditLogUseCase;
}

// スコープは Principal から取るのでここでは形だけ受ける（値は読まない）。
const scopeSchema = z.object({ tenantId: z.string().min(1).optional(), workspaceId: z.string().min(1).optional() });
const scopeQuerySchema = scopeSchema;
const feedbackBodySchema = z.object({ scope: scopeSchema, thumb: z.enum(['up', 'down']), rating: z.number().int().min(1).max(5).optional(), comment: z.string().max(2000).optional(), issueTags: z.array(z.string().min(1).max(50)).max(10).default([]) });
const statusQuerySchema = scopeQuerySchema.extend({ days: z.coerce.number().int().min(1).max(365).default(30) });
/**
 * `auditDays` は後から足したので**省略を許す**（既定 365）。必須にすると、
 * 保持ポリシーを保存する既存クライアント（UI・スクリプト）が一斉に400になる。
 *
 * 下限が 0 ではなく `MINIMUM_AUDIT_RETENTION_DAYS` なのは、0 を許すと
 * 「変更 → 即適用」で**その変更を記録した監査行ごと**消せるため（理由はドメイン側のコメント）。
 */
const retentionBodySchema = z.object({ scope: scopeSchema, payloadDays: z.number().int().min(0).max(3650), traceDays: z.number().int().min(0).max(3650), aggregateDays: z.number().int().min(0).max(3650), auditDays: z.number().int().min(MINIMUM_AUDIT_RETENTION_DAYS, `auditDays は${MINIMUM_AUDIT_RETENTION_DAYS}日以上（短くすると変更の記録ごと消せてしまう）`).max(3650).default(DEFAULT_RETENTION_DAYS.audit) });
/** `GET /operations/audit` の絞り込み。すべて任意で、既定は「自分のスコープの直近100件」。 */
const auditQuerySchema = scopeQuerySchema.extend({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  subject: z.string().min(1).max(200).optional(),
  action: z.enum(AUTHORIZATION_ACTIONS).optional(),
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  resourceKind: z.enum(AUTHORIZATION_RESOURCE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_AUDIT_PAGE_SIZE).optional(),
});

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
  /**
   * 保持期限の変更。**変更後の値を監査 detail へ載せる**。
   *
   * 「誰かが operate に成功した」だけでは台帳の役に立たない。保持期限は
   * 「消えるまでの猶予」を決める設定なので、後から必ず「いつ誰が何日にしたのか」を問われる。
   */
  app.put('/operations/retention', async (request) => {
    const body = parse(retentionBodySchema, request.body);
    recordAuditDetail(request, { payloadDays: body.payloadDays, traceDays: body.traceDays, aggregateDays: body.aggregateDays, auditDays: body.auditDays });
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

  /**
   * 監査ログの参照。**Operator / Workspace Admin だけ**が読める
   * （`api/authorization.ts` の表で `audit-log:read` を要求している）。
   *
   * 監査ログは「誰が何をしたか」の一覧なので、全員に見せると人の行動追跡の道具になる。
   * 逆に運用担当が読めなければ台帳の意味が無い。§3.2 の `audit-log(read)` 行そのまま。
   */
  app.get('/operations/audit', async (request) => {
    const query = parse(auditQuerySchema, request.query);
    const entries = await deps.queryAuditLog.list(scopeOf(request), {
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.subject === undefined ? {} : { subject: query.subject }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.resourceKind === undefined ? {} : { resourceKind: query.resourceKind }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { entries };
  });
}

