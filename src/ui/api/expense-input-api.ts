/**
 * ui/api層: 経費精算「入力と規程」（追加読取・運賃マスタ・規程のヒアリング。§20.9.4）の HTTP クライアント。
 *
 * 送信は `ApiTransport`（`ToolApiClient` が満たす）。失敗は `ApiError`（見出しは `expense-error-messages.ts`）のまま投げる。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  AcceptExpensePolicyHearingResultDto, ExpenseFareLookupDto, ExpenseFareLookupResultDto, ExpenseFareTableDto, ExpenseFareTableResultDto,
  ExpenseHearingAnswerDto, ExpenseHearingStatusDto, ExpensePolicyDiffDto, ExpensePolicyHearingDto, ExpensePolicyHearingSummaryDto,
  ExtractExpenseDetailDto, ExtractExpenseDetailResultDto, SaveExpenseFareTableDto, StartExpensePolicyHearingDto,
} from './expense-input-types';
import type { TenantScopeDto } from './types';

export interface ExpenseInputApi {
  getFares(scope: TenantScopeDto): Promise<ExpenseFareTableResultDto>;
  saveFares(scope: TenantScopeDto, body: SaveExpenseFareTableDto): Promise<ExpenseFareTableDto>;
  exportFaresCsv(scope: TenantScopeDto): Promise<{ readonly content: string; readonly fileName: string }>;
  importFaresCsv(scope: TenantScopeDto, content: string): Promise<ExpenseFareTableDto>;
  lookupFare(scope: TenantScopeDto, input: ExpenseFareLookupDto, signal?: AbortSignal): Promise<ExpenseFareLookupResultDto>;
  /** 「実用機能の準備」カードの「運賃」が設定済みか（保存済みで経路が 1 件以上）。 */
  fareReadiness(scope: TenantScopeDto): Promise<boolean>;
  extractDetail(scope: TenantScopeDto, input: ExtractExpenseDetailDto, signal?: AbortSignal): Promise<ExtractExpenseDetailResultDto>;
  startHearing(scope: TenantScopeDto, input: StartExpensePolicyHearingDto, signal?: AbortSignal): Promise<ExpensePolicyHearingDto>;
  listHearings(scope: TenantScopeDto, status?: ExpenseHearingStatusDto): Promise<readonly ExpensePolicyHearingSummaryDto[]>;
  getHearing(scope: TenantScopeDto, id: string): Promise<ExpensePolicyHearingDto>;
  answerHearing(scope: TenantScopeDto, id: string, answers: readonly ExpenseHearingAnswerDto[], signal?: AbortSignal): Promise<ExpensePolicyHearingDto>;
  diffHearing(scope: TenantScopeDto, id: string): Promise<ExpensePolicyDiffDto>;
  acceptHearing(scope: TenantScopeDto, id: string, changeIds: readonly string[], basePolicyUpdatedAt: string): Promise<AcceptExpensePolicyHearingResultDto>;
  cancelHearing(scope: TenantScopeDto, id: string): Promise<ExpensePolicyHearingDto>;
}

/** 運賃マスタが「設定済み」か（準備カードの判定。未保存・経路 0 件は未設定）。 */
export function fareTableConfigured(result: ExpenseFareTableResultDto): boolean {
  return result.saved && result.table.routes.length > 0;
}

const post = (body: unknown, signal?: AbortSignal): RequestInit => ({ method: 'POST', body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });
const hearingPath = (id: string): string => `/expense/policy-hearings/${encodeURIComponent(id)}`;

export function expenseInputApi(transport: ApiTransport): ExpenseInputApi {
  return {
    getFares: (scope) => transport.request<ExpenseFareTableResultDto>(`/expense/fares?${scopeQuery(scope)}`),
    async saveFares(scope, body) {
      return (await transport.request<{ table: ExpenseFareTableDto }>('/expense/fares', { method: 'PUT', body: JSON.stringify({ scope, ...body }) })).table;
    },
    exportFaresCsv: (scope) => transport.request<{ content: string; fileName: string }>(`/expense/fares/export?${scopeQuery(scope)}`),
    async importFaresCsv(scope, content) {
      return (await transport.request<{ table: ExpenseFareTableDto }>('/expense/fares/import', post({ scope, content }))).table;
    },
    async lookupFare(scope, input, signal) {
      return (await transport.request<{ result: ExpenseFareLookupResultDto }>('/expense/fares/lookup', post({ scope, ...input }, signal))).result;
    },
    async fareReadiness(scope) {
      return fareTableConfigured(await transport.request<ExpenseFareTableResultDto>(`/expense/fares?${scopeQuery(scope)}`));
    },
    async extractDetail(scope, input, signal) {
      return (await transport.request<{ result: ExtractExpenseDetailResultDto }>('/expense/receipts/extract-detail', post({ scope, ...input }, signal))).result;
    },
    async startHearing(scope, input, signal) {
      return (await transport.request<{ hearing: ExpensePolicyHearingDto }>('/expense/policy-hearings', post({ scope, ...input }, signal))).hearing;
    },
    async listHearings(scope, status) {
      const query = scopeQuery(scope);
      if (status !== undefined) query.set('status', status);
      return (await transport.request<{ hearings: readonly ExpensePolicyHearingSummaryDto[] }>(`/expense/policy-hearings?${query}`)).hearings;
    },
    async getHearing(scope, id) {
      return (await transport.request<{ hearing: ExpensePolicyHearingDto }>(`${hearingPath(id)}?${scopeQuery(scope)}`)).hearing;
    },
    async answerHearing(scope, id, answers, signal) {
      return (await transport.request<{ hearing: ExpensePolicyHearingDto }>(`${hearingPath(id)}/answers`, post({ scope, answers }, signal))).hearing;
    },
    diffHearing: (scope, id) => transport.request<ExpensePolicyDiffDto>(`${hearingPath(id)}/diff?${scopeQuery(scope)}`),
    acceptHearing: (scope, id, changeIds, basePolicyUpdatedAt) => transport.request<AcceptExpensePolicyHearingResultDto>(`${hearingPath(id)}/accept`, post({ scope, changeIds, basePolicyUpdatedAt })),
    async cancelHearing(scope, id) {
      return (await transport.request<{ hearing: ExpensePolicyHearingDto }>(`${hearingPath(id)}/cancel`, post({ scope }))).hearing;
    },
  };
}
