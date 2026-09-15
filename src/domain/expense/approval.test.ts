import { describe, expect, it } from 'vitest';
import {
  currentApprovalStep, defaultApprovalSettings, flowFromPlan, isMvpApprovalPlan, mvpApprovalPlan, planFromFlow, validateApprovalDecision, validateApprovalFlow,
  validateApprovalSettings, validateApproverSpec, type ApprovalPlan,
} from './approval';
import { ExpenseDomainError } from './errors';

const AT = '2026-09-15T00:00:00.000Z';
const CATEGORIES = new Set(['meal.entertainment', 'transport.taxi']);
const step = (id: string, approver: Record<string, unknown> = { kind: 'any-approver' }) => ({ id, name: `段 ${id}`, approver, skipWhenSameAsPrevious: false });
const route = (id: string, when: Record<string, unknown>, steps = [step('s1')]) => ({ id, name: `経路 ${id}`, enabled: true, when, steps });

describe('validateApprovalSettings', () => {
  it('正常: 省略・null は既定（経路なし・1 段の any-approver・申請者本人の承認不可）', () => {
    expect(validateApprovalSettings(undefined, CATEGORIES)).toEqual(defaultApprovalSettings());
    expect(validateApprovalSettings(null, CATEGORIES).defaultSteps).toEqual([{ id: 'approve', name: '承認', approver: { kind: 'any-approver' }, skipWhenSameAsPrevious: false }]);
    expect(validateApprovalSettings({}, CATEGORIES)).toEqual(defaultApprovalSettings());
  });

  it('正常: 経路・段・承認者の種類・代理グループを検証して複製する（参照先の存在は見ない）', () => {
    const settings = validateApprovalSettings({
      routes: [
        route('big-entertainment', { categoryIds: ['meal.entertainment', 'meal.entertainment'], minClaimAmount: 50000, departmentIds: ['sales'] }, [
          step('head', { kind: 'department-head' }), step('acct', { kind: 'group', groupId: 'accounting' }),
        ]),
        route('fallback', {}, [step('boss', { kind: 'claimant-manager' }), step('named', { kind: 'employee', employeeId: 'emp-9' })]),
      ],
      defaultSteps: [step('dep', { kind: 'department-head', departmentId: 'hq' })],
      forbidClaimantApproval: false, requireDistinctApprovers: true, proxyGroupId: 'proxies',
    }, CATEGORIES);
    expect(settings.routes[0]?.when).toEqual({ categoryIds: ['meal.entertainment'], minClaimAmount: 50000, departmentIds: ['sales'] });
    expect(settings.routes[1]?.when).toEqual({ categoryIds: [], departmentIds: [] });
    expect(settings.defaultSteps[0]?.approver).toEqual({ kind: 'department-head', departmentId: 'hq' });
    expect(settings).toMatchObject({ forbidClaimantApproval: false, requireDistinctApprovers: true, proxyGroupId: 'proxies' });
  });

  it('異常: 条件なしの経路は最後にだけ置ける・経路 / 段の id の一意・段は 1〜5・規程に無い費目', () => {
    expect(() => validateApprovalSettings({ routes: [route('all', {}), route('later', { minClaimAmount: 1 })] }, CATEGORIES)).toThrow(/must be the last route/u);
    expect(() => validateApprovalSettings({ routes: [route('a', { minClaimAmount: 1 }), route('a', { minClaimAmount: 2 })] }, CATEGORIES)).toThrow(/duplicate route id/u);
    expect(() => validateApprovalSettings({ routes: [route('a', { minClaimAmount: 1 }, [step('x'), step('x')])] }, CATEGORIES)).toThrow(/duplicate step id/u);
    expect(() => validateApprovalSettings({ routes: [route('a', { minClaimAmount: 1 }, [])] }, CATEGORIES)).toThrow(/1 to 5 steps/u);
    expect(() => validateApprovalSettings({ defaultSteps: ['1', '2', '3', '4', '5', '6'].map((id) => step(id)) }, CATEGORIES)).toThrow(/1 to 5 steps/u);
    expect(() => validateApprovalSettings({ routes: [route('a', { categoryIds: ['books'] })] }, CATEGORIES)).toThrow(/not in the policy: books/u);
    expect(() => validateApprovalSettings({ routes: [route('a', { minClaimAmount: 0 })] }, CATEGORIES)).toThrow(/minClaimAmount/u);
    expect(() => validateApprovalSettings({ routes: [route('A B', { minClaimAmount: 1 })] }, CATEGORIES)).toThrow(/id must match/u);
    expect(() => validateApprovalSettings({ routes: 'x' }, CATEGORIES)).toThrow(/routes must be an array/u);
    expect(() => validateApprovalSettings([], CATEGORIES)).toThrow(/must be an object/u);
    expect(() => validateApprovalSettings({ forbidClaimantApproval: 'yes' }, CATEGORIES)).toThrow(/must be a boolean/u);
    expect(() => validateApprovalSettings({ routes: [{ ...route('a', { minClaimAmount: 1 }), when: [] }] }, CATEGORIES)).toThrow(/when must be an object/u);
  });

  it('異常: 承認者の種類と必須の参照', () => {
    expect(() => validateApproverSpec({ kind: 'boss' }, 'x')).toThrow(/kind must be one of/u);
    expect(() => validateApproverSpec({ kind: 'employee' }, 'x')).toThrow(/employeeId/u);
    expect(() => validateApproverSpec({ kind: 'group', groupId: '' }, 'x')).toThrow(/groupId/u);
    expect(() => validateApproverSpec(null, 'x')).toThrow(ExpenseDomainError);
    expect(validateApproverSpec({ kind: 'department-head', departmentId: '' }, 'x')).toEqual({ kind: 'department-head' });
  });
});

describe('計画と承認の記録', () => {
  const plan: ApprovalPlan = {
    routeId: 'r1', routeName: '部門長 → 経理 → 役員',
    steps: [
      { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e2', name: '花子' }], skipped: false },
      { stepId: 'again', name: '部門長（重複）', approverKind: 'claimant-manager', approvers: [{ employeeId: 'e2', name: '花子' }], skipped: true },
      { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'e3', name: '次郎' }], skipped: false },
    ],
    unresolved: [],
  };

  it('正常: MVP の計画は 1 段の any-approver で、経路のある計画は MVP ではない', () => {
    expect(isMvpApprovalPlan(mvpApprovalPlan())).toBe(true);
    expect(isMvpApprovalPlan(plan)).toBe(false);
    expect(isMvpApprovalPlan({ ...mvpApprovalPlan(), steps: [{ ...mvpApprovalPlan().steps[0]!, skipped: true }] })).toBe(false);
  });

  it('正常: 計画から記録を作ると、飛ばす段は skipped、現在の段は最初の pending。流れは計画の形に戻せる', () => {
    const flow = flowFromPlan(plan, AT, AT);
    expect(flow.steps.map((entry) => entry.status)).toEqual(['pending', 'skipped', 'pending']);
    expect(currentApprovalStep(flow)?.stepId).toBe('head');
    expect(validateApprovalFlow(flow)).toEqual(flow);
    expect(planFromFlow(flow)).toEqual(plan);
    const allSkipped = flowFromPlan({ ...plan, routeId: undefined, steps: plan.steps.map((entry) => ({ ...entry, skipped: true })) } as ApprovalPlan, AT, AT);
    expect(allSkipped.currentIndex).toBe(3);
    expect(currentApprovalStep(allSkipped)).toBeUndefined();
    expect(allSkipped).not.toHaveProperty('routeId');
  });

  it('異常: 段の順序の整合（承認済みは現在より前・pending は現在以降・承認済みには決裁が要る）', () => {
    const flow = flowFromPlan(plan, AT, AT);
    const decision = { by: 'hanako', at: AT, proxy: false };
    expect(() => validateApprovalFlow({ ...flow, currentIndex: 2 })).toThrow(/before the current step but still pending/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], status: 'approved', decision }, flow.steps[1], flow.steps[2]], currentIndex: 0 })).toThrow(/approved but not before the current step/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], status: 'approved' }, flow.steps[1], flow.steps[2]], currentIndex: 2 })).toThrow(/must have a decision/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], decision }, flow.steps[1], flow.steps[2]] })).toThrow(/only an approved step can have a decision/u);
    expect(() => validateApprovalFlow({ ...flow, currentIndex: 1 })).toThrow(/current step must be pending|still pending/u);
    expect(() => validateApprovalFlow({ ...flow, currentIndex: 9 })).toThrow(/currentIndex/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [] })).toThrow(/1 to 5 steps/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], approverKind: 'x' }] })).toThrow(/approverKind/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], status: 'done' }] })).toThrow(/status/u);
    expect(() => validateApprovalFlow({ ...flow, steps: [{ ...flow.steps[0], approvers: [{ employeeId: 1 }] }] })).toThrow(/employeeId, name/u);
    expect(() => validateApprovalFlow(null)).toThrow(ExpenseDomainError);
  });

  it('正常 / 異常: 決裁の記録（代理の印は必須、空の任意項目は書かない）', () => {
    expect(validateApprovalDecision({ by: 'b', at: AT, proxy: true, comment: '', employeeId: 'e1' }, 'd')).toEqual({ by: 'b', at: AT, proxy: true, employeeId: 'e1' });
    expect(() => validateApprovalDecision({ by: 'b', at: AT }, 'd')).toThrow(/proxy must be a boolean/u);
    expect(() => validateApprovalDecision({ by: 'b', at: AT, proxy: false, comment: 'x'.repeat(501) }, 'd')).toThrow(/comment/u);
    expect(() => validateApprovalDecision('x', 'd')).toThrow(/must be an object/u);
  });
});
