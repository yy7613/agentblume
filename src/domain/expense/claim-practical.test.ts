/**
 * 申請の実用化の遷移（docs/21 §20.2.3 / §20.2.12）: 段の承認・承認中の差し戻し / 取消 / 再チェック・紐付け・振込の印・支払う額。
 * MVP の遷移のテストは `claim.test.ts`（期待値を変えない）。
 */
import { describe, expect, it } from 'vitest';
import { mvpApprovalPlan, type ApprovalPlan } from './approval';
import { checkClaim } from './check';
import {
  approveClaim, approveStep, claimFingerprint, clearPayout, corporateAmount, createExpenseClaim, editClaim, linkAdvance, linkClaimantEmployee, markPayoutExported,
  markSettled, reimbursableAmount, returnClaim, toExpenseClaimSummary, unapproveClaim, withJudgment, type CreateExpenseClaimProps, type ExpenseClaim, type ExpenseItem,
} from './claim';
import { defaultExpensePolicy } from './default-policy';
import { ExpenseTransitionError } from './errors';
import { createExpensePolicy } from './policy';

const AT = '2026-09-14T00:00:00.000Z';
const T1 = '2026-09-15T00:00:00.000Z';
const T2 = '2026-09-16T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const policy = defaultExpensePolicy(AT);

function item(id = 'i1', facts: Partial<ExpenseItem['facts']> = {}): ExpenseItem {
  return { id, categoryId: 'transport.public', facts: { transactionDate: '2026-09-10', payeeName: '東京メトロ', amount: 420, purpose: '客先訪問', ...facts }, source: { type: 'manual' }, extraction: { method: 'manual', warnings: [] } };
}

function draft(overrides: Partial<CreateExpenseClaimProps> = {}): ExpenseClaim {
  return createExpenseClaim({ tenant, id: 'c1', claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [item()], history: [], submittedBy: 'keiri', createdAt: AT, updatedAt: AT, ...overrides });
}

function checked(claim: ExpenseClaim = draft()): ExpenseClaim {
  const judgment = checkClaim({ claim, policy, policySaved: true, duplicateCandidates: [], today: '2026-09-30' });
  return withJudgment(claim, { ...judgment, policyUpdatedAt: policy.updatedAt, itemsFingerprint: claimFingerprint(claim), checkedAt: AT }, AT);
}

const twoSteps: ApprovalPlan = {
  routeId: 'r1', routeName: '部門長 → 経理',
  steps: [
    { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e2', name: '花子' }], skipped: false },
    { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'e3', name: '次郎' }], skipped: false },
  ],
  unresolved: [],
};

function rejection(run: () => unknown): ExpenseTransitionError {
  try { run(); } catch (error) { if (error instanceof ExpenseTransitionError) return error; throw error; }
  throw new Error('expected an ExpenseTransitionError');
}

describe('approveStep（段の承認）', () => {
  it('正常: MVP の計画は MVP の approveClaim と同じ記録になる（approvalFlow を書かない）', () => {
    const claim = checked();
    expect(approveStep(claim, policy, mvpApprovalPlan(), [], 'boss', T1, { comment: 'OK', displayName: '上司' })).toEqual(approveClaim(claim, policy, 'boss', T1, { comment: 'OK', displayName: '上司' }));
  });

  it('正常: 2 段の経路は 1 段目で in-approval に写し、2 段目で approved になる。流れは往復できる', () => {
    const first = approveStep(checked(), policy, twoSteps, [], 'hanako', T1, { employeeId: 'e2', comment: '部門として承認' });
    expect(first.status).toBe('in-approval');
    expect(first.approvalFlow).toMatchObject({ routeId: 'r1', currentIndex: 1, policyUpdatedAt: AT, steps: [{ status: 'approved', decision: { by: 'hanako', employeeId: 'e2', proxy: false, comment: '部門として承認' } }, { status: 'pending' }] });
    expect(first.history.at(-1)).toMatchObject({ type: 'approval-step', note: '部門長: 部門として承認' });
    expect(toExpenseClaimSummary(first).currentStep).toEqual({ stepId: 'acct', name: '経理', approvers: [{ employeeId: 'e3', name: '次郎' }] });
    const second = approveStep(first, policy, mvpApprovalPlan(), [], 'single-user', T2, { stepId: 'acct', proxy: true, comment: '次郎さんの代わりに' });
    expect(second).toMatchObject({ status: 'approved', approval: { by: 'single-user', comment: '次郎さんの代わりに' }, approvalFlow: { currentIndex: 2 } });
    expect(second.history.at(-1)).toMatchObject({ type: 'approved', proxy: true });
    expect(createExpenseClaim(second)).toEqual(second);
    expect(toExpenseClaimSummary(second).currentStep).toBeUndefined();
  });

  it('正常: 飛ばす段は越えて進み、全段を飛ばす計画は 1 回で承認済みになる', () => {
    const skipping: ApprovalPlan = { ...twoSteps, steps: [twoSteps.steps[0]!, { ...twoSteps.steps[1]!, skipped: true }] };
    expect(approveStep(checked(), policy, skipping, [], 'hanako', T1).status).toBe('approved');
    const none: ApprovalPlan = { ...twoSteps, steps: twoSteps.steps.map((entry) => ({ ...entry, skipped: true })) };
    const approved = approveStep(checked(), policy, none, [], 'hanako', T1);
    expect(approved).toMatchObject({ status: 'approved', approvalFlow: { currentIndex: 2 } });
  });

  it('異常: 未解決の段・操作者の拒否理由・段の食い違い・代理でコメントなしは、全部並べて 409', () => {
    const unresolved: ApprovalPlan = { ...twoSteps, unresolved: [{ stepId: 'head', stepName: '部門長', cause: 'department-head-missing', params: { department: '営業部' } }] };
    const error = rejection(() => approveStep(checked(), policy, unresolved, [{ code: 'approval-not-current-approver' }], 'x', T1, { stepId: 'acct', proxy: true }));
    expect(error.blockingReasons.map((entry) => entry.code)).toEqual(['approval-route-unresolved', 'approval-step-changed', 'approval-not-current-approver', 'approval-proxy-comment-missing']);
    expect(error.blockingReasons[0]?.params).toMatchObject({ routeName: '部門長 → 経理', stepName: '部門長', cause: 'department-head-missing', department: '営業部' });
    expect(error.nextStep).toContain('承認者が決まりません');
  });

  it('異常: 判定の前提（MVP の拒否条件）は段の承認でも効き、チェック前・承認済みは断る', () => {
    expect(rejection(() => approveStep(draft(), policy, twoSteps, [], 'x', T1)).nextStep).toContain('チェック');
    const stale = { ...checked(), items: [item('i1', { amount: 999 })] };
    expect(rejection(() => approveStep(stale, policy, twoSteps, [], 'x', T1)).blockingReasons).toEqual([{ code: 'judgment-stale' }]);
    const approved = approveClaim(checked(), policy, 'x', T1);
    expect(rejection(() => approveStep(approved, policy, twoSteps, [], 'x', T2)).nextStep).toContain('承認済み');
    for (const code of ['approval-actor-unlinked', 'approval-claimant-self', 'approval-same-approver'] as const) {
      expect(rejection(() => approveStep(checked(), policy, twoSteps, [{ code }], 'x', T1)).nextStep).not.toBe('');
    }
  });
});

describe('承認中の差し戻し・承認取消・再チェック・編集', () => {
  const inApproval = (): ExpenseClaim => approveStep(checked(), policy, twoSteps, [], 'hanako', T1, { employeeId: 'e2' });

  it('正常: どの段からでも差し戻せ、段の承認を捨てる', () => {
    const returned = returnClaim(inApproval(), '領収書を付けてください', 'jiro', T2);
    expect(returned.status).toBe('returned');
    expect(returned).not.toHaveProperty('approvalFlow');
  });

  it('正常: 承認取消は全段を捨てて checked、再チェックも段の承認を捨てる', () => {
    const unapproved = unapproveClaim(inApproval(), 'jiro', T2, '経路を見直す');
    expect(unapproved).toMatchObject({ status: 'checked' });
    expect(unapproved).not.toHaveProperty('approvalFlow');
    const claim = inApproval();
    const rechecked = withJudgment(claim, claim.judgment!, T2);
    expect(rechecked.status).toBe('checked');
    expect(rechecked).not.toHaveProperty('approvalFlow');
  });

  it('異常: 承認中は編集できず、承認取消は振込バッチ・仮払の精算で断る', () => {
    expect(rejection(() => editClaim(inApproval(), { title: 'x' }, 'keiri', T2)).nextStep).toContain('承認中は編集できません');
    const exported = markPayoutExported(approveClaim(checked(), policy, 'boss', T1), 'batch-1', T1);
    expect(rejection(() => unapproveClaim(exported, 'boss', T2, '誤り')).nextStep).toContain('振込データ batch-1');
    expect(rejection(() => unapproveClaim(approveClaim(checked(draft({ advanceId: 'adv-1' })), policy, 'boss', T1), 'boss', T2, '誤り', { advanceSettled: true })).nextStep).toContain('仮払 adv-1 で精算済み');
  });
});

describe('従業員・仮払の紐付けと振込の印', () => {
  const link = { employeeId: 'emp-1', name: 'テスト 太郎', employeeCode: 'E001', department: '営業部', departmentId: 'sales' };

  it('正常: draft / checked / returned は写しを入れ替えて draft へ戻す', () => {
    const linked = linkClaimantEmployee(checked(), link, 'keiri', T1);
    expect(linked).toMatchObject({ status: 'draft', claimant: link });
    expect(linked).not.toHaveProperty('judgment');
    expect(linked.history.at(-1)).toMatchObject({ type: 'employee-linked', note: 'emp-1' });
  });

  it('正常: 承認済み・精算済みは状態と判定を変えずに参照 id だけを足す（判定は古くならない）', () => {
    const approved = approveClaim(checked(), policy, 'boss', T1);
    const linked = linkClaimantEmployee(approved, link, 'keiri', T2);
    expect(linked).toMatchObject({ status: 'approved', claimant: { name: 'テスト太郎', employeeId: 'emp-1', departmentId: 'sales' } });
    expect(linked.judgment).toEqual(approved.judgment);
    expect(claimFingerprint(linked)).toBe(claimFingerprint(approved));
    expect(linkClaimantEmployee(markSettled(approved, 'keiri', T2), { employeeId: 'emp-1', name: 'x' }, 'keiri', T2).status).toBe('settled');
  });

  it('異常: 承認中は紐付けられない', () => {
    const inApproval = approveStep(checked(), policy, twoSteps, [], 'hanako', T1);
    expect(rejection(() => linkClaimantEmployee(inApproval, link, 'keiri', T2)).nextStep).toContain('承認中の申請は申請者を紐付けられません');
  });

  it('正常: 仮払の紐付け・外しは draft へ戻して履歴に残し、同じ値なら何もしない。承認済みは断る', () => {
    const linked = linkAdvance(checked(), { id: 'adv-1' }, 'keiri', T1);
    expect(linked).toMatchObject({ status: 'draft', advanceId: 'adv-1' });
    expect(linkAdvance(linked, { id: 'adv-1' }, 'keiri', T2)).toBe(linked);
    const unlinked = linkAdvance(linked, null, 'keiri', T2);
    expect(unlinked).not.toHaveProperty('advanceId');
    expect(unlinked.history.at(-1)).toMatchObject({ type: 'advance-unlinked', note: 'adv-1' });
    expect(() => linkAdvance(approveClaim(checked(), policy, 'boss', T1), { id: 'adv-1' }, 'keiri', T2)).toThrow(ExpenseTransitionError);
  });

  it('正常 / 異常: 振込の印は承認済みにだけ付き、別のバッチには入れず、取消で外れる', () => {
    const approved = approveClaim(checked(), policy, 'boss', T1);
    const exported = markPayoutExported(approved, 'batch-1', T1);
    expect(exported.payout).toEqual({ batchId: 'batch-1', exportedAt: T1 });
    expect(markPayoutExported(exported, 'batch-1', T2)).toBe(exported);
    expect(rejection(() => markPayoutExported(exported, 'batch-2', T2)).nextStep).toContain('batch-1');
    expect(rejection(() => markPayoutExported(checked(), 'batch-1', T1)).nextStep).toContain('承認済み');
    expect(clearPayout(exported, 'batch-2', T2)).toBe(exported);
    const cleared = clearPayout(exported, 'batch-1', T2);
    expect(cleared).not.toHaveProperty('payout');
    expect(cleared.history.at(-1)).toMatchObject({ type: 'payout-cancelled', note: 'batch-1' });
    expect(toExpenseClaimSummary(exported).payoutBatchId).toBe('batch-1');
  });
});

describe('reimbursableAmount / corporateAmount（§20.2.3）', () => {
  const claim = draft({ items: [item('i1', { amount: 1000 }), item('i2', { amount: 500, corporatePayment: true }), item('i3', { amount: 0 })] });

  it('境界: フラグ off（既定）なら合計と同じ、on なら会社払いを除く', () => {
    expect(reimbursableAmount(claim, policy)).toBe(1500);
    expect(corporateAmount(claim, policy)).toBe(0);
    const accepting = createExpensePolicy({ ...policy, card: { ...policy.card, acceptCorporatePaymentItems: true } });
    expect(reimbursableAmount(claim, accepting)).toBe(1000);
    expect(corporateAmount(claim, accepting)).toBe(500);
    expect(toExpenseClaimSummary(claim).corporatePaymentAmount).toBe(500);
  });
});
