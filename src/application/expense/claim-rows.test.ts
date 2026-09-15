import { beforeEach, describe, expect, it } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { EXPENSE_CLAIMS_COLUMNS } from '../../domain/etl/nodes/expense-claims-source';
import type { ApprovalPlan } from '../../domain/expense/approval';
import { approveStep, claimFingerprint, toExpenseClaimSummary, withJudgment, type ExpenseClaim } from '../../domain/expense/claim';
import { createExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseClaimListOptions } from '../../domain/expense/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { EXPENSE_CLAIM_ROWS_DEFAULT_LIMIT, ExpenseClaimRowsProvider, expenseClaimRow } from './claim-rows';

class RecordingClaimRepository extends InMemoryExpenseClaimRepository {
  readonly listOptions: (ExpenseClaimListOptions | undefined)[] = [];
  override async list(target: TenantScope, options?: ExpenseClaimListOptions) {
    this.listOptions.push(options);
    return super.list(target, options);
  }
}

function checked(): ExpenseClaim {
  const claim = claimFixture('c1', { title: '9 月' });
  return withJudgment(claim, {
    verdict: 'returned', items: [{ itemId: 'item-1', verdict: 'returned', reasons: [{ code: 'receipt-missing', severity: 'return', itemId: 'item-1', params: {} }, { code: 'purpose-missing', severity: 'review', itemId: 'item-1', params: {} }] }],
    claimReasons: [], totals: { amount: 3200, byCategory: [] }, searchKeysComplete: true, policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(claim), checkedAt: AT,
  }, AT);
}

describe('expenseClaimRow', () => {
  it('正常: 列の並びは EXPENSE_CLAIMS_SCHEMA と同じで、要約の値を写す', () => {
    const row = expenseClaimRow(toExpenseClaimSummary(checked()));
    expect(Object.keys(row)).toEqual([...EXPENSE_CLAIMS_COLUMNS]);
    expect(row).toMatchObject({
      claim_id: 'c1', claimant: 'テスト太郎', employee_code: 'E001', department: '営業部', period_from: '2026-09-01', period_to: '2026-09-30', title: '9 月',
      status: 'checked', verdict: 'returned', stale: false, item_count: 1, total_amount: 3200, return_count: 1, review_count: 1, acknowledged_count: 0,
      approved_by: null, approved_at: null, settled_at: null, journal_linked: 'none', top_reasons: 'purpose-missing / receipt-missing', updated_at: AT,
    });
  });

  it('境界: 未チェック・申請者の任意項目なしは null', () => {
    const row = expenseClaimRow(toExpenseClaimSummary(claimFixture('c2', { claimant: { name: '花子' } })));
    expect(row).toMatchObject({ employee_code: null, department: null, title: null, verdict: null, top_reasons: '' });
  });
});

describe('ExpenseClaimRowsProvider', () => {
  let claims: RecordingClaimRepository;
  let policies: InMemoryExpensePolicyRepository;

  beforeEach(async () => {
    claims = new RecordingClaimRepository();
    policies = new InMemoryExpensePolicyRepository();
    await claims.save(checked(), new Map());
    await claims.save(claimFixture('c2', { createdAt: '2026-09-15T00:00:00.000Z' }), new Map());
  });

  it('正常: 省略時は既定の件数上限で全状態を読む', async () => {
    const rows = await new ExpenseClaimRowsProvider(claims, policies).rows(scope);
    expect(rows.map((row) => row['claim_id'])).toEqual(['c2', 'c1']);
    expect(claims.listOptions).toEqual([{ limit: EXPENSE_CLAIM_ROWS_DEFAULT_LIMIT }]);
  });

  it('正常: status と limit を渡す', async () => {
    const rows = await new ExpenseClaimRowsProvider(claims, policies).rows(scope, { status: 'checked', limit: 1 });
    expect(rows.map((row) => row['claim_id'])).toEqual(['c1']);
    expect(claims.listOptions).toEqual([{ status: 'checked', limit: 1 }]);
  });

  it('異常: 規程を保存し直すと stale は規程の版との比較まで含める', async () => {
    await policies.save(scope, policyFixture('2026-09-20T00:00:00.000Z'));
    const [row] = await new ExpenseClaimRowsProvider(claims, policies).rows(scope, { status: 'checked' });
    expect(row!['stale']).toBe(true);
  });
});

describe('expenseClaimRow: 実用化の列（§20.11）', () => {
  const plan: ApprovalPlan = {
    routeId: 'r1', routeName: '部門長 → 経理 → 最終', unresolved: [],
    steps: [
      { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'emp-hanako', name: 'テスト花子' }], skipped: false },
      { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'emp-jiro', name: 'テスト次郎' }, { employeeId: 'emp-saburo', name: 'テスト三郎' }], skipped: false },
      { stepId: 'final', name: '最終', approverKind: 'any-approver', approvers: [], skipped: false },
    ],
  };
  const linked = (): ExpenseClaim => {
    const claim = claimFixture('c3', {
      claimant: { name: 'テスト太郎', employeeCode: 'E001', department: '営業部', employeeId: 'emp-taro', departmentId: 'dept-sales' }, advanceId: 'adv-1',
      items: [itemFixture('item-1', { amount: 3200 }), itemFixture('item-2', { amount: 1000, corporatePayment: true, paymentMethod: 'credit_card' })],
    });
    return withJudgment(claim, { verdict: 'pass', items: [], claimReasons: [], totals: { amount: 4200, byCategory: [] }, searchKeysComplete: true, policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(claim), checkedAt: AT }, AT);
  };
  const accepting = () => {
    const base = policyFixture(AT);
    return createExpensePolicy({ ...base, card: { ...base.card, acceptCorporatePaymentItems: true } });
  };

  it('正常: 従業員・部門・仮払の id を写し、承認中は現在の段と承認者の名前（、区切り）を出す。承認者を持たない段は null', () => {
    const first = approveStep(linked(), policyFixture(AT), plan, [], 'hanako', AT, { employeeId: 'emp-hanako' });
    expect(expenseClaimRow(toExpenseClaimSummary(first))).toMatchObject({ employee_id: 'emp-taro', department_id: 'dept-sales', advance_id: 'adv-1', total_amount: 4200, status: 'in-approval', current_step: '経理', current_approvers: 'テスト次郎、テスト三郎' });
    const second = approveStep(first, policyFixture(AT), plan, [], 'jiro', AT, { employeeId: 'emp-jiro' });
    expect(expenseClaimRow(toExpenseClaimSummary(second))).toMatchObject({ current_step: '最終', current_approvers: null });
  });

  it('境界: 承認中でない申請・紐付けの無い申請の新しい列は null、支払う額は合計', () => {
    expect(expenseClaimRow(toExpenseClaimSummary(claimFixture('c2')))).toMatchObject({ employee_id: null, department_id: null, advance_id: null, current_step: null, current_approvers: null, reimbursable_amount: 3200 });
  });

  it('正常: reimbursable_amount は規程のフラグが on のときだけ会社払いを除く（規程を渡さない・off なら合計）', () => {
    const summary = toExpenseClaimSummary(linked());
    expect(expenseClaimRow(summary)['reimbursable_amount']).toBe(4200);
    expect(expenseClaimRow(summary, policyFixture(AT))['reimbursable_amount']).toBe(4200);
    expect(expenseClaimRow(summary, accepting())['reimbursable_amount']).toBe(3200);
  });

  it('正常: ExpenseClaimRowsProvider は保存済みの規程のフラグで支払う額を出す', async () => {
    const claims = new InMemoryExpenseClaimRepository();
    const policies = new InMemoryExpensePolicyRepository();
    await claims.save(linked(), new Map());
    await policies.save(scope, accepting());
    const [row] = await new ExpenseClaimRowsProvider(claims, policies).rows(scope);
    expect(row).toMatchObject({ claim_id: 'c3', total_amount: 4200, reimbursable_amount: 3200, stale: false });
  });
});
