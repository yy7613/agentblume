/**
 * api層: 経費精算「人と承認（従業員・組織・紐付け候補・承認の流れ。docs/21 §20.9.2）」のルート。
 *
 * `expense-routes.ts` の `registerExpenseRoutes` が呼び、`ExpenseRouteDeps` はこの deps を extends する（ADR-0039 と同じ登録点を業務の内側に置いた）。
 * 認可は `expense-people-authorization.ts` に全ルートを載せる（`authorization.test.ts` の網羅テストが検査する）。
 * 口座番号は応答に含めない（`maskEmployee`。例外は口座つき従業員 CSV の出力だけで、approve 権限と監査を要る）。操作者は `expense-actor.ts` の `expenseActorOf`。
 * 監査の詳細には従業員 id・件数だけを載せ、氏名・口座は載せない。
 *
 * §20.9.2 の 13 本に、画面のために 2 本を足した: `GET /expense/people/readiness`（「実用機能の準備」カードの従業員・振込元の状況）と
 * `POST /expense/approval-routes/preview`（規程タブの経路の試算。保存していない承認設定を解決する）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DescribeExpenseApprovalFlowUseCase, PreviewApprovalRouteUseCase } from '../application/expense/people/approval-flow';
import type { ExportExpenseEmployeesCsvUseCase, ImportExpenseEmployeesCsvUseCase } from '../application/expense/people/employee-transfer';
import type { ConfirmExpenseEmployeeLinksUseCase, ListExpenseEmployeeLinksUseCase } from '../application/expense/people/link-employees';
import type { ExpenseEmployeeInput, GetExpenseEmployeeUseCase, ListExpenseEmployeesUseCase, SaveExpenseEmployeeUseCase } from '../application/expense/people/manage-employees';
import type { GetExpenseOrganizationUseCase, SaveExpenseOrganizationUseCase } from '../application/expense/people/manage-organization';
import type { GetExpenseMeUseCase, GetExpensePeopleReadinessUseCase } from '../application/expense/people/me';
import type { EmployeeDirectoryPort } from '../application/expense/ports';
import { principalOf, scopeOf } from './authentication';
import { recordAuditDetail } from './authorization';
import { expenseActorOf } from './expense-actor';
import {
  confirmExpenseEmployeeLinksBodySchema, expenseEmployeeLinksQuerySchema, expenseEmployeeListQuerySchema, importExpenseEmployeesBodySchema,
  previewApprovalRouteBodySchema, saveExpenseEmployeeBodySchema, saveExpenseOrganizationBodySchema,
} from './expense-people-schemas';
import { BadRequestError } from './error-mapping';
import { scopeQuerySchema } from './schemas';

/** 使うユースケース（composition の `ExpensePeopleFeature` が満たす）。 */
export interface ExpensePeopleRouteDeps {
  readonly expenseGetMe: GetExpenseMeUseCase;
  readonly expensePeopleReadiness: GetExpensePeopleReadinessUseCase;
  readonly expenseListEmployees: ListExpenseEmployeesUseCase;
  readonly expenseGetEmployee: GetExpenseEmployeeUseCase;
  readonly expenseSaveEmployee: SaveExpenseEmployeeUseCase;
  readonly expenseImportEmployeesCsv: ImportExpenseEmployeesCsvUseCase;
  readonly expenseExportEmployeesCsv: ExportExpenseEmployeesCsvUseCase;
  readonly expenseGetOrganization: GetExpenseOrganizationUseCase;
  readonly expenseSaveOrganization: SaveExpenseOrganizationUseCase;
  readonly expenseListEmployeeLinks: ListExpenseEmployeeLinksUseCase;
  readonly expenseConfirmEmployeeLinks: ConfirmExpenseEmployeeLinksUseCase;
  readonly expenseDescribeApprovalFlow: DescribeExpenseApprovalFlowUseCase;
  readonly expensePreviewApprovalRoute: PreviewApprovalRouteUseCase;
  /** 操作者の従業員を引く（骨格の `ExpenseRouteDeps` と同じキー）。 */
  readonly expenseEmployeeDirectory?: EmployeeDirectoryPort;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

/** 本文 → ユースケースの入力（未定義のキーを作らない）。 */
function employeeInput(body: z.infer<typeof saveExpenseEmployeeBodySchema>): ExpenseEmployeeInput {
  const { scope: _scope, ...rest } = body;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) as unknown as ExpenseEmployeeInput;
}

export function registerExpensePeopleRoutes(app: FastifyInstance, deps: ExpensePeopleRouteDeps): void {
  app.get('/expense/me', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
    return { me: await deps.expenseGetMe.execute(scopeOf(request), actor) };
  });

  app.get('/expense/people/readiness', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    return { readiness: await deps.expensePeopleReadiness.execute(scopeOf(request)) };
  });

  /* 従業員 ---------------------------------------------------------------- */

  app.get('/expense/employees', async (request) => {
    const query = parseWith(expenseEmployeeListQuerySchema, request.query, 'invalid query');
    const employees = await deps.expenseListEmployees.execute(scopeOf(request), {
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(query.departmentId === undefined ? {} : { departmentId: query.departmentId }),
      ...(query.enabled === undefined ? {} : { enabled: query.enabled === 'true' }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
    return { employees };
  });

  app.post('/expense/employees', async (request) => {
    const body = parseWith(saveExpenseEmployeeBodySchema, request.body, 'invalid body');
    const employee = await deps.expenseSaveEmployee.create(scopeOf(request), employeeInput(body), principalOf(request).subject);
    recordAuditDetail(request, { employeeId: employee.id });
    return { employee };
  });

  // 静的パスを :id より先に登録する。
  app.get('/expense/employees/export', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    const exported = await deps.expenseExportEmployeesCsv.execute(scopeOf(request), { withBankAccounts: false });
    recordAuditDetail(request, { count: exported.count, withBankAccounts: false });
    return { content: exported.content, fileName: exported.fileName };
  });

  app.get('/expense/employees/export-bank-accounts', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    const exported = await deps.expenseExportEmployeesCsv.execute(scopeOf(request), { withBankAccounts: true });
    recordAuditDetail(request, { count: exported.count, withBankAccounts: true });
    return { content: exported.content, fileName: exported.fileName };
  });

  app.post('/expense/employees/import', async (request) => {
    const body = parseWith(importExpenseEmployeesBodySchema, request.body, 'invalid body');
    const result = await deps.expenseImportEmployeesCsv.execute(scopeOf(request), body.content, principalOf(request).subject);
    recordAuditDetail(request, { created: result.created, updated: result.updated, skipped: result.skippedRows.length });
    return { result };
  });

  app.get<{ Params: { id: string } }>('/expense/employees/:id', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    return { employee: await deps.expenseGetEmployee.execute(scopeOf(request), request.params.id) };
  });

  app.put<{ Params: { id: string } }>('/expense/employees/:id', async (request) => {
    const body = parseWith(saveExpenseEmployeeBodySchema, request.body, 'invalid body');
    const employee = await deps.expenseSaveEmployee.update(scopeOf(request), request.params.id, employeeInput(body), principalOf(request).subject);
    recordAuditDetail(request, { employeeId: employee.id });
    return { employee };
  });

  /* 組織 ------------------------------------------------------------------ */

  app.get('/expense/organization', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    return deps.expenseGetOrganization.execute(scopeOf(request));
  });

  app.put('/expense/organization', async (request) => {
    const body = parseWith(saveExpenseOrganizationBodySchema, request.body, 'invalid body');
    const organization = await deps.expenseSaveOrganization.execute(scopeOf(request), body as unknown as Parameters<SaveExpenseOrganizationUseCase['execute']>[1]);
    recordAuditDetail(request, { departments: organization.departments.length, approverGroups: organization.approverGroups.length });
    return { organization };
  });

  /* 紐付け候補 ------------------------------------------------------------ */

  app.get('/expense/claims/employee-links', async (request) => {
    const query = parseWith(expenseEmployeeLinksQuerySchema, request.query, 'invalid query');
    return { links: await deps.expenseListEmployeeLinks.execute(scopeOf(request), query.status === undefined ? {} : { status: query.status }) };
  });

  app.post('/expense/claims/employee-links', async (request) => {
    const body = parseWith(confirmExpenseEmployeeLinksBodySchema, request.body, 'invalid body');
    const result = await deps.expenseConfirmEmployeeLinks.execute(scopeOf(request), body.links, principalOf(request).subject);
    recordAuditDetail(request, { linked: result.linked, movedToDraft: result.movedToDraft });
    return { result };
  });

  /* 承認の流れ ------------------------------------------------------------ */

  app.get<{ Params: { id: string } }>('/expense/claims/:id/approval-flow', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    const actor = await expenseActorOf(request, deps.expenseEmployeeDirectory);
    return deps.expenseDescribeApprovalFlow.execute(scopeOf(request), request.params.id, actor);
  });

  app.post('/expense/approval-routes/preview', async (request) => {
    const body = parseWith(previewApprovalRouteBodySchema, request.body, 'invalid body');
    const subject = Object.fromEntries(Object.entries(body.subject).filter(([, value]) => value !== undefined)) as unknown as Parameters<PreviewApprovalRouteUseCase['execute']>[1]['subject'];
    return { result: await deps.expensePreviewApprovalRoute.execute(scopeOf(request), { approval: body.approval, policyCategoryIds: body.policyCategoryIds, subject }) };
  });
}
