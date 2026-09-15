/**
 * api層: 入金消込（receivables）のルート（docs/22-receivables.md §7）。
 *
 * 応答の集約は永続化用の Serialized から `tenant` を除いた形（scope は Principal 由来で、返す意味が無い）。
 * 明細の一覧は取込元の生の行（`source.row`）を含む（取込結果の画面で「どの行か」を見せるため）。
 * 発行・消込の確定と取消は仕訳の下書きも動かすので、確定済みで変えられなかった仕訳は `journalFollowUp` で返し、
 * 画面は「仕訳画面で確認してください」と仕訳を開くボタンを出す。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { ReceivablesCapabilities, ReceivablesCapabilitiesUseCase } from '../application/receivables/capabilities';
import type { ImportBankCsvUseCase, PreviewBankCsvUseCase } from '../application/receivables/import-bank-csv';
import type { JudgeTransactionsUseCase, MatchCandidatesUseCase } from '../application/receivables/judge-transactions';
import type { DeleteBankCsvProfileUseCase, ListBankCsvProfilesUseCase, SaveBankCsvProfileUseCase } from '../application/receivables/manage-bank-csv-profiles';
import type { DeleteCustomerUseCase, GetCustomerUseCase, ListCustomersUseCase, SaveCustomerUseCase } from '../application/receivables/manage-customers';
import type {
  CheckInvoiceUseCase, CreateInvoiceDraftUseCase, DeleteInvoiceDraftUseCase, DuplicateInvoiceUseCase, GetInvoiceUseCase,
  IssueInvoiceUseCase, ListInvoicesUseCase, UpdateInvoiceDraftUseCase, VoidInvoiceUseCase,
} from '../application/receivables/manage-invoices';
import type {
  CancelMatchingUseCase, ConfirmDecidedMatchingsUseCase, ConfirmMatchingUseCase, DeleteBankTransactionUseCase, IgnoreTransactionUseCase,
  ListBankTransactionsUseCase, ListMatchingsUseCase, UnignoreTransactionUseCase,
} from '../application/receivables/manage-matchings';
import type { GetReceivablesSettingsUseCase, SaveReceivablesSettingsUseCase } from '../application/receivables/manage-settings';
import type { BankCsvProfile } from '../domain/receivables/bank-csv-profile';
import type { BankTransaction } from '../domain/receivables/bank-transaction';
import type { Customer } from '../domain/receivables/customer';
import type { Invoice, InvoiceContent } from '../domain/receivables/invoice';
import type { Matching } from '../domain/receivables/matching-aggregate';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import {
  cancelReceivablesMatchingBodySchema, confirmReceivablesMatchingBodySchema, ignoreReceivablesTransactionBodySchema, judgeReceivablesBodySchema,
  receivablesActionBodySchema, receivablesBankCsvImportBodySchema, receivablesBankCsvReadBodySchema, receivablesBankTransactionListQuerySchema,
  receivablesCandidatesQuerySchema, receivablesCustomerListQuerySchema, receivablesInvoiceListQuerySchema, receivablesMatchingListQuerySchema,
  receivablesScopeQuerySchema, saveReceivablesBankCsvProfileBodySchema, saveReceivablesCustomerBodySchema, saveReceivablesInvoiceBodySchema,
  saveReceivablesSettingsBodySchema, voidReceivablesInvoiceBodySchema,
} from './receivables-schemas';

export interface ReceivablesRouteDeps {
  readonly getReceivablesSettings: GetReceivablesSettingsUseCase;
  readonly saveReceivablesSettings: SaveReceivablesSettingsUseCase;
  readonly listReceivablesCustomers: ListCustomersUseCase;
  readonly getReceivablesCustomer: GetCustomerUseCase;
  readonly saveReceivablesCustomer: SaveCustomerUseCase;
  readonly deleteReceivablesCustomer: DeleteCustomerUseCase;
  readonly checkReceivablesInvoice: CheckInvoiceUseCase;
  readonly createReceivablesInvoice: CreateInvoiceDraftUseCase;
  readonly updateReceivablesInvoice: UpdateInvoiceDraftUseCase;
  readonly getReceivablesInvoice: GetInvoiceUseCase;
  readonly listReceivablesInvoices: ListInvoicesUseCase;
  readonly deleteReceivablesInvoice: DeleteInvoiceDraftUseCase;
  readonly issueReceivablesInvoice: IssueInvoiceUseCase;
  readonly voidReceivablesInvoice: VoidInvoiceUseCase;
  readonly duplicateReceivablesInvoice: DuplicateInvoiceUseCase;
  readonly listReceivablesBankCsvProfiles: ListBankCsvProfilesUseCase;
  readonly saveReceivablesBankCsvProfile: SaveBankCsvProfileUseCase;
  readonly deleteReceivablesBankCsvProfile: DeleteBankCsvProfileUseCase;
  readonly previewReceivablesBankCsv: PreviewBankCsvUseCase;
  readonly importReceivablesBankCsv: ImportBankCsvUseCase;
  readonly listReceivablesBankTransactions: ListBankTransactionsUseCase;
  readonly deleteReceivablesBankTransaction: DeleteBankTransactionUseCase;
  readonly ignoreReceivablesBankTransaction: IgnoreTransactionUseCase;
  readonly unignoreReceivablesBankTransaction: UnignoreTransactionUseCase;
  readonly judgeReceivablesTransactions: JudgeTransactionsUseCase;
  readonly receivablesMatchCandidates: MatchCandidatesUseCase;
  readonly confirmReceivablesMatching: ConfirmMatchingUseCase;
  readonly confirmReceivablesDecidedMatchings: ConfirmDecidedMatchingsUseCase;
  readonly cancelReceivablesMatching: CancelMatchingUseCase;
  readonly listReceivablesMatchings: ListMatchingsUseCase;
}

/** `GET /runtime/capabilities` の `receivables` に要る依存。 */
export interface ReceivablesRuntimeCapabilityDeps {
  readonly receivablesCapabilities: ReceivablesCapabilitiesUseCase;
}

export async function receivablesRuntimeCapabilities(deps: ReceivablesRuntimeCapabilityDeps): Promise<{ readonly receivables: ReceivablesCapabilities }> {
  return { receivables: await deps.receivablesCapabilities.execute() };
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

function withoutTenant<T extends { readonly tenant?: unknown }>(value: T): Omit<T, 'tenant'> {
  const { tenant: _tenant, ...rest } = value;
  return rest;
}

export const customerResponse = (customer: Customer) => withoutTenant(customer);
export const invoiceResponse = (invoice: Invoice) => withoutTenant(invoice);
export const transactionResponse = (transaction: BankTransaction) => withoutTenant(transaction);
export const matchingResponse = (matching: Matching) => withoutTenant(matching);
export const profileResponse = (profile: BankCsvProfile) => withoutTenant(profile);

/** 本文から請求書の中身だけを取り出す（scope と未知のキーは落とす）。 */
function contentOf(body: z.infer<typeof saveReceivablesInvoiceBodySchema>): InvoiceContent {
  const { scope: _scope, ...content } = body;
  return content as InvoiceContent;
}

type IdParams = { Params: { id: string } };

export function registerReceivablesRoutes(app: FastifyInstance, deps: ReceivablesRouteDeps): void {
  /* 設定 ------------------------------------------------------------------ */
  app.get('/receivables/settings', async (request) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    return deps.getReceivablesSettings.execute(scopeOf(request));
  });
  app.put('/receivables/settings', async (request) => {
    const body = parseWith(saveReceivablesSettingsBodySchema, request.body, 'invalid body');
    return { settings: await deps.saveReceivablesSettings.execute({ scope: scopeOf(request), settings: body.settings }) };
  });

  /* 取引先 ---------------------------------------------------------------- */
  app.get('/receivables/customers', async (request) => {
    const query = parseWith(receivablesCustomerListQuerySchema, request.query, 'invalid query');
    const items = await deps.listReceivablesCustomers.execute(scopeOf(request), query.enabled === undefined ? {} : { enabled: query.enabled === 'true' });
    return { customers: items.map((item) => ({ ...customerResponse(item.customer), outstanding: item.outstanding })) };
  });
  app.post('/receivables/customers', async (request) => {
    const { scope: _scope, ...body } = parseWith(saveReceivablesCustomerBodySchema, request.body, 'invalid body');
    const result = await deps.saveReceivablesCustomer.execute({ scope: scopeOf(request), ...body });
    return { customer: customerResponse(result.customer), warnings: result.warnings };
  });
  app.get<IdParams>('/receivables/customers/:id', async (request) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    return { customer: customerResponse(await deps.getReceivablesCustomer.execute(scopeOf(request), request.params.id)) };
  });
  app.put<IdParams>('/receivables/customers/:id', async (request) => {
    const { scope: _scope, ...body } = parseWith(saveReceivablesCustomerBodySchema, request.body, 'invalid body');
    // 対象は必ずパスの id。
    const result = await deps.saveReceivablesCustomer.execute({ scope: scopeOf(request), ...body, id: request.params.id });
    return { customer: customerResponse(result.customer), warnings: result.warnings };
  });
  app.delete<IdParams>('/receivables/customers/:id', async (request, reply) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    await deps.deleteReceivablesCustomer.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  /* 請求書 ---------------------------------------------------------------- */
  app.get('/receivables/invoices', async (request) => {
    const query = parseWith(receivablesInvoiceListQuerySchema, request.query, 'invalid query');
    const summaries = await deps.listReceivablesInvoices.execute(scopeOf(request), {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.overdue === undefined ? {} : { overdue: query.overdue === 'true' }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    });
    return {
      invoices: summaries.map((summary) => ({
        ...invoiceResponse(summary.invoice),
        ...(summary.customerName === undefined ? {} : { customerName: summary.customerName }),
        outstanding: summary.outstanding, daysOverdue: summary.daysOverdue, violationCount: summary.violationCount,
      })),
    };
  });
  // 静的パスを :id より先に登録する（意図を並びでも示す）。
  app.post('/receivables/invoices/check', async (request) => {
    const body = parseWith(saveReceivablesInvoiceBodySchema, request.body, 'invalid body');
    return { check: await deps.checkReceivablesInvoice.execute({ scope: scopeOf(request), content: contentOf(body) }) };
  });
  app.post('/receivables/invoices', async (request) => {
    const body = parseWith(saveReceivablesInvoiceBodySchema, request.body, 'invalid body');
    const result = await deps.createReceivablesInvoice.execute({ scope: scopeOf(request), content: contentOf(body) });
    return { invoice: invoiceResponse(result.invoice), check: result.check };
  });
  app.get<IdParams>('/receivables/invoices/:id', async (request) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    const result = await deps.getReceivablesInvoice.execute(scopeOf(request), request.params.id);
    return { invoice: invoiceResponse(result.invoice), ...(result.check === undefined ? {} : { check: result.check }), payments: result.payments };
  });
  app.put<IdParams>('/receivables/invoices/:id', async (request) => {
    const body = parseWith(saveReceivablesInvoiceBodySchema, request.body, 'invalid body');
    const result = await deps.updateReceivablesInvoice.execute({ scope: scopeOf(request), id: request.params.id, content: contentOf(body) });
    return { invoice: invoiceResponse(result.invoice), check: result.check };
  });
  app.delete<IdParams>('/receivables/invoices/:id', async (request, reply) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    await deps.deleteReceivablesInvoice.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });
  app.post<IdParams>('/receivables/invoices/:id/issue', async (request) => {
    parseWith(receivablesActionBodySchema, request.body, 'invalid body');
    const result = await deps.issueReceivablesInvoice.execute({ scope: scopeOf(request), id: request.params.id });
    return { ...result, invoice: invoiceResponse(result.invoice) };
  });
  app.post<IdParams>('/receivables/invoices/:id/void', async (request) => {
    const body = parseWith(voidReceivablesInvoiceBodySchema, request.body, 'invalid body');
    const result = await deps.voidReceivablesInvoice.execute({ scope: scopeOf(request), id: request.params.id, reason: body.reason });
    return { ...result, invoice: invoiceResponse(result.invoice) };
  });
  app.post<IdParams>('/receivables/invoices/:id/duplicate', async (request) => {
    parseWith(receivablesActionBodySchema, request.body, 'invalid body');
    const result = await deps.duplicateReceivablesInvoice.execute({ scope: scopeOf(request), id: request.params.id });
    return { invoice: invoiceResponse(result.invoice), check: result.check };
  });

  /* 明細 CSV プロファイル ------------------------------------------------- */
  app.get('/receivables/bank-csv-profiles', async (request) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    return { profiles: (await deps.listReceivablesBankCsvProfiles.execute(scopeOf(request))).map(profileResponse) };
  });
  app.post('/receivables/bank-csv-profiles', async (request) => {
    const { scope: _scope, ...body } = parseWith(saveReceivablesBankCsvProfileBodySchema, request.body, 'invalid body');
    return { profile: profileResponse(await deps.saveReceivablesBankCsvProfile.execute({ scope: scopeOf(request), ...body })) };
  });
  app.delete<IdParams>('/receivables/bank-csv-profiles/:id', async (request, reply) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    await deps.deleteReceivablesBankCsvProfile.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  /* 入金明細 -------------------------------------------------------------- */
  app.post('/receivables/bank-transactions/preview', async (request) => {
    const { scope: _scope, ...body } = parseWith(receivablesBankCsvReadBodySchema, request.body, 'invalid body');
    return { preview: await deps.previewReceivablesBankCsv.execute({ scope: scopeOf(request), ...body }) };
  });
  app.post('/receivables/bank-transactions/import', async (request) => {
    const { scope: _scope, ...body } = parseWith(receivablesBankCsvImportBodySchema, request.body, 'invalid body');
    const result = await deps.importReceivablesBankCsv.execute({ scope: scopeOf(request), ...body });
    return { result: { ...result, imported: result.imported.map(transactionResponse) } };
  });
  app.get('/receivables/bank-transactions', async (request) => {
    const query = parseWith(receivablesBankTransactionListQuerySchema, request.query, 'invalid query');
    const { tenantId: _tenant, workspaceId: _workspace, ...options } = query;
    return { transactions: (await deps.listReceivablesBankTransactions.execute(scopeOf(request), options)).map(transactionResponse) };
  });
  app.delete<IdParams>('/receivables/bank-transactions/:id', async (request, reply) => {
    parseWith(receivablesScopeQuerySchema, request.query, 'invalid query');
    await deps.deleteReceivablesBankTransaction.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });
  app.post<IdParams>('/receivables/bank-transactions/:id/ignore', async (request) => {
    const body = parseWith(ignoreReceivablesTransactionBodySchema, request.body, 'invalid body');
    return { transaction: transactionResponse(await deps.ignoreReceivablesBankTransaction.execute({ scope: scopeOf(request), id: request.params.id, ...(body?.note === undefined ? {} : { note: body.note }) })) };
  });
  app.post<IdParams>('/receivables/bank-transactions/:id/unignore', async (request) => {
    parseWith(receivablesActionBodySchema, request.body, 'invalid body');
    return { transaction: transactionResponse(await deps.unignoreReceivablesBankTransaction.execute({ scope: scopeOf(request), id: request.params.id })) };
  });

  /* 消込 ------------------------------------------------------------------ */
  app.post('/receivables/matching/judge', async (request) => {
    const body = parseWith(judgeReceivablesBodySchema, request.body, 'invalid body');
    return { result: await deps.judgeReceivablesTransactions.execute({ scope: scopeOf(request), ...(body?.transactionIds === undefined ? {} : { transactionIds: body.transactionIds }) }) };
  });
  app.get('/receivables/matching/candidates', async (request) => {
    const query = parseWith(receivablesCandidatesQuerySchema, request.query, 'invalid query');
    const result = await deps.receivablesMatchCandidates.execute(scopeOf(request), query.transactionId);
    return { transaction: transactionResponse(result.transaction), judgment: result.judgment, invoices: result.invoices.map(invoiceResponse) };
  });
  app.post('/receivables/matchings/confirm-decided', async (request) => {
    parseWith(receivablesActionBodySchema, request.body, 'invalid body');
    return { result: await deps.confirmReceivablesDecidedMatchings.execute(scopeOf(request)) };
  });
  app.post('/receivables/matchings', async (request) => {
    const { scope: _scope, ...body } = parseWith(confirmReceivablesMatchingBodySchema, request.body, 'invalid body');
    const result = await deps.confirmReceivablesMatching.execute({ scope: scopeOf(request), ...body });
    return { result: { ...result, matching: matchingResponse(result.matching) } };
  });
  app.get('/receivables/matchings', async (request) => {
    const query = parseWith(receivablesMatchingListQuerySchema, request.query, 'invalid query');
    const { tenantId: _tenant, workspaceId: _workspace, ...options } = query;
    return { matchings: (await deps.listReceivablesMatchings.execute(scopeOf(request), options)).map(matchingResponse) };
  });
  app.post<IdParams>('/receivables/matchings/:id/cancel', async (request) => {
    const body = parseWith(cancelReceivablesMatchingBodySchema, request.body, 'invalid body');
    const result = await deps.cancelReceivablesMatching.execute({ scope: scopeOf(request), matchingId: request.params.id, ...(body?.removeLearnedAlias === undefined ? {} : { removeLearnedAlias: body.removeLearnedAlias }) });
    return { result: { ...result, matching: matchingResponse(result.matching) } };
  });
}
