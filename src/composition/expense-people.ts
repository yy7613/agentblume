/**
 * Composition: 経費精算「人と承認」（従業員マスタ・組織・多段承認。UC1 / UC2。系統 A）の組み立て。
 *
 * `feature` のキーは `expense` で始める（`ExpenseAppFeature` に展開され、api の `ExpensePeopleRouteDeps` を満たす）。
 * `approvalPlanner` は骨格の承認・チェック・申請の応答が使い、判定の事実（`checkFacts`）と承認の流れの表示も同じプランナーを使う。
 * エージェントの組込みツールは足さない（口座番号・通勤定期を出さない方針。`expense_claims` の列は骨格が持つ）。
 */
import { DescribeExpenseApprovalFlowUseCase, PreviewApprovalRouteUseCase } from '../application/expense/people/approval-flow';
import { PeopleApprovalPlanner } from '../application/expense/people/approval-planner';
import { PeopleCheckFactsProvider } from '../application/expense/people/check-facts';
import { ExportExpenseEmployeesCsvUseCase, ImportExpenseEmployeesCsvUseCase } from '../application/expense/people/employee-transfer';
import { ConfirmExpenseEmployeeLinksUseCase, ListExpenseEmployeeLinksUseCase } from '../application/expense/people/link-employees';
import { GetExpenseEmployeeUseCase, ListExpenseEmployeesUseCase, SaveExpenseEmployeeUseCase } from '../application/expense/people/manage-employees';
import { GetExpenseOrganizationUseCase, SaveExpenseOrganizationUseCase } from '../application/expense/people/manage-organization';
import { GetExpenseMeUseCase, GetExpensePeopleReadinessUseCase } from '../application/expense/people/me';
import type { ApprovalRoutePlanner } from '../application/expense/ports';
import type { ExpenseCoreServices, ExpenseSystemComposition } from './expense-core';

/** App のうち「人と承認」の部分。 */
export interface ExpensePeopleFeature {
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
}

export interface ExpensePeopleComposition extends ExpenseSystemComposition<ExpensePeopleFeature> {
  readonly approvalPlanner: ApprovalRoutePlanner;
}

export function composeExpensePeople(core: ExpenseCoreServices): ExpensePeopleComposition {
  const planner = new PeopleApprovalPlanner(core);
  return {
    feature: {
      expenseGetMe: new GetExpenseMeUseCase(core),
      expensePeopleReadiness: new GetExpensePeopleReadinessUseCase(core),
      expenseListEmployees: new ListExpenseEmployeesUseCase(core),
      expenseGetEmployee: new GetExpenseEmployeeUseCase(core),
      expenseSaveEmployee: new SaveExpenseEmployeeUseCase(core),
      expenseImportEmployeesCsv: new ImportExpenseEmployeesCsvUseCase(core),
      expenseExportEmployeesCsv: new ExportExpenseEmployeesCsvUseCase(core),
      expenseGetOrganization: new GetExpenseOrganizationUseCase(core),
      expenseSaveOrganization: new SaveExpenseOrganizationUseCase(core),
      expenseListEmployeeLinks: new ListExpenseEmployeeLinksUseCase(core),
      expenseConfirmEmployeeLinks: new ConfirmExpenseEmployeeLinksUseCase(core),
      expenseDescribeApprovalFlow: new DescribeExpenseApprovalFlowUseCase(core, planner),
      expensePreviewApprovalRoute: new PreviewApprovalRouteUseCase(planner),
    },
    rowSources: [],
    checkFacts: new PeopleCheckFactsProvider(core),
    approvalPlanner: planner,
  };
}
