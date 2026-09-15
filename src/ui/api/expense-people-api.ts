/**
 * ui/api層: 人と承認（docs/21 §20.9.2）の HTTP クライアント（ADR-0039 §8）。
 *
 * 送信は `ApiTransport` に任せ、ここはパス・クエリ・応答の包みを剥がすことだけを持つ。
 * 「実用機能の準備」カードの従業員・振込元の状況は `expensePeopleReadinessKnown`（`readinessRows` の 2 番目の引数の形）で読む。
 */
import { scopeQuery, type ApiTransport } from './business-api';
import type {
  ConfirmExpenseEmployeeLinksResultDto, ExpenseApprovalFlowViewDto, ExpenseApprovalRoutePreviewDto, ExpenseApprovalRoutePreviewInputDto, ExpenseCsvFileDto,
  ExpenseEmployeeDto, ExpenseEmployeeLinkDto, ExpenseEmployeeListFilterDto, ExpenseMeDto, ExpenseOrganizationDto, ExpenseOrganizationResultDto,
  ExpensePeopleReadinessDto, ImportExpenseEmployeesResultDto, SaveExpenseEmployeeDto,
} from './expense-people-types';
import type { ExpenseClaimStatusDto } from './expense-types';
import type { TenantScopeDto } from './types';

export interface ExpensePeopleApi {
  me(scope: TenantScopeDto): Promise<ExpenseMeDto>;
  readiness(scope: TenantScopeDto): Promise<ExpensePeopleReadinessDto>;
  listEmployees(scope: TenantScopeDto, filter?: ExpenseEmployeeListFilterDto): Promise<readonly ExpenseEmployeeDto[]>;
  getEmployee(scope: TenantScopeDto, id: string): Promise<ExpenseEmployeeDto>;
  createEmployee(scope: TenantScopeDto, input: SaveExpenseEmployeeDto): Promise<ExpenseEmployeeDto>;
  updateEmployee(scope: TenantScopeDto, id: string, input: SaveExpenseEmployeeDto): Promise<ExpenseEmployeeDto>;
  importEmployeesCsv(scope: TenantScopeDto, content: string): Promise<ImportExpenseEmployeesResultDto>;
  /** `withBankAccounts` は口座番号つき（approve 権限が要る。無ければ 403）。 */
  exportEmployeesCsv(scope: TenantScopeDto, withBankAccounts: boolean): Promise<ExpenseCsvFileDto>;
  getOrganization(scope: TenantScopeDto): Promise<ExpenseOrganizationResultDto>;
  saveOrganization(scope: TenantScopeDto, input: Pick<ExpenseOrganizationDto, 'departments' | 'approverGroups'>): Promise<ExpenseOrganizationDto>;
  listEmployeeLinks(scope: TenantScopeDto, status?: ExpenseClaimStatusDto): Promise<readonly ExpenseEmployeeLinkDto[]>;
  confirmEmployeeLinks(scope: TenantScopeDto, links: readonly { readonly claimId: string; readonly employeeId: string }[]): Promise<ConfirmExpenseEmployeeLinksResultDto>;
  approvalFlow(scope: TenantScopeDto, claimId: string): Promise<ExpenseApprovalFlowViewDto>;
  previewApprovalRoute(scope: TenantScopeDto, input: ExpenseApprovalRoutePreviewInputDto): Promise<ExpenseApprovalRoutePreviewDto>;
}

function send(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function withQuery(scope: TenantScopeDto, entries: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const query = scopeQuery(scope);
  for (const [key, value] of Object.entries(entries)) if (value !== undefined && value !== '') query.set(key, String(value));
  return query.toString();
}

export function expensePeopleApi(transport: ApiTransport): ExpensePeopleApi {
  const employeePath = (id: string) => `/expense/employees/${encodeURIComponent(id)}`;
  return {
    async me(scope) {
      return (await transport.request<{ me: ExpenseMeDto }>(`/expense/me?${scopeQuery(scope).toString()}`)).me;
    },
    async readiness(scope) {
      return (await transport.request<{ readiness: ExpensePeopleReadinessDto }>(`/expense/people/readiness?${scopeQuery(scope).toString()}`)).readiness;
    },
    async listEmployees(scope, filter = {}) {
      return (await transport.request<{ employees: readonly ExpenseEmployeeDto[] }>(`/expense/employees?${withQuery(scope, {
        query: filter.query, departmentId: filter.departmentId, enabled: filter.enabled, limit: filter.limit,
      })}`)).employees;
    },
    async getEmployee(scope, id) {
      return (await transport.request<{ employee: ExpenseEmployeeDto }>(`${employeePath(id)}?${scopeQuery(scope).toString()}`)).employee;
    },
    async createEmployee(scope, input) {
      return (await transport.request<{ employee: ExpenseEmployeeDto }>('/expense/employees', send('POST', { scope, ...input }))).employee;
    },
    async updateEmployee(scope, id, input) {
      return (await transport.request<{ employee: ExpenseEmployeeDto }>(employeePath(id), send('PUT', { scope, ...input }))).employee;
    },
    async importEmployeesCsv(scope, content) {
      return (await transport.request<{ result: ImportExpenseEmployeesResultDto }>('/expense/employees/import', send('POST', { scope, content }))).result;
    },
    async exportEmployeesCsv(scope, withBankAccounts) {
      return transport.request<ExpenseCsvFileDto>(`/expense/employees/${withBankAccounts ? 'export-bank-accounts' : 'export'}?${scopeQuery(scope).toString()}`);
    },
    async getOrganization(scope) {
      return transport.request<ExpenseOrganizationResultDto>(`/expense/organization?${scopeQuery(scope).toString()}`);
    },
    async saveOrganization(scope, input) {
      return (await transport.request<{ organization: ExpenseOrganizationDto }>('/expense/organization', send('PUT', { scope, departments: input.departments, approverGroups: input.approverGroups }))).organization;
    },
    async listEmployeeLinks(scope, status) {
      return (await transport.request<{ links: readonly ExpenseEmployeeLinkDto[] }>(`/expense/claims/employee-links?${withQuery(scope, { status })}`)).links;
    },
    async confirmEmployeeLinks(scope, links) {
      return (await transport.request<{ result: ConfirmExpenseEmployeeLinksResultDto }>('/expense/claims/employee-links', send('POST', { scope, links }))).result;
    },
    async approvalFlow(scope, claimId) {
      return transport.request<ExpenseApprovalFlowViewDto>(`/expense/claims/${encodeURIComponent(claimId)}/approval-flow?${scopeQuery(scope).toString()}`);
    },
    async previewApprovalRoute(scope, input) {
      return (await transport.request<{ result: ExpenseApprovalRoutePreviewDto }>('/expense/approval-routes/preview', send('POST', { scope, ...input }))).result;
    },
  };
}

/**
 * 「実用機能の準備」カードの従業員・振込元（`readinessRows(policy, known)` の `known` の一部）。
 * 読めなければ未設定として扱う（準備状況は失敗ではないので、読めないことで画面を赤くしない）。
 */
export async function expensePeopleReadinessKnown(transport: ApiTransport, scope: TenantScopeDto): Promise<{ readonly employees: boolean; readonly payout: boolean }> {
  try {
    const readiness = await expensePeopleApi(transport).readiness(scope);
    return { employees: readiness.employees.configured, payout: readiness.payout.configured };
  } catch {
    return { employees: false, payout: false };
  }
}
