/**
 * api層: 経費精算「お金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）」のルート。
 *
 * `expense-routes.ts` の `registerExpenseRoutes` が呼び、`ExpenseRouteDeps` はこの deps を extends する（ADR-0039 と同じ登録点を業務の内側に置いた）。
 * 認可は `expense-money-authorization.ts` に全ルートを載せる（`authorization.test.ts` の網羅テストが検査する）。
 * 応答は Serialized から `tenant` を除いた形。口座番号はどの応答にも含めない。操作者は `expense-actor.ts` の `expenseActorOf`。
 * エラーの写像は骨格の `expense-error-mapping.ts` が持つので、ここは domain の例外をそのまま投げる。
 *
 * 振込データ（UC3）の作成・再ダウンロードは口座番号を含むファイルを返す（approve + 監査。応答の口座は伏せ字、ファイルは base64）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { DraftAdvanceJournalEntriesUseCase } from '../application/expense/money/advance-journal-drafts';
import type { ExpenseCardSettingsUseCase } from '../application/expense/money/card-settings';
import type { CardTransactionsUseCase } from '../application/expense/money/card-transactions';
import type { ImportCardStatementUseCase } from '../application/expense/money/import-card-statement';
import type { LinkClaimAdvanceUseCase, ManageExpenseAdvancesUseCase } from '../application/expense/money/manage-advances';
import type { ManagePayoutSettingsUseCase } from '../application/expense/money/manage-payout-settings';
import type { MatchCardTransactionsUseCase } from '../application/expense/money/match-card-transactions';
import type { GetExpenseMoneyReadinessUseCase } from '../application/expense/money/money-readiness';
import type { ExpensePayoutsUseCase } from '../application/expense/money/payouts';
import type { SettleExpenseAdvanceUseCase } from '../application/expense/money/settle-advance';
import type { SummarizeExpensesUseCase, SummaryQuery } from '../application/expense/money/summary';
import type { EmployeeDirectoryPort } from '../application/expense/ports';
import type { GetExpensePolicyUseCase } from '../application/expense/manage-policy';
import type { ExpenseAdvance } from '../domain/expense/advance';
import { approvalBlockers, claimTotalAmount, isJudgmentStale, reimbursableAmount, type ExpenseClaim } from '../domain/expense/claim';
import { parseSummaryGroupBy, parseSummaryStatuses } from '../domain/expense/money/summary';
import type { ExpensePolicy } from '../domain/expense/policy';
import { serializeExpenseClaim } from '../domain/expense/serialization';
import { principalOf, scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { expenseActorOf } from './expense-actor';
import {
  advanceJournalBodySchema, advanceListQuerySchema, advanceNoteBodySchema, advancePaymentBodySchema, advanceRefundBodySchema, approveAdvanceBodySchema,
  cardExcludeBodySchema, cardImportListQuerySchema, cardLinkBodySchema, cardMatchBodySchema, cardSettingsBodySchema, cardStatementImportBodySchema,
  cardStatementPreviewBodySchema, cardTransactionListQuerySchema, claimAdvanceBodySchema, createAdvanceBodySchema, moneyActionBodySchema,
  moneyScopeQuerySchema, payoutCancelBodySchema, payoutConfirmBodySchema, payoutCreateBodySchema, payoutListQuerySchema, payoutPreviewBodySchema,
  payoutSettingsBodySchema, summaryQuerySchema, updateAdvanceBodySchema,
} from './expense-money-schemas';

/** 使うユースケース（composition の `ExpenseMoneyFeature` が満たす）。 */
export interface ExpenseMoneyRouteDeps {
  readonly expenseMoneyReadiness: GetExpenseMoneyReadinessUseCase;
  readonly expenseAdvances: ManageExpenseAdvancesUseCase;
  readonly expenseLinkClaimAdvance: LinkClaimAdvanceUseCase;
  readonly expenseSettleAdvance: SettleExpenseAdvanceUseCase;
  readonly expenseAdvanceJournalDrafts: DraftAdvanceJournalEntriesUseCase;
  readonly expenseCardSettings: ExpenseCardSettingsUseCase;
  readonly expenseCardStatements: ImportCardStatementUseCase;
  readonly expenseCardMatching: MatchCardTransactionsUseCase;
  readonly expenseCardTransactions: CardTransactionsUseCase;
  readonly expenseSummary: SummarizeExpensesUseCase;
  readonly expensePayoutSettings: ManagePayoutSettingsUseCase;
  readonly expensePayouts: ExpensePayoutsUseCase;
  /** 申請の応答（支払う額・判定の古さ）に規程が要る（骨格の `ExpenseRouteDeps` と同じもの）。 */
  readonly getExpensePolicy: Pick<GetExpensePolicyUseCase, 'execute'>;
  /** 仮払の承認の操作者の従業員（省略 = 従業員に結ばない）。 */
  readonly expenseEmployeeDirectory?: EmployeeDirectoryPort;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

function withoutTenant<T extends { readonly tenant: unknown }>(value: T): Omit<T, 'tenant'> {
  const { tenant: _tenant, ...rest } = value;
  return rest;
}

/** 申請の応答（骨格の `expenseClaimResponse` と同じ形。承認の見通しは `GET /expense/claims/:id` で取り直す）。 */
export function moneyClaimResponse(claim: ExpenseClaim, policy: ExpensePolicy) {
  const rest = withoutTenant(serializeExpenseClaim(claim));
  return {
    ...rest,
    items: rest.items.map((item) => ({ ...item, hasReceipt: item.receiptId !== undefined })),
    totalAmount: claimTotalAmount(claim),
    reimbursableAmount: reimbursableAmount(claim, policy),
    stale: isJudgmentStale(claim, policy),
    approvalBlockers: claim.status === 'checked' ? approvalBlockers(claim, policy) : [],
  };
}

export function registerExpenseMoneyRoutes(app: FastifyInstance, deps: ExpenseMoneyRouteDeps): void {
  const by = (request: FastifyRequest): string => principalOf(request).subject;
  const advanceView = async (request: FastifyRequest, advance: ExpenseAdvance) => ({ advance: await deps.expenseAdvances.view(scopeOf(request), advance) });
  const summaryQuery = (query: z.infer<typeof summaryQuerySchema>): SummaryQuery => {
    try {
      return { from: query.from, to: query.to, groupBy: parseSummaryGroupBy(query.groupBy), statuses: parseSummaryStatuses(query.status), basis: query.basis ?? 'transaction' };
    } catch (error) {
      throw new BadRequestError(`invalid query: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  app.get('/expense/money-readiness', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return { readiness: await deps.expenseMoneyReadiness.execute(scopeOf(request)) };
  });

  /* 仮払（UC4） ------------------------------------------------------------ */

  app.get('/expense/advances', async (request) => {
    const query = parseWith(advanceListQuerySchema, request.query, 'invalid query');
    const advances = await deps.expenseAdvances.list(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.employeeId === undefined ? {} : { employeeId: query.employeeId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { advances };
  });

  app.post('/expense/advances', async (request) => {
    const body = parseWith(createAdvanceBodySchema, request.body, 'invalid body');
    const advance = await deps.expenseAdvances.create(scopeOf(request), {
      employeeId: body.employeeId, purpose: body.purpose, amount: body.amount, neededOn: body.neededOn, plannedSettleBy: body.plannedSettleBy,
    }, by(request));
    return advanceView(request, advance);
  });

  app.get<{ Params: { id: string } }>('/expense/advances/:id', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return deps.expenseAdvances.get(scopeOf(request), request.params.id);
  });

  app.put<{ Params: { id: string } }>('/expense/advances/:id', async (request) => {
    const body = parseWith(updateAdvanceBodySchema, request.body, 'invalid body');
    const advance = await deps.expenseAdvances.edit(scopeOf(request), request.params.id, { purpose: body.purpose, amount: body.amount, neededOn: body.neededOn, plannedSettleBy: body.plannedSettleBy }, by(request));
    return advanceView(request, advance);
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/approve', async (request) => {
    const body = parseWith(approveAdvanceBodySchema, request.body, 'invalid body');
    const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
    const advance = await deps.expenseAdvances.approve(scopeOf(request), request.params.id, { subject: actor.subject, ...(actor.employeeId === undefined ? {} : { employeeId: actor.employeeId }) }, body.comment);
    return advanceView(request, advance);
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/cancel', async (request) => {
    const body = parseWith(advanceNoteBodySchema, request.body, 'invalid body');
    return advanceView(request, await deps.expenseAdvances.cancel(scopeOf(request), request.params.id, body.note, by(request)));
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/mark-paid', async (request) => {
    const body = parseWith(advancePaymentBodySchema, request.body, 'invalid body');
    return advanceView(request, await deps.expenseAdvances.markPaid(scopeOf(request), request.params.id, { paidOn: body.paidOn, method: body.method }, by(request)));
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/unpay', async (request) => {
    const body = parseWith(advanceNoteBodySchema, request.body, 'invalid body');
    return advanceView(request, await deps.expenseAdvances.unpay(scopeOf(request), request.params.id, body.note, by(request)));
  });

  app.get<{ Params: { id: string } }>('/expense/advances/:id/settlement-preview', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return { preview: await deps.expenseSettleAdvance.preview(scopeOf(request), request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/settle', async (request) => {
    parseWith(moneyActionBodySchema, request.body, 'invalid body');
    const result = await deps.expenseSettleAdvance.settle(scopeOf(request), request.params.id, by(request));
    const { policy } = await deps.getExpensePolicy.execute(scopeOf(request));
    return { ...(await advanceView(request, result.advance)), claims: result.claims.map((claim) => moneyClaimResponse(claim, policy)) };
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/refund-received', async (request) => {
    const body = parseWith(advanceRefundBodySchema, request.body, 'invalid body');
    return advanceView(request, await deps.expenseAdvances.refundReceived(scopeOf(request), request.params.id, body.receivedOn, by(request)));
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/additional-paid', async (request) => {
    const body = parseWith(advancePaymentBodySchema, request.body, 'invalid body');
    return advanceView(request, await deps.expenseAdvances.additionalPaid(scopeOf(request), request.params.id, { paidOn: body.paidOn, method: body.method }, by(request)));
  });

  app.post<{ Params: { id: string } }>('/expense/advances/:id/journal-drafts', async (request) => {
    const body = parseWith(advanceJournalBodySchema, request.body, 'invalid body');
    const result = await deps.expenseAdvanceJournalDrafts.execute({ scope: scopeOf(request), advanceId: request.params.id, stage: body.stage, by: by(request) });
    return { ...(await advanceView(request, result.advance)), entryIds: result.entryIds, warnings: result.warnings };
  });

  app.put<{ Params: { id: string } }>('/expense/claims/:id/advance', async (request) => {
    const body = parseWith(claimAdvanceBodySchema, request.body, 'invalid body');
    const claim = await deps.expenseLinkClaimAdvance.execute({ scope: scopeOf(request), claimId: request.params.id, advanceId: body.advanceId, by: by(request) });
    const { policy } = await deps.getExpensePolicy.execute(scopeOf(request));
    return { claim: moneyClaimResponse(claim, policy) };
  });

  /* 法人カード（UC5） ------------------------------------------------------ */

  app.get('/expense/card-settings', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return deps.expenseCardSettings.get(scopeOf(request));
  });

  app.put('/expense/card-settings', async (request) => {
    const body = parseWith(cardSettingsBodySchema, request.body, 'invalid body');
    return { settings: await deps.expenseCardSettings.save(scopeOf(request), { cards: body.cards, profiles: body.profiles }) };
  });

  app.post('/expense/card-statements/preview', async (request) => {
    const body = parseWith(cardStatementPreviewBodySchema, request.body, 'invalid body');
    const result = await deps.expenseCardStatements.preview(scopeOf(request), {
      content: body.content,
      ...(body.profileId === undefined ? {} : { profileId: body.profileId }),
      ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
      ...(body.cardId === undefined ? {} : { cardId: body.cardId }),
    });
    return { result };
  });

  app.post('/expense/card-statements', async (request) => {
    const body = parseWith(cardStatementImportBodySchema, request.body, 'invalid body');
    const result = await deps.expenseCardStatements.import(scopeOf(request), {
      content: body.content, fileName: body.fileName,
      ...(body.profileId === undefined ? {} : { profileId: body.profileId }),
      ...(body.mapping === undefined ? {} : { mapping: body.mapping }),
      ...(body.cardId === undefined ? {} : { cardId: body.cardId }),
      ...(body.saveProfileAs === undefined ? {} : { saveProfileAs: body.saveProfileAs }),
    }, by(request));
    return { result };
  });

  app.get('/expense/card-statements', async (request) => {
    const query = parseWith(cardImportListQuerySchema, request.query, 'invalid query');
    return { imports: (await deps.expenseCardStatements.listImports(scopeOf(request), query.limit)).map(withoutTenant) };
  });

  app.delete<{ Params: { id: string } }>('/expense/card-statements/:id', async (request, reply) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    await deps.expenseCardStatements.deleteImport(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.get('/expense/card-transactions', async (request) => {
    const query = parseWith(cardTransactionListQuerySchema, request.query, 'invalid query');
    const transactions = await deps.expenseCardTransactions.list(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.cardId === undefined ? {} : { cardId: query.cardId }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
      ...(query.claimId === undefined ? {} : { claimId: query.claimId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { transactions };
  });

  app.post('/expense/card-transactions/match', async (request) => {
    const body = parseWith(cardMatchBodySchema, request.body, 'invalid body');
    if (body.from !== undefined && body.to !== undefined && body.from > body.to) throw new BadRequestError('invalid body: from must not be after to');
    const result = await deps.expenseCardMatching.execute(scopeOf(request), { ...(body.from === undefined ? {} : { from: body.from }), ...(body.to === undefined ? {} : { to: body.to }) }, by(request));
    return { result };
  });

  app.post<{ Params: { id: string } }>('/expense/card-transactions/:id/exclude', async (request) => {
    const body = parseWith(cardExcludeBodySchema, request.body, 'invalid body');
    return { transaction: await deps.expenseCardTransactions.exclude(scopeOf(request), request.params.id, body.reason, by(request)) };
  });

  app.post<{ Params: { id: string } }>('/expense/card-transactions/:id/include', async (request) => {
    parseWith(moneyActionBodySchema, request.body, 'invalid body');
    return { transaction: await deps.expenseCardTransactions.include(scopeOf(request), request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/expense/card-transactions/:id/link', async (request) => {
    const body = parseWith(cardLinkBodySchema, request.body, 'invalid body');
    return { transaction: await deps.expenseCardTransactions.link(scopeOf(request), request.params.id, { claimId: body.claimId, itemId: body.itemId }, by(request)) };
  });

  app.post<{ Params: { id: string } }>('/expense/card-transactions/:id/unlink', async (request) => {
    parseWith(moneyActionBodySchema, request.body, 'invalid body');
    return { transaction: await deps.expenseCardTransactions.unlink(scopeOf(request), request.params.id) };
  });

  /* 振込データ（UC3） ---------------------------------------------------- */

  app.get('/expense/payout-settings', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return deps.expensePayoutSettings.get(scopeOf(request));
  });

  app.put('/expense/payout-settings', async (request) => {
    const body = parseWith(payoutSettingsBodySchema, request.body, 'invalid body');
    const { scope: _scope, ...input } = body;
    return { settings: await deps.expensePayoutSettings.save(scopeOf(request), input as Parameters<ManagePayoutSettingsUseCase['save']>[1]) };
  });

  const payoutRequest = (body: z.infer<typeof payoutPreviewBodySchema>) => ({
    transferDate: body.transferDate,
    ...(body.claimIds === undefined ? {} : { claimIds: body.claimIds }),
    ...(body.advanceIds === undefined ? {} : { advanceIds: body.advanceIds }),
  });

  app.post('/expense/payouts/preview', async (request) => {
    const body = parseWith(payoutPreviewBodySchema, request.body, 'invalid body');
    return { result: await deps.expensePayouts.preview(scopeOf(request), payoutRequest(body)) };
  });

  app.post('/expense/payouts', async (request) => {
    const body = parseWith(payoutCreateBodySchema, request.body, 'invalid body');
    return deps.expensePayouts.create(scopeOf(request), { ...payoutRequest(body), acknowledgedWarnings: body.acknowledgedWarnings }, by(request));
  });

  app.get('/expense/payouts', async (request) => {
    const query = parseWith(payoutListQuerySchema, request.query, 'invalid query');
    return { batches: await deps.expensePayouts.list(scopeOf(request), { ...(query.status === undefined ? {} : { status: query.status }), ...(query.limit === undefined ? {} : { limit: query.limit }) }) };
  });

  app.get<{ Params: { id: string } }>('/expense/payouts/:id/file', async (request) => {
    parseWith(moneyScopeQuerySchema, request.query, 'invalid query');
    return { file: await deps.expensePayouts.file(scopeOf(request), request.params.id) };
  });

  app.post<{ Params: { id: string } }>('/expense/payouts/:id/confirm', async (request) => {
    parseWith(payoutConfirmBodySchema, request.body, 'invalid body');
    const result = await deps.expensePayouts.confirm(scopeOf(request), request.params.id, by(request));
    const { policy } = await deps.getExpensePolicy.execute(scopeOf(request));
    return {
      batch: result.batch,
      claims: result.claims.map((claim) => moneyClaimResponse(claim, policy)),
      advances: await Promise.all(result.advances.map((advance) => deps.expenseAdvances.view(scopeOf(request), advance))),
      warnings: result.warnings,
    };
  });

  app.post<{ Params: { id: string } }>('/expense/payouts/:id/cancel', async (request) => {
    const body = parseWith(payoutCancelBodySchema, request.body, 'invalid body');
    return { batch: await deps.expensePayouts.cancel(scopeOf(request), request.params.id, body.note, by(request)) };
  });

  /* 集計（UC6） ------------------------------------------------------------ */

  app.get('/expense/summary', async (request) => {
    const query = parseWith(summaryQuerySchema, request.query, 'invalid query');
    return { result: await deps.expenseSummary.execute(scopeOf(request), summaryQuery(query)) };
  });

  app.get('/expense/summary/export', async (request) => {
    const query = parseWith(summaryQuerySchema, request.query, 'invalid query');
    return deps.expenseSummary.export(scopeOf(request), summaryQuery(query));
  });
}
