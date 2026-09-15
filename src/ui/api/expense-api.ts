/**
 * ui/api層: 経費精算（docs/21-expense.md §10 / §20.9.1）の HTTP クライアント（ADR-0039 §8）。
 * 系統の新しいルートは `expense-<people|money|input>-api.ts` が持ち、ここは既存ルートとその拡張だけ。
 *
 * 送信は `ApiTransport`（`ToolApiClient.request`）に任せ、ここはパス・クエリ・応答の包みを剥がすことだけを持つ。
 * `/runtime/capabilities` の `expense` はここが自分の型で読む（共有の `RuntimeCapabilitiesDto` は触らない）。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  CheckExpenseClaimsResultDto, DraftExpenseJournalEntriesResultDto, ExpenseCapabilitiesDto, ExpenseClaimDto, ExpenseClaimListFilterDto,
  ExpenseClaimSummaryDto, ExpensePolicyDto, ExpensePolicyResultDto, ExpenseReceiptDto, ExpenseSettlementQueryDto, ExpenseSettlementResultDto,
  ExtractExpenseReceiptDto, ExtractExpenseReceiptResultDto, ImportExpenseCsvDto, ImportExpenseCsvResultDto, SaveExpenseClaimDto,
  SaveExpenseItemDto, SaveExpensePolicyDto,
} from './expense-types';
import type { TenantScopeDto } from './types';

export const EXPENSE_CAPABILITIES_DISABLED: ExpenseCapabilitiesDto = { extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } };

export interface ExpenseApi {
  capabilities(): Promise<ExpenseCapabilitiesDto>;
  getPolicy(scope: TenantScopeDto): Promise<ExpensePolicyResultDto>;
  savePolicy(scope: TenantScopeDto, policy: SaveExpensePolicyDto): Promise<ExpensePolicyDto>;
  resetPolicy(scope: TenantScopeDto): Promise<ExpensePolicyDto>;
  exportPolicyCsv(scope: TenantScopeDto): Promise<{ readonly content: string; readonly fileName: string }>;
  importPolicyCsv(scope: TenantScopeDto, content: string): Promise<ExpensePolicyDto>;
  listClaims(scope: TenantScopeDto, filter?: ExpenseClaimListFilterDto): Promise<readonly ExpenseClaimSummaryDto[]>;
  createClaim(scope: TenantScopeDto, input: SaveExpenseClaimDto): Promise<ExpenseClaimDto>;
  getClaim(scope: TenantScopeDto, id: string): Promise<ExpenseClaimDto>;
  updateClaim(scope: TenantScopeDto, id: string, input: SaveExpenseClaimDto): Promise<ExpenseClaimDto>;
  deleteClaim(scope: TenantScopeDto, id: string): Promise<void>;
  saveItem(scope: TenantScopeDto, claimId: string, input: SaveExpenseItemDto): Promise<ExpenseClaimDto>;
  deleteItem(scope: TenantScopeDto, claimId: string, itemId: string): Promise<ExpenseClaimDto>;
  getReceipt(scope: TenantScopeDto, claimId: string, itemId: string): Promise<ExpenseReceiptDto>;
  importCsv(scope: TenantScopeDto, input: ImportExpenseCsvDto): Promise<ImportExpenseCsvResultDto>;
  extractReceipt(scope: TenantScopeDto, input: ExtractExpenseReceiptDto, signal?: AbortSignal): Promise<ExtractExpenseReceiptResultDto>;
  checkClaims(scope: TenantScopeDto, claimIds?: readonly string[]): Promise<CheckExpenseClaimsResultDto>;
  acknowledge(scope: TenantScopeDto, claimId: string, input: { readonly itemId?: string; readonly code: string; readonly note: string }): Promise<ExpenseClaimDto>;
  returnDraft(scope: TenantScopeDto, claimId: string): Promise<string>;
  returnClaim(scope: TenantScopeDto, claimId: string, message: string): Promise<ExpenseClaimDto>;
  /** `stepId` は画面を開いたときの現在の段（進んでいたらサーバーが `approval-step-changed` で断る）。 */
  approve(scope: TenantScopeDto, claimId: string, comment?: string, stepId?: string): Promise<ExpenseClaimDto>;
  unapprove(scope: TenantScopeDto, claimId: string, note: string): Promise<ExpenseClaimDto>;
  createJournalDrafts(scope: TenantScopeDto, claimId: string): Promise<DraftExpenseJournalEntriesResultDto>;
  exportSettlement(scope: TenantScopeDto, query: ExpenseSettlementQueryDto): Promise<ExpenseSettlementResultDto>;
  settleClaims(scope: TenantScopeDto, claimIds: readonly string[], exportFileName?: string): Promise<readonly ExpenseClaimDto[]>;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

function withQuery(scope: TenantScopeDto, entries: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const query = scopeQuery(scope);
  // false は「絞り込まない」なので送らない（`unlinked=false` を送ると、読み方次第で紐付き済みだけに絞られかねない）。
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== '' && value !== false) query.set(key, String(value));
  return query.toString();
}

const enabled = (value: unknown): boolean => typeof value === 'object' && value !== null && Reflect.get(value, 'enabled') === true;

const claimPath = (id: string): string => `/expense/claims/${encodeURIComponent(id)}`;

export function expenseApi(transport: ApiTransport): ExpenseApi {
  return {
    async capabilities() {
      const body = await transport.request<{ readonly expense?: Partial<ExpenseCapabilitiesDto> }>('/runtime/capabilities');
      // 古いサーバー（キーが無い・一部だけ）は、欠けた機能を「使えない」として扱う（押せるのに 404 / 409 になる入口を出さない）。
      return {
        extraction: { enabled: body.expense?.extraction?.enabled === true, vision: body.expense?.extraction?.vision === true },
        detailExtraction: { enabled: enabled(body.expense?.detailExtraction) },
        policyHearing: { enabled: enabled(body.expense?.policyHearing) },
      };
    },
    getPolicy: (scope) => transport.request<ExpensePolicyResultDto>(`/expense/policy?${scopeQuery(scope)}`),
    async savePolicy(scope, policy) {
      return (await transport.request<{ policy: ExpensePolicyDto }>('/expense/policy', { method: 'PUT', body: JSON.stringify({ scope, ...policy }) })).policy;
    },
    async resetPolicy(scope) {
      return (await transport.request<{ policy: ExpensePolicyDto }>('/expense/policy/reset', json({ scope }))).policy;
    },
    exportPolicyCsv: (scope) => transport.request<{ content: string; fileName: string }>(`/expense/policy/export?${scopeQuery(scope)}`),
    async importPolicyCsv(scope, content) {
      return (await transport.request<{ policy: ExpensePolicyDto }>('/expense/policy/import', json({ scope, content }))).policy;
    },
    async listClaims(scope, filter = {}) {
      return (await transport.request<{ claims: readonly ExpenseClaimSummaryDto[] }>(`/expense/claims?${withQuery(scope, { ...filter })}`)).claims;
    },
    async createClaim(scope, input) {
      return (await transport.request<{ claim: ExpenseClaimDto }>('/expense/claims', json({ scope, ...input }))).claim;
    },
    async getClaim(scope, id) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(id)}?${scopeQuery(scope)}`)).claim;
    },
    async updateClaim(scope, id, input) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(claimPath(id), { method: 'PUT', body: JSON.stringify({ scope, ...input }) })).claim;
    },
    async deleteClaim(scope, id) {
      await transport.request<unknown>(`${claimPath(id)}?${scopeQuery(scope)}`, { method: 'DELETE' });
    },
    async saveItem(scope, claimId, input) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/items`, json({ scope, ...input }))).claim;
    },
    async deleteItem(scope, claimId, itemId) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/items/${encodeURIComponent(itemId)}?${scopeQuery(scope)}`, { method: 'DELETE' })).claim;
    },
    async getReceipt(scope, claimId, itemId) {
      return (await transport.request<{ receipt: ExpenseReceiptDto }>(`${claimPath(claimId)}/items/${encodeURIComponent(itemId)}/receipt?${scopeQuery(scope)}`)).receipt;
    },
    async importCsv(scope, input) {
      return (await transport.request<{ result: ImportExpenseCsvResultDto }>('/expense/claims/import-csv', json({ scope, ...input }))).result;
    },
    async extractReceipt(scope, input, signal) {
      return (await transport.request<{ result: ExtractExpenseReceiptResultDto }>('/expense/receipts/extract', { ...json({ scope, ...input }), ...(signal === undefined ? {} : { signal }) })).result;
    },
    async checkClaims(scope, claimIds) {
      return (await transport.request<{ result: CheckExpenseClaimsResultDto }>('/expense/claims/check', json({ scope, ...(claimIds === undefined ? {} : { claimIds }) }))).result;
    },
    async acknowledge(scope, claimId, input) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/acknowledge`, json({ scope, ...input }))).claim;
    },
    async returnDraft(scope, claimId) {
      return (await transport.request<{ message: string }>(`${claimPath(claimId)}/return-draft?${scopeQuery(scope)}`)).message;
    },
    async returnClaim(scope, claimId, message) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/return`, json({ scope, message }))).claim;
    },
    async approve(scope, claimId, comment, stepId) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/approve`, json({
        scope, ...(comment === undefined || comment === '' ? {} : { comment }), ...(stepId === undefined || stepId === '' ? {} : { stepId }),
      }))).claim;
    },
    async unapprove(scope, claimId, note) {
      return (await transport.request<{ claim: ExpenseClaimDto }>(`${claimPath(claimId)}/unapprove`, json({ scope, note }))).claim;
    },
    createJournalDrafts: (scope, claimId) => transport.request<DraftExpenseJournalEntriesResultDto>(`${claimPath(claimId)}/journal-drafts`, json({ scope })),
    async exportSettlement(scope, query) {
      return (await transport.request<{ result: ExpenseSettlementResultDto }>(`/expense/export?${withQuery(scope, { ...query })}`)).result;
    },
    async settleClaims(scope, claimIds, exportFileName) {
      return (await transport.request<{ claims: readonly ExpenseClaimDto[] }>('/expense/claims/settle', json({ scope, claimIds, ...(exportFileName === undefined ? {} : { exportFileName }) }))).claims;
    },
  };
}
