/**
 * ui/api層: 経費精算「お金の流れ（仮払・カード明細・集計。docs/21 §20.9.3）」の HTTP クライアント（ADR-0039 §8）。
 *
 * 送信は `ApiTransport`（`ToolApiClient.request`）に任せ、ここはパス・クエリ・応答の包みを剥がすことだけを持つ。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  CreateExpenseAdvanceDto, ExpenseAdvanceDetailDto, ExpenseAdvanceDto, ExpenseAdvanceJournalResultDto, ExpenseAdvanceJournalStageDto,
  ExpenseAdvanceListFilterDto, ExpenseAdvancePaymentDto, ExpenseAdvanceSettleResultDto, ExpenseAdvanceSettlementPreviewDto, ExpenseCardDto,
  ExpenseCardImportDto, ExpenseCardImportResultDto, ExpenseCardMatchResultDto, ExpenseCardSettingsDto, ExpenseCardSettingsResultDto,
  ExpenseCardStatementImportInputDto, ExpenseCardStatementInputDto, ExpenseCardStatementPreviewDto, ExpenseCardStatementProfileDto,
  ExpenseCardTransactionDto, ExpenseCardTransactionFilterDto, ExpenseMoneyReadinessDto, ExpensePayoutBatchDto, ExpensePayoutBatchStatusDto,
  ExpensePayoutConfirmResultDto, ExpensePayoutCreateResultDto, ExpensePayoutFileDto, ExpensePayoutPreviewDto, ExpensePayoutRequestDto,
  ExpensePayoutSettingsDto, ExpensePayoutSettingsResultDto, ExpenseSummaryQueryDto, ExpenseSummaryResultDto, SaveExpenseAdvanceDto,
  SaveExpensePayoutSettingsDto,
} from './expense-money-types';
import type { ExpenseClaimDto } from './expense-types';
import type { TenantScopeDto } from './types';

/** お金の流れ（§20.9.3）の HTTP クライアント。 */
export interface ExpenseMoneyApi {
  readiness(scope: TenantScopeDto): Promise<ExpenseMoneyReadinessDto>;
  listAdvances(scope: TenantScopeDto, filter?: ExpenseAdvanceListFilterDto): Promise<readonly ExpenseAdvanceDto[]>;
  getAdvance(scope: TenantScopeDto, id: string): Promise<ExpenseAdvanceDetailDto>;
  createAdvance(scope: TenantScopeDto, input: CreateExpenseAdvanceDto): Promise<ExpenseAdvanceDto>;
  updateAdvance(scope: TenantScopeDto, id: string, input: SaveExpenseAdvanceDto): Promise<ExpenseAdvanceDto>;
  approveAdvance(scope: TenantScopeDto, id: string, comment?: string): Promise<ExpenseAdvanceDto>;
  cancelAdvance(scope: TenantScopeDto, id: string, note: string): Promise<ExpenseAdvanceDto>;
  markAdvancePaid(scope: TenantScopeDto, id: string, payment: ExpenseAdvancePaymentDto): Promise<ExpenseAdvanceDto>;
  unpayAdvance(scope: TenantScopeDto, id: string, note: string): Promise<ExpenseAdvanceDto>;
  settlementPreview(scope: TenantScopeDto, id: string): Promise<ExpenseAdvanceSettlementPreviewDto>;
  settleAdvance(scope: TenantScopeDto, id: string): Promise<ExpenseAdvanceSettleResultDto>;
  refundReceived(scope: TenantScopeDto, id: string, receivedOn: string): Promise<ExpenseAdvanceDto>;
  additionalPaid(scope: TenantScopeDto, id: string, payment: ExpenseAdvancePaymentDto): Promise<ExpenseAdvanceDto>;
  createAdvanceJournalDraft(scope: TenantScopeDto, id: string, stage: ExpenseAdvanceJournalStageDto): Promise<ExpenseAdvanceJournalResultDto>;
  /** null で紐付けを外す。申請は draft へ戻る（再チェックが要る）。 */
  linkClaimAdvance(scope: TenantScopeDto, claimId: string, advanceId: string | null): Promise<ExpenseClaimDto>;
  getCardSettings(scope: TenantScopeDto): Promise<ExpenseCardSettingsResultDto>;
  saveCardSettings(scope: TenantScopeDto, input: { readonly cards: readonly ExpenseCardDto[]; readonly profiles: readonly ExpenseCardStatementProfileDto[] }): Promise<ExpenseCardSettingsDto>;
  previewCardStatement(scope: TenantScopeDto, input: ExpenseCardStatementInputDto): Promise<ExpenseCardStatementPreviewDto>;
  importCardStatement(scope: TenantScopeDto, input: ExpenseCardStatementImportInputDto): Promise<ExpenseCardImportResultDto>;
  listCardImports(scope: TenantScopeDto, limit?: number): Promise<readonly ExpenseCardImportDto[]>;
  deleteCardImport(scope: TenantScopeDto, id: string): Promise<void>;
  listCardTransactions(scope: TenantScopeDto, filter?: ExpenseCardTransactionFilterDto): Promise<readonly ExpenseCardTransactionDto[]>;
  matchCardTransactions(scope: TenantScopeDto, range?: { readonly from?: string; readonly to?: string }): Promise<ExpenseCardMatchResultDto>;
  excludeCardTransaction(scope: TenantScopeDto, id: string, reason: string): Promise<ExpenseCardTransactionDto>;
  includeCardTransaction(scope: TenantScopeDto, id: string): Promise<ExpenseCardTransactionDto>;
  linkCardTransaction(scope: TenantScopeDto, id: string, target: { readonly claimId: string; readonly itemId: string }): Promise<ExpenseCardTransactionDto>;
  unlinkCardTransaction(scope: TenantScopeDto, id: string): Promise<ExpenseCardTransactionDto>;
  getSummary(scope: TenantScopeDto, query: ExpenseSummaryQueryDto): Promise<ExpenseSummaryResultDto>;
  exportSummary(scope: TenantScopeDto, query: ExpenseSummaryQueryDto): Promise<{ readonly content: string; readonly fileName: string }>;
  getPayoutSettings(scope: TenantScopeDto): Promise<ExpensePayoutSettingsResultDto>;
  savePayoutSettings(scope: TenantScopeDto, input: SaveExpensePayoutSettingsDto): Promise<ExpensePayoutSettingsDto>;
  previewPayout(scope: TenantScopeDto, request: ExpensePayoutRequestDto): Promise<ExpensePayoutPreviewDto>;
  /** 口座番号を含むファイル（base64）を返す。止める理由・未確認の警告は 409 EXPENSE_PAYOUT_BLOCKED。 */
  createPayout(scope: TenantScopeDto, request: ExpensePayoutRequestDto & { readonly acknowledgedWarnings: readonly string[] }): Promise<ExpensePayoutCreateResultDto>;
  listPayouts(scope: TenantScopeDto, status?: ExpensePayoutBatchStatusDto): Promise<readonly ExpensePayoutBatchDto[]>;
  downloadPayoutFile(scope: TenantScopeDto, id: string): Promise<ExpensePayoutFileDto>;
  confirmPayout(scope: TenantScopeDto, id: string): Promise<ExpensePayoutConfirmResultDto>;
  cancelPayout(scope: TenantScopeDto, id: string, note: string): Promise<ExpensePayoutBatchDto>;
}

function post(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function withQuery(scope: TenantScopeDto, entries: Readonly<Record<string, string | number | undefined>>): string {
  const query = scopeQuery(scope);
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== '') query.set(key, String(value));
  return query.toString();
}

const advancePath = (id: string): string => `/expense/advances/${encodeURIComponent(id)}`;
const transactionPath = (id: string): string => `/expense/card-transactions/${encodeURIComponent(id)}`;

function summaryQuery(scope: TenantScopeDto, query: ExpenseSummaryQueryDto): string {
  return withQuery(scope, {
    from: query.from, to: query.to, groupBy: query.groupBy.join(','), basis: query.basis,
    ...(query.statuses.length === 0 ? {} : { status: query.statuses.join(',') }),
  });
}

export function expenseMoneyApi(transport: ApiTransport): ExpenseMoneyApi {
  const advance = async (path: string, body: unknown): Promise<ExpenseAdvanceDto> => (await transport.request<{ advance: ExpenseAdvanceDto }>(path, post(body))).advance;
  const transaction = async (path: string, body: unknown): Promise<ExpenseCardTransactionDto> => (await transport.request<{ transaction: ExpenseCardTransactionDto }>(path, post(body))).transaction;
  return {
    async readiness(scope) {
      return (await transport.request<{ readiness: ExpenseMoneyReadinessDto }>(`/expense/money-readiness?${scopeQuery(scope)}`)).readiness;
    },
    async listAdvances(scope, filter = {}) {
      return (await transport.request<{ advances: readonly ExpenseAdvanceDto[] }>(`/expense/advances?${withQuery(scope, { status: filter.status, employeeId: filter.employeeId, limit: filter.limit })}`)).advances;
    },
    getAdvance: (scope, id) => transport.request<ExpenseAdvanceDetailDto>(`${advancePath(id)}?${scopeQuery(scope)}`),
    createAdvance: (scope, input) => advance('/expense/advances', { scope, ...input }),
    async updateAdvance(scope, id, input) {
      return (await transport.request<{ advance: ExpenseAdvanceDto }>(advancePath(id), { method: 'PUT', body: JSON.stringify({ scope, ...input }) })).advance;
    },
    approveAdvance: (scope, id, comment) => advance(`${advancePath(id)}/approve`, { scope, ...(comment === undefined || comment === '' ? {} : { comment }) }),
    cancelAdvance: (scope, id, note) => advance(`${advancePath(id)}/cancel`, { scope, note }),
    markAdvancePaid: (scope, id, payment) => advance(`${advancePath(id)}/mark-paid`, { scope, ...payment }),
    unpayAdvance: (scope, id, note) => advance(`${advancePath(id)}/unpay`, { scope, note }),
    async settlementPreview(scope, id) {
      return (await transport.request<{ preview: ExpenseAdvanceSettlementPreviewDto }>(`${advancePath(id)}/settlement-preview?${scopeQuery(scope)}`)).preview;
    },
    settleAdvance: (scope, id) => transport.request<ExpenseAdvanceSettleResultDto>(`${advancePath(id)}/settle`, post({ scope })),
    refundReceived: (scope, id, receivedOn) => advance(`${advancePath(id)}/refund-received`, { scope, receivedOn }),
    additionalPaid: (scope, id, payment) => advance(`${advancePath(id)}/additional-paid`, { scope, ...payment }),
    createAdvanceJournalDraft: (scope, id, stage) => transport.request<ExpenseAdvanceJournalResultDto>(`${advancePath(id)}/journal-drafts`, post({ scope, stage })),
    async linkClaimAdvance(scope, claimId, advanceId) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`/expense/claims/${encodeURIComponent(claimId)}/advance`, { method: 'PUT', body: JSON.stringify({ scope, advanceId }) })).claim;
    },
    getCardSettings: (scope) => transport.request<ExpenseCardSettingsResultDto>(`/expense/card-settings?${scopeQuery(scope)}`),
    async saveCardSettings(scope, input) {
      return (await transport.request<{ settings: ExpenseCardSettingsDto }>('/expense/card-settings', { method: 'PUT', body: JSON.stringify({ scope, ...input }) })).settings;
    },
    async previewCardStatement(scope, input) {
      return (await transport.request<{ result: ExpenseCardStatementPreviewDto }>('/expense/card-statements/preview', post({ scope, ...input }))).result;
    },
    async importCardStatement(scope, input) {
      return (await transport.request<{ result: ExpenseCardImportResultDto }>('/expense/card-statements', post({ scope, ...input }))).result;
    },
    async listCardImports(scope, limit) {
      return (await transport.request<{ imports: readonly ExpenseCardImportDto[] }>(`/expense/card-statements?${withQuery(scope, { limit })}`)).imports;
    },
    async deleteCardImport(scope, id) {
      await transport.request(`/expense/card-statements/${encodeURIComponent(id)}?${scopeQuery(scope)}`, { method: 'DELETE' });
    },
    async listCardTransactions(scope, filter = {}) {
      return (await transport.request<{ transactions: readonly ExpenseCardTransactionDto[] }>(`/expense/card-transactions?${withQuery(scope, { ...filter })}`)).transactions;
    },
    async matchCardTransactions(scope, range = {}) {
      return (await transport.request<{ result: ExpenseCardMatchResultDto }>('/expense/card-transactions/match', post({ scope, ...range }))).result;
    },
    excludeCardTransaction: (scope, id, reason) => transaction(`${transactionPath(id)}/exclude`, { scope, reason }),
    includeCardTransaction: (scope, id) => transaction(`${transactionPath(id)}/include`, { scope }),
    linkCardTransaction: (scope, id, target) => transaction(`${transactionPath(id)}/link`, { scope, ...target }),
    unlinkCardTransaction: (scope, id) => transaction(`${transactionPath(id)}/unlink`, { scope }),
    async getSummary(scope, query) {
      return (await transport.request<{ result: ExpenseSummaryResultDto }>(`/expense/summary?${summaryQuery(scope, query)}`)).result;
    },
    exportSummary: (scope, query) => transport.request<{ content: string; fileName: string }>(`/expense/summary/export?${summaryQuery(scope, query)}`),
    getPayoutSettings: (scope) => transport.request<ExpensePayoutSettingsResultDto>(`/expense/payout-settings?${scopeQuery(scope)}`),
    async savePayoutSettings(scope, input) {
      return (await transport.request<{ settings: ExpensePayoutSettingsDto }>('/expense/payout-settings', { method: 'PUT', body: JSON.stringify({ scope, ...input }) })).settings;
    },
    async previewPayout(scope, request) {
      return (await transport.request<{ result: ExpensePayoutPreviewDto }>('/expense/payouts/preview', post({ scope, ...request }))).result;
    },
    createPayout: (scope, request) => transport.request<ExpensePayoutCreateResultDto>('/expense/payouts', post({ scope, ...request })),
    async listPayouts(scope, status) {
      return (await transport.request<{ batches: readonly ExpensePayoutBatchDto[] }>(`/expense/payouts?${withQuery(scope, { status })}`)).batches;
    },
    async downloadPayoutFile(scope, id) {
      return (await transport.request<{ file: ExpensePayoutFileDto }>(`/expense/payouts/${encodeURIComponent(id)}/file?${scopeQuery(scope)}`)).file;
    },
    confirmPayout: (scope, id) => transport.request<ExpensePayoutConfirmResultDto>(`/expense/payouts/${encodeURIComponent(id)}/confirm`, post({ scope })),
    async cancelPayout(scope, id, note) {
      return (await transport.request<{ batch: ExpensePayoutBatchDto }>(`/expense/payouts/${encodeURIComponent(id)}/cancel`, post({ scope, note }))).batch;
    },
  };
}
