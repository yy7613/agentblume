/**
 * api層: 経費精算（expense）のルート（docs/21-expense.md §10 / §20.9）。
 *
 * 応答の申請・規程は Serialized から `tenant` を除いた形（仕訳と同じ。scope は Principal 由来）。
 * 申請の応答には証憑本体（data URL）を含めず、明細ごとの `hasReceipt` と、画面が「承認できない理由」を並べるための
 * `stale` / `approvalBlockers`（見ている人が承認する前提）/ `approvalPlan`（承認経路の見通し）/ `reimbursableAmount` を足す。
 * 読取（`/expense/receipts/extract`）はモデルを回すので遅い。`clientAbortSignal` を通し、切断でモデル呼び出しごと止める。
 *
 * 実用化の 3 系統（A 人と承認 / B お金の流れ / C 入力と規程）のルートは系統のファイルが持ち、ここで登録する
 * （ADR-0039 の登録点を業務の内側に置いた。`server.ts` は `registerExpenseRoutes` を呼ぶだけのまま）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { ExpenseCapabilities, ExpenseCapabilitiesUseCase } from '../application/expense/capabilities';
import type { CheckExpenseClaimsUseCase } from '../application/expense/check-claims';
import type { DraftJournalEntriesUseCase } from '../application/expense/draft-journal-entries';
import type { ExportExpenseSettlementUseCase, SettleExpenseClaimsUseCase } from '../application/expense/export-settlement';
import type { ExtractReceiptUseCase } from '../application/expense/extract-receipt';
import type { ImportExpenseCsvUseCase } from '../application/expense/import-csv';
import type {
  CreateExpenseClaimUseCase, DeleteExpenseClaimUseCase, DeleteExpenseItemUseCase, GetExpenseClaimUseCase, GetExpenseReceiptUseCase,
  ListExpenseClaimsUseCase, SaveExpenseItemUseCase, UpdateExpenseClaimUseCase,
} from '../application/expense/manage-claims';
import type { GetExpensePolicyUseCase, ResetExpensePolicyUseCase, SaveExpensePolicyUseCase } from '../application/expense/manage-policy';
import type { ExportExpensePolicyCsvUseCase, ImportExpensePolicyCsvUseCase } from '../application/expense/policy-transfer';
import type { EmployeeDirectoryPort } from '../application/expense/ports';
import type {
  AcknowledgeExpenseReasonUseCase, ApproveExpenseClaimUseCase, DescribeExpenseApprovalUseCase, ExpenseApprovalDescription, GetReturnDraftUseCase,
  ReturnExpenseClaimUseCase, UnapproveExpenseClaimUseCase,
} from '../application/expense/review-claims';
import { approvalBlockers, claimTotalAmount, isJudgmentStale, reimbursableAmount, type ClaimStatus, type ExpenseClaim } from '../domain/expense/claim';
import type { ExpensePolicy } from '../domain/expense/policy';
import type { ExpenseClaimListOptions } from '../domain/expense/repositories';
import { serializeExpenseClaim } from '../domain/expense/serialization';
import { principalOf, scopeOf } from './authentication';
import { clientAbortSignal } from './client-abort';
import { BadRequestError } from './error-mapping';
import { expenseActorOf } from './expense-actor';
import { registerExpenseInputRoutes, type ExpenseInputRouteDeps } from './expense-input-routes';
import { registerExpenseMoneyRoutes, type ExpenseMoneyRouteDeps } from './expense-money-routes';
import { registerExpensePeopleRoutes, type ExpensePeopleRouteDeps } from './expense-people-routes';
import {
  acknowledgeExpenseReasonBodySchema, approveExpenseClaimBodySchema, checkExpenseClaimsBodySchema, expenseActionBodySchema,
  expenseClaimListQuerySchema, expenseExportQuerySchema, expensePolicyImportBodySchema, expenseScopeQuerySchema,
  extractExpenseReceiptBodySchema, importExpenseCsvBodySchema, returnExpenseClaimBodySchema, saveExpenseClaimBodySchema,
  saveExpenseItemBodySchema, saveExpensePolicyBodySchema, settleExpenseClaimsBodySchema, unapproveExpenseClaimBodySchema,
} from './expense-schemas';

export interface ExpenseRouteDeps extends ExpensePeopleRouteDeps, ExpenseMoneyRouteDeps, ExpenseInputRouteDeps {
  readonly getExpensePolicy: GetExpensePolicyUseCase;
  readonly saveExpensePolicy: SaveExpensePolicyUseCase;
  readonly resetExpensePolicy: ResetExpensePolicyUseCase;
  readonly exportExpensePolicyCsv: ExportExpensePolicyCsvUseCase;
  readonly importExpensePolicyCsv: ImportExpensePolicyCsvUseCase;
  readonly listExpenseClaims: ListExpenseClaimsUseCase;
  readonly createExpenseClaim: CreateExpenseClaimUseCase;
  readonly getExpenseClaim: GetExpenseClaimUseCase;
  readonly updateExpenseClaim: UpdateExpenseClaimUseCase;
  readonly deleteExpenseClaim: DeleteExpenseClaimUseCase;
  readonly saveExpenseItem: SaveExpenseItemUseCase;
  readonly deleteExpenseItem: DeleteExpenseItemUseCase;
  readonly getExpenseReceipt: GetExpenseReceiptUseCase;
  readonly importExpenseCsv: ImportExpenseCsvUseCase;
  readonly extractExpenseReceipt: ExtractReceiptUseCase;
  readonly checkExpenseClaims: CheckExpenseClaimsUseCase;
  readonly acknowledgeExpenseReason: AcknowledgeExpenseReasonUseCase;
  readonly getExpenseReturnDraft: GetReturnDraftUseCase;
  readonly returnExpenseClaim: ReturnExpenseClaimUseCase;
  readonly approveExpenseClaim: ApproveExpenseClaimUseCase;
  readonly unapproveExpenseClaim: UnapproveExpenseClaimUseCase;
  readonly describeExpenseApproval: DescribeExpenseApprovalUseCase;
  readonly draftExpenseJournalEntries: DraftJournalEntriesUseCase;
  readonly exportExpenseSettlement: ExportExpenseSettlementUseCase;
  readonly settleExpenseClaims: SettleExpenseClaimsUseCase;
  /** 操作者の従業員を引く（省略 = 従業員に結ばない。テストの配線）。 */
  readonly expenseEmployeeDirectory?: EmployeeDirectoryPort;
}

/** `GET /runtime/capabilities` の `expense` に要る依存。 */
export interface ExpenseRuntimeCapabilityDeps {
  readonly expenseCapabilities: ExpenseCapabilitiesUseCase;
}

/** `GET /runtime/capabilities` へ足すキー（`expense` だけを返す）。 */
export async function expenseRuntimeCapabilities(deps: ExpenseRuntimeCapabilityDeps): Promise<{ readonly expense: ExpenseCapabilities }> {
  return { expense: await deps.expenseCapabilities.execute() };
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

/**
 * API 応答用の申請（scope 抜き・証憑本体なし・判定の古さと承認の見通しつき）。
 * `approval` を渡さないときは MVP と同じく、`checked` の申請にだけ判定由来の拒否理由を付ける。
 */
export function expenseClaimResponse(claim: ExpenseClaim, policy: ExpensePolicy, approval?: ExpenseApprovalDescription | string) {
  const { tenant: _tenant, ...rest } = serializeExpenseClaim(claim);
  const described = typeof approval === 'object' ? approval : undefined;
  const viewer = typeof approval === 'string' ? approval : undefined;
  return {
    ...rest,
    items: rest.items.map((item) => ({ ...item, hasReceipt: item.receiptId !== undefined })),
    totalAmount: claimTotalAmount(claim),
    reimbursableAmount: reimbursableAmount(claim, policy),
    stale: isJudgmentStale(claim, policy),
    approvalBlockers: described?.blockers ?? (claim.status === 'checked' ? approvalBlockers(claim, policy, viewer) : []),
    ...(described?.plan === undefined ? {} : { approvalPlan: described.plan }),
  };
}

const AWAITING_STATUSES: readonly ClaimStatus[] = ['checked', 'in-approval'];

export function registerExpenseRoutes(app: FastifyInstance, deps: ExpenseRouteDeps): void {
  const policyOf = async (request: FastifyRequest): Promise<ExpensePolicy> => (await deps.getExpensePolicy.execute(scopeOf(request))).policy;
  const respond = async (request: FastifyRequest, claim: ExpenseClaim) => {
    const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
    const [policy, approval] = await Promise.all([policyOf(request), deps.describeExpenseApproval.execute(scopeOf(request), claim, actor)]);
    return { claim: expenseClaimResponse(claim, policy, approval) };
  };

  /* 規程 ------------------------------------------------------------------ */

  app.get('/expense/policy', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    // saved は「保存済みか初期テンプレートのままか」。未保存でも書き込まない。
    return deps.getExpensePolicy.execute(scopeOf(request));
  });

  app.put('/expense/policy', async (request) => {
    const body = parseWith(saveExpensePolicyBodySchema, request.body, 'invalid body');
    const policy = await deps.saveExpensePolicy.execute({
      scope: scopeOf(request), categories: body.categories as Parameters<SaveExpensePolicyUseCase['execute']>[0]['categories'], claimRules: body.claimRules, preApprovalRules: body.preApprovalRules,
      severityOverrides: body.severityOverrides, journal: body.journal,
      // 実用化の節は省略したら現在の値を保つ（系統ごとの画面の部品が別々に持つため。SaveExpensePolicyUseCase）。
      ...(body.approval === undefined ? {} : { approval: body.approval }),
      ...(body.transport === undefined ? {} : { transport: body.transport as never }),
      ...(body.card === undefined ? {} : { card: body.card as never }),
      ...(body.advance === undefined ? {} : { advance: body.advance as never }),
    });
    return { policy };
  });

  app.post('/expense/policy/reset', async (request) => {
    parseWith(expenseActionBodySchema, request.body, 'invalid body');
    return { policy: await deps.resetExpensePolicy.execute(scopeOf(request)) };
  });

  app.get('/expense/policy/export', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    return deps.exportExpensePolicyCsv.execute(scopeOf(request));
  });

  app.post('/expense/policy/import', async (request) => {
    const body = parseWith(expensePolicyImportBodySchema, request.body, 'invalid body');
    return { policy: await deps.importExpensePolicyCsv.execute({ scope: scopeOf(request), content: body.content }) };
  });

  /* 申請 ------------------------------------------------------------------ */

  app.get('/expense/claims', async (request) => {
    const query = parseWith(expenseClaimListQuerySchema, request.query, 'invalid query');
    let awaiting: Pick<ExpenseClaimListOptions, 'statuses' | 'awaitingEmployeeId'> = {};
    if (query.awaiting === 'me') {
      const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
      // 単一ユーザーはどの段も代理で押せるので承認待ちの全件。従業員に結ばれていない主体には指定の承認待ちが無い。
      if (!actor.singleUser && actor.employeeId === undefined) return { claims: [] };
      awaiting = { statuses: AWAITING_STATUSES, ...(actor.singleUser || actor.employeeId === undefined ? {} : { awaitingEmployeeId: actor.employeeId }) };
    }
    const claims = await deps.listExpenseClaims.execute(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.verdict === undefined ? {} : { verdict: query.verdict }),
      ...(query.claimant === undefined ? {} : { claimant: query.claimant }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.employeeId === undefined ? {} : { employeeId: query.employeeId }),
      ...(query.departmentId === undefined ? {} : { departmentId: query.departmentId }),
      ...(query.advanceId === undefined ? {} : { advanceId: query.advanceId }),
      ...(query.unlinked === 'true' ? { unlinked: true } : {}),
      ...awaiting,
    });
    return { claims };
  });

  // 静的パスを :id より先に登録する（Fastify のルータは静的を優先するが、意図を並びでも示す）。
  app.post('/expense/claims/import-csv', async (request) => {
    const body = parseWith(importExpenseCsvBodySchema, request.body, 'invalid body');
    const result = await deps.importExpenseCsv.execute({
      scope: scopeOf(request), content: body.content, period: body.period, by: principalOf(request).subject,
      ...(body.claimId === undefined ? {} : { claimId: body.claimId }),
      ...(body.fileName === undefined ? {} : { fileName: body.fileName }),
    });
    return { result };
  });

  app.post('/expense/claims/check', async (request) => {
    const body = parseWith(checkExpenseClaimsBodySchema, request.body, 'invalid body');
    const result = await deps.checkExpenseClaims.execute({ scope: scopeOf(request), by: principalOf(request).subject, ...(body.claimIds === undefined ? {} : { claimIds: body.claimIds }) });
    return { result };
  });

  app.post('/expense/claims/settle', async (request) => {
    const body = parseWith(settleExpenseClaimsBodySchema, request.body, 'invalid body');
    const claims = await deps.settleExpenseClaims.execute({
      scope: scopeOf(request), claimIds: body.claimIds, by: principalOf(request).subject,
      ...(body.exportFileName === undefined ? {} : { exportFileName: body.exportFileName }),
    });
    const policy = await policyOf(request);
    return { claims: claims.map((claim) => expenseClaimResponse(claim, policy)) };
  });

  app.post('/expense/claims', async (request) => {
    const body = parseWith(saveExpenseClaimBodySchema, request.body, 'invalid body');
    const claim = await deps.createExpenseClaim.execute({ scope: scopeOf(request), claimant: body.claimant, period: body.period, by: principalOf(request).subject, ...(body.title === undefined ? {} : { title: body.title }) });
    return respond(request, claim);
  });

  app.get<{ Params: { id: string } }>('/expense/claims/:id', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    return respond(request, await deps.getExpenseClaim.execute(scopeOf(request), request.params.id));
  });

  app.put<{ Params: { id: string } }>('/expense/claims/:id', async (request) => {
    const body = parseWith(saveExpenseClaimBodySchema, request.body, 'invalid body');
    const claim = await deps.updateExpenseClaim.execute({ scope: scopeOf(request), id: request.params.id, claimant: body.claimant, period: body.period, by: principalOf(request).subject, ...(body.title === undefined ? {} : { title: body.title }) });
    return respond(request, claim);
  });

  app.delete<{ Params: { id: string } }>('/expense/claims/:id', async (request, reply) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    await deps.deleteExpenseClaim.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/expense/claims/:id/items', async (request) => {
    const body = parseWith(saveExpenseItemBodySchema, request.body, 'invalid body');
    const claim = await deps.saveExpenseItem.execute({
      scope: scopeOf(request), claimId: request.params.id, by: principalOf(request).subject,
      facts: body.facts, source: body.source,
      ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
      ...(body.categoryId === undefined ? {} : { categoryId: body.categoryId }),
      ...(body.categoryText === undefined ? {} : { categoryText: body.categoryText }),
      ...(body.extraction === undefined ? {} : { extraction: body.extraction }),
      ...(body.receipt === undefined ? {} : { receipt: body.receipt }),
    });
    return respond(request, claim);
  });

  app.delete<{ Params: { id: string; itemId: string } }>('/expense/claims/:id/items/:itemId', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    const claim = await deps.deleteExpenseItem.execute({ scope: scopeOf(request), claimId: request.params.id, itemId: request.params.itemId, by: principalOf(request).subject });
    return respond(request, claim);
  });

  app.get<{ Params: { id: string; itemId: string } }>('/expense/claims/:id/items/:itemId/receipt', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    const receipt = await deps.getExpenseReceipt.execute(scopeOf(request), request.params.id, request.params.itemId);
    return { receipt: { dataUrl: receipt.source.dataUrl, ...(receipt.source.fileName === undefined ? {} : { fileName: receipt.source.fileName }), ...(receipt.source.text === undefined ? {} : { text: receipt.source.text }) } };
  });

  /**
   * 画像 / PDF → 明細の下書き。**保存しない**。モデル未設定・vision 非対応は 409 `JOURNAL_EXTRACTION_UNAVAILABLE`、
   * 追加読取（`detail: true`）が使えなければ 409 `EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE`。
   */
  app.post('/expense/receipts/extract', async (request, reply) => {
    const body = parseWith(extractExpenseReceiptBodySchema, request.body, 'invalid body');
    const result = await deps.extractExpenseReceipt.execute({
      scope: scopeOf(request), images: body.images,
      ...(body.text === undefined ? {} : { text: body.text }),
      ...(body.fileName === undefined ? {} : { fileName: body.fileName }),
      ...(body.detail === undefined ? {} : { detail: body.detail }),
    }, clientAbortSignal(request, reply));
    return { result };
  });

  /* 確認・差し戻し・承認 -------------------------------------------------- */

  app.post<{ Params: { id: string } }>('/expense/claims/:id/acknowledge', async (request) => {
    const body = parseWith(acknowledgeExpenseReasonBodySchema, request.body, 'invalid body');
    const claim = await deps.acknowledgeExpenseReason.execute({ scope: scopeOf(request), claimId: request.params.id, code: body.code, note: body.note, by: principalOf(request).subject, ...(body.itemId === undefined ? {} : { itemId: body.itemId }) });
    return respond(request, claim);
  });

  app.get<{ Params: { id: string } }>('/expense/claims/:id/return-draft', async (request) => {
    parseWith(expenseScopeQuerySchema, request.query, 'invalid query');
    return { message: await deps.getExpenseReturnDraft.execute(scopeOf(request), request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/expense/claims/:id/return', async (request) => {
    const body = parseWith(returnExpenseClaimBodySchema, request.body, 'invalid body');
    return respond(request, await deps.returnExpenseClaim.execute({ scope: scopeOf(request), claimId: request.params.id, message: body.message, by: principalOf(request).subject }));
  });

  /** `in-approval` の段を進める。代理承認はコメント必須（§20.2.12）。 */
  app.post<{ Params: { id: string } }>('/expense/claims/:id/approve', async (request) => {
    const body = parseWith(approveExpenseClaimBodySchema, request.body, 'invalid body');
    const principal = principalOf(request);
    const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
    const claim = await deps.approveExpenseClaim.execute({
      scope: scopeOf(request), claimId: request.params.id, by: principal.subject, actor,
      ...(principal.displayName === undefined ? {} : { displayName: principal.displayName }),
      ...(body.comment === undefined ? {} : { comment: body.comment }),
      ...(body.stepId === undefined ? {} : { stepId: body.stepId }),
    });
    return respond(request, claim);
  });

  app.post<{ Params: { id: string } }>('/expense/claims/:id/unapprove', async (request) => {
    const body = parseWith(unapproveExpenseClaimBodySchema, request.body, 'invalid body');
    return respond(request, await deps.unapproveExpenseClaim.execute({ scope: scopeOf(request), claimId: request.params.id, note: body.note, by: principalOf(request).subject }));
  });

  /* 出力 ------------------------------------------------------------------ */

  app.post<{ Params: { id: string } }>('/expense/claims/:id/journal-drafts', async (request) => {
    parseWith(expenseActionBodySchema, request.body, 'invalid body');
    const result = await deps.draftExpenseJournalEntries.execute({ scope: scopeOf(request), claimId: request.params.id, by: principalOf(request).subject });
    return { claim: expenseClaimResponse(result.claim, await policyOf(request)), entryIds: result.entryIds, warnings: result.warnings };
  });

  app.get('/expense/export', async (request) => {
    const query = parseWith(expenseExportQuerySchema, request.query, 'invalid query');
    const result = await deps.exportExpenseSettlement.execute({
      scope: scopeOf(request), format: query.format,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });
    return { result };
  });

  /* 実用化の 3 系統（docs/21 §20.9.2〜4） ---------------------------------- */

  registerExpensePeopleRoutes(app, deps);
  registerExpenseMoneyRoutes(app, deps);
  registerExpenseInputRoutes(app, deps);
}
