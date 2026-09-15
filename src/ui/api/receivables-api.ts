/**
 * ui/api層: 入金消込（docs/22-receivables.md §7）の HTTP 呼び出し（ADR-0039 §8）。
 *
 * 送信は `ApiTransport.request`（認証ヘッダ・JSON 解析・`ApiError` への変換は共有側）。scope はサーバーが
 * Principal から決めるので本文には現在のスコープの写しを載せるだけ（読まれない）。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  AliasConflictDto, BankCsvImportResultDto, BankCsvPreviewDto, BankCsvProfileDto, BankCsvReadDto, BankTransactionDto, BankTransactionStatusDto,
  CancelMatchingResultDto, ColumnMappingDto, ConfirmDecidedResultDto, ConfirmMatchingDto, ConfirmMatchingResultDto, CustomerDto, InvoiceCheckDto, InvoiceDto,
  InvoicePaymentDto, InvoiceStatusDto, InvoiceSummaryDto, IssueInvoiceResultDto, JournalFollowUpDto, JudgeResultDto, MatchJudgmentDto, MatchingDto,
  ReceivablesCapabilitiesDto, ReceivablesSettingsDto, SaveCustomerDto, SaveInvoiceDto,
} from './receivables-types';
import type { TenantScopeDto } from './types';

export interface ReceivablesApi {
  getSettings(scope: TenantScopeDto): Promise<{ readonly settings: ReceivablesSettingsDto; readonly saved: boolean }>;
  saveSettings(scope: TenantScopeDto, settings: ReceivablesSettingsDto): Promise<ReceivablesSettingsDto>;
  listCustomers(scope: TenantScopeDto, options?: { readonly enabled?: boolean }): Promise<readonly CustomerDto[]>;
  getCustomer(scope: TenantScopeDto, id: string): Promise<CustomerDto>;
  saveCustomer(scope: TenantScopeDto, customer: SaveCustomerDto, id?: string): Promise<{ readonly customer: CustomerDto; readonly warnings: readonly AliasConflictDto[] }>;
  deleteCustomer(scope: TenantScopeDto, id: string): Promise<void>;
  listInvoices(scope: TenantScopeDto, options?: { readonly status?: InvoiceStatusDto; readonly customerId?: string; readonly overdue?: boolean }): Promise<readonly InvoiceSummaryDto[]>;
  checkInvoice(scope: TenantScopeDto, content: SaveInvoiceDto): Promise<InvoiceCheckDto>;
  saveInvoice(scope: TenantScopeDto, content: SaveInvoiceDto, id?: string): Promise<{ readonly invoice: InvoiceDto; readonly check: InvoiceCheckDto }>;
  getInvoice(scope: TenantScopeDto, id: string): Promise<{ readonly invoice: InvoiceDto; readonly check?: InvoiceCheckDto; readonly payments: readonly InvoicePaymentDto[] }>;
  deleteInvoice(scope: TenantScopeDto, id: string): Promise<void>;
  issueInvoice(scope: TenantScopeDto, id: string): Promise<IssueInvoiceResultDto>;
  voidInvoice(scope: TenantScopeDto, id: string, reason: string): Promise<{ readonly invoice: InvoiceDto; readonly journalFollowUp?: JournalFollowUpDto }>;
  duplicateInvoice(scope: TenantScopeDto, id: string): Promise<{ readonly invoice: InvoiceDto; readonly check: InvoiceCheckDto }>;
  listProfiles(scope: TenantScopeDto): Promise<readonly BankCsvProfileDto[]>;
  saveProfile(scope: TenantScopeDto, profile: { readonly id?: string; readonly name: string; readonly mapping: ColumnMappingDto; readonly headerSignature?: readonly string[]; readonly headerRow?: number | 'auto'; readonly accountKey?: string }): Promise<BankCsvProfileDto>;
  deleteProfile(scope: TenantScopeDto, id: string): Promise<void>;
  previewCsv(scope: TenantScopeDto, input: BankCsvReadDto): Promise<BankCsvPreviewDto>;
  importCsv(scope: TenantScopeDto, input: BankCsvReadDto & { readonly forceRows?: readonly number[] }): Promise<BankCsvImportResultDto>;
  listTransactions(scope: TenantScopeDto, options?: { readonly status?: BankTransactionStatusDto }): Promise<readonly BankTransactionDto[]>;
  deleteTransaction(scope: TenantScopeDto, id: string): Promise<void>;
  ignoreTransaction(scope: TenantScopeDto, id: string, note?: string): Promise<BankTransactionDto>;
  unignoreTransaction(scope: TenantScopeDto, id: string): Promise<BankTransactionDto>;
  judge(scope: TenantScopeDto, transactionIds?: readonly string[]): Promise<JudgeResultDto>;
  candidates(scope: TenantScopeDto, transactionId: string): Promise<{ readonly transaction: BankTransactionDto; readonly judgment: MatchJudgmentDto; readonly invoices: readonly InvoiceDto[] }>;
  confirmMatching(scope: TenantScopeDto, input: ConfirmMatchingDto): Promise<ConfirmMatchingResultDto>;
  confirmDecided(scope: TenantScopeDto): Promise<ConfirmDecidedResultDto>;
  listMatchings(scope: TenantScopeDto, options?: { readonly status?: 'confirmed' | 'cancelled'; readonly invoiceId?: string }): Promise<readonly MatchingDto[]>;
  cancelMatching(scope: TenantScopeDto, id: string, removeLearnedAlias?: boolean): Promise<CancelMatchingResultDto>;
  capabilities(): Promise<ReceivablesCapabilitiesDto>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const id = (value: string) => encodeURIComponent(value);

function query(scope: TenantScopeDto, options: Readonly<Record<string, string | number | boolean | undefined>> = {}): string {
  const params = scopeQuery(scope);
  for (const [key, value] of Object.entries(options)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
}

export function receivablesApi(transport: ApiTransport): ReceivablesApi {
  const request = <T>(path: string, init?: RequestInit) => transport.request<T>(path, init);
  return {
    getSettings: (scope) => request(`/receivables/settings?${query(scope)}`),
    saveSettings: async (scope, settings) => {
      const { updatedAt: _updatedAt, ...body } = settings;
      return (await request<{ settings: ReceivablesSettingsDto }>('/receivables/settings', json('PUT', { scope, settings: body }))).settings;
    },
    listCustomers: async (scope, options = {}) => (await request<{ customers: CustomerDto[] }>(`/receivables/customers?${query(scope, { enabled: options.enabled })}`)).customers,
    getCustomer: async (scope, customerId) => (await request<{ customer: CustomerDto }>(`/receivables/customers/${id(customerId)}?${query(scope)}`)).customer,
    saveCustomer: (scope, customer, customerId) => customerId === undefined
      ? request('/receivables/customers', json('POST', { scope, ...customer }))
      : request(`/receivables/customers/${id(customerId)}`, json('PUT', { scope, ...customer })),
    deleteCustomer: async (scope, customerId) => { await request(`/receivables/customers/${id(customerId)}?${query(scope)}`, { method: 'DELETE' }); },
    listInvoices: async (scope, options = {}) => (await request<{ invoices: InvoiceSummaryDto[] }>(`/receivables/invoices?${query(scope, { status: options.status, customerId: options.customerId, overdue: options.overdue })}`)).invoices,
    checkInvoice: async (scope, content) => (await request<{ check: InvoiceCheckDto }>('/receivables/invoices/check', json('POST', { scope, ...content }))).check,
    saveInvoice: (scope, content, invoiceId) => invoiceId === undefined
      ? request('/receivables/invoices', json('POST', { scope, ...content }))
      : request(`/receivables/invoices/${id(invoiceId)}`, json('PUT', { scope, ...content })),
    getInvoice: (scope, invoiceId) => request(`/receivables/invoices/${id(invoiceId)}?${query(scope)}`),
    deleteInvoice: async (scope, invoiceId) => { await request(`/receivables/invoices/${id(invoiceId)}?${query(scope)}`, { method: 'DELETE' }); },
    issueInvoice: (scope, invoiceId) => request(`/receivables/invoices/${id(invoiceId)}/issue`, json('POST', { scope })),
    voidInvoice: (scope, invoiceId, reason) => request(`/receivables/invoices/${id(invoiceId)}/void`, json('POST', { scope, reason })),
    duplicateInvoice: (scope, invoiceId) => request(`/receivables/invoices/${id(invoiceId)}/duplicate`, json('POST', { scope })),
    listProfiles: async (scope) => (await request<{ profiles: BankCsvProfileDto[] }>(`/receivables/bank-csv-profiles?${query(scope)}`)).profiles,
    saveProfile: async (scope, profile) => (await request<{ profile: BankCsvProfileDto }>('/receivables/bank-csv-profiles', json('POST', { scope, ...profile }))).profile,
    deleteProfile: async (scope, profileId) => { await request(`/receivables/bank-csv-profiles/${id(profileId)}?${query(scope)}`, { method: 'DELETE' }); },
    previewCsv: async (scope, input) => (await request<{ preview: BankCsvPreviewDto }>('/receivables/bank-transactions/preview', json('POST', { scope, ...input }))).preview,
    importCsv: async (scope, input) => (await request<{ result: BankCsvImportResultDto }>('/receivables/bank-transactions/import', json('POST', { scope, ...input }))).result,
    listTransactions: async (scope, options = {}) => (await request<{ transactions: BankTransactionDto[] }>(`/receivables/bank-transactions?${query(scope, { status: options.status })}`)).transactions,
    deleteTransaction: async (scope, transactionId) => { await request(`/receivables/bank-transactions/${id(transactionId)}?${query(scope)}`, { method: 'DELETE' }); },
    ignoreTransaction: async (scope, transactionId, note) => (await request<{ transaction: BankTransactionDto }>(`/receivables/bank-transactions/${id(transactionId)}/ignore`, json('POST', { scope, ...(note === undefined ? {} : { note }) }))).transaction,
    unignoreTransaction: async (scope, transactionId) => (await request<{ transaction: BankTransactionDto }>(`/receivables/bank-transactions/${id(transactionId)}/unignore`, json('POST', { scope }))).transaction,
    judge: async (scope, transactionIds) => (await request<{ result: JudgeResultDto }>('/receivables/matching/judge', json('POST', { scope, ...(transactionIds === undefined ? {} : { transactionIds }) }))).result,
    candidates: (scope, transactionId) => request(`/receivables/matching/candidates?${query(scope, { transactionId })}`),
    confirmMatching: async (scope, input) => (await request<{ result: ConfirmMatchingResultDto }>('/receivables/matchings', json('POST', { scope, ...input }))).result,
    confirmDecided: async (scope) => (await request<{ result: ConfirmDecidedResultDto }>('/receivables/matchings/confirm-decided', json('POST', { scope }))).result,
    listMatchings: async (scope, options = {}) => (await request<{ matchings: MatchingDto[] }>(`/receivables/matchings?${query(scope, { status: options.status, invoiceId: options.invoiceId })}`)).matchings,
    cancelMatching: async (scope, matchingId, removeLearnedAlias) => (await request<{ result: CancelMatchingResultDto }>(`/receivables/matchings/${id(matchingId)}/cancel`, json('POST', { scope, ...(removeLearnedAlias === undefined ? {} : { removeLearnedAlias }) }))).result,
    // 機能フラグは共有の `/runtime/capabilities` の業務キーを自分の型で読む。取れなければ「使えない」。
    capabilities: async () => (await request<{ receivables?: ReceivablesCapabilitiesDto }>('/runtime/capabilities')).receivables ?? { invoiceDraft: { enabled: false, vision: false } },
  };
}
