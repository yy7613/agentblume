/**
 * application層: 既存の申請の申請者 → 従業員マスタの紐付け候補と、人による確定（docs/21 §20.1.1 / ADR-0043 §3。系統 A）。
 *
 * SQL で書き換えない。候補（`exact-code` / `unique-name` / `ambiguous` / `none`）を示し、押された組だけを書き込む。
 * 写しは `ClaimantResolver`（氏名・社員番号・部門名・部門 id）、遷移は骨格の `linkClaimantEmployee`
 * （`draft` / `checked` / `returned` は編集扱いで `draft` へ、`approved` / `settled` は参照 id だけ、`in-approval` は不可）。
 * 1 件でも承認中の申請があれば何も書かずに 409（どの申請かを付ける。途中まで書くと、画面の選択と保存済みの状態がずれるため）。
 */
import { linkClaimantEmployee, type ClaimStatus, type ExpenseClaim } from '../../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseDomainError, ExpenseEmployeeNotFoundError, ExpenseTransitionError } from '../../../domain/expense/errors';
import { findDepartment } from '../../../domain/expense/organization';
import { employeeLinkSuggestion, type EmployeeLinkMatch } from '../../../domain/expense/people/employee-links';
import type { TenantScope } from '../../../domain/shared/tenant-scope';
import { ClaimantResolver, saveClaim } from '../manage-claims';
import type { ExpenseSystemDeps } from '../system-deps';

export const EMPLOYEE_LINKS_MAX = 500;

export interface ExpenseEmployeeLinkRow {
  readonly claimId: string;
  readonly claimant: ExpenseClaim['claimant'];
  readonly status: ClaimStatus;
  readonly match: EmployeeLinkMatch;
  readonly candidates: readonly { readonly id: string; readonly name: string; readonly code?: string; readonly department?: string }[];
}

export class ListExpenseEmployeeLinksUseCase {
  constructor(private readonly deps: ExpenseSystemDeps) {}

  async execute(scope: TenantScope, options: { readonly status?: ClaimStatus; readonly limit?: number } = {}): Promise<readonly ExpenseEmployeeLinkRow[]> {
    const [claims, employees, organization] = await Promise.all([
      this.deps.repositories.claims.list(scope, { unlinked: true, ...(options.status === undefined ? {} : { status: options.status }), limit: options.limit ?? EMPLOYEE_LINKS_MAX }),
      this.deps.repositories.employees.list(scope, { enabled: true }),
      this.deps.organization.get(scope),
    ]);
    return claims.map((claim) => {
      const suggestion = employeeLinkSuggestion(claim.claimant, employees);
      return {
        claimId: claim.id,
        claimant: claim.claimant,
        status: claim.status,
        match: suggestion.match,
        candidates: suggestion.candidates.map((candidate) => {
          const department = findDepartment(organization, candidate.departmentId)?.name;
          return { id: candidate.id, name: candidate.name, ...(candidate.code === undefined ? {} : { code: candidate.code }), ...(department === undefined ? {} : { department }) };
        }),
      };
    });
  }
}

export interface ConfirmEmployeeLinksResult {
  readonly linked: number;
  readonly movedToDraft: number;
  readonly skipped: readonly { readonly claimId: string; readonly reason: 'already-linked' }[];
}

export class ConfirmExpenseEmployeeLinksUseCase {
  private readonly claimants: ClaimantResolver;

  constructor(private readonly deps: ExpenseSystemDeps) {
    this.claimants = new ClaimantResolver(deps.employeeDirectory, deps.organization);
  }

  async execute(scope: TenantScope, links: readonly { readonly claimId: string; readonly employeeId: string }[], by: string): Promise<ConfirmEmployeeLinksResult> {
    const ids = links.map((link) => link.claimId);
    const duplicated = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicated !== undefined) throw new ExpenseDomainError(`申請 ${duplicated} が 2 回指定されています。1 つの申請には 1 人の従業員を選んでください`, undefined, { field: 'links' });

    const claims = await this.deps.repositories.claims.findByIds(scope, ids);
    const byId = new Map(claims.map((claim) => [claim.id, claim] as const));
    const missing = ids.find((id) => !byId.has(id));
    if (missing !== undefined) throw new ExpenseClaimNotFoundError(`expense claim not found: ${missing}`);
    const employeeIds = [...new Set(links.map((link) => link.employeeId))];
    const found = new Set((await this.deps.employeeDirectory.findByIds(scope, employeeIds)).map((employee) => employee.id));
    const unknown = employeeIds.find((id) => !found.has(id));
    if (unknown !== undefined) throw new ExpenseEmployeeNotFoundError(`expense employee not found: ${unknown}`);

    const inApproval = claims.filter((claim) => claim.status === 'in-approval');
    if (inApproval.length > 0) {
      throw new ExpenseTransitionError(`employee links: claims in approval cannot be linked (${inApproval.map((claim) => claim.id).join(', ')})`, {
        nextStep: '承認中の申請は申請者を紐付けられません。差し戻すか承認を取り消してから、もう一度紐付けてください（何も保存していません）',
        claims: inApproval.map((claim) => ({ id: claim.id, status: claim.status })),
      });
    }

    const at = this.deps.now().toISOString();
    const updates: ExpenseClaim[] = [];
    const skipped: { claimId: string; reason: 'already-linked' }[] = [];
    let movedToDraft = 0;
    for (const link of links) {
      const claim = byId.get(link.claimId) as ExpenseClaim;
      if (claim.claimant.employeeId === link.employeeId) { skipped.push({ claimId: claim.id, reason: 'already-linked' }); continue; }
      const resolved = await this.claimants.resolve(scope, { ...claim.claimant, employeeId: link.employeeId });
      const updated = linkClaimantEmployee(claim, {
        employeeId: link.employeeId,
        name: resolved.name,
        ...(resolved.employeeCode === undefined ? {} : { employeeCode: resolved.employeeCode }),
        ...(resolved.department === undefined ? {} : { department: resolved.department }),
        ...(resolved.departmentId === undefined ? {} : { departmentId: resolved.departmentId }),
      }, by, at);
      if (updated.status === 'draft' && claim.status !== 'draft') movedToDraft += 1;
      updates.push(updated);
    }
    await this.deps.unitOfWork.withTransaction(async () => {
      for (const claim of updates) await saveClaim(this.deps.repositories.claims, this.deps.repositories.receipts, claim);
    });
    return { linked: updates.length, movedToDraft, skipped };
  }
}
