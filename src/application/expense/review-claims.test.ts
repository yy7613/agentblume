import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AT, claimFixture, itemFixture, policyFixture, scope } from '../../adapters/storage/expense-repository.fixtures';
import { advanceFixture } from '../../adapters/storage/expense-v9.fixtures';
import { InMemoryExpenseAdvanceRepository } from '../../adapters/storage/in-memory-expense-money-repositories';
import { InMemoryExpenseClaimRepository, InMemoryExpensePolicyRepository, InMemoryExpenseReceiptRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { currentApprovalStep, flowFromPlan, mvpApprovalPlan, planFromFlow, type ApprovalPlan } from '../../domain/expense/approval';
import { acknowledge, approveStep, claimFingerprint, withJudgment, type ExpenseClaim } from '../../domain/expense/claim';
import { ExpenseClaimNotFoundError, ExpenseTransitionError } from '../../domain/expense/errors';
import { verdictOf, type CheckReason } from '../../domain/expense/judgment';
import { createExpensePolicy } from '../../domain/expense/policy';
import type { ExpenseReasonCode } from '../../domain/expense/reason-codes';
import type { ExpenseActor } from './actor';
import type { ApprovalActorDecision, ApprovalRoutePlanner } from './ports';
import {
  AcknowledgeExpenseReasonUseCase, ApproveExpenseClaimUseCase, DescribeExpenseApprovalUseCase, GetReturnDraftUseCase, MVP_APPROVAL_PLANNER, ReturnExpenseClaimUseCase,
  UnapproveExpenseClaimUseCase,
} from './review-claims';

const NOW = new Date('2026-09-16T00:00:00.000Z');
const reason = (code: ExpenseReasonCode, severity: 'review' | 'return', itemId?: string): CheckReason => ({ code, severity, params: {}, ...(itemId === undefined ? {} : { itemId }) });

let claims: InMemoryExpenseClaimRepository;
let receipts: InMemoryExpenseReceiptRepository;
let policies: InMemoryExpensePolicyRepository;

beforeEach(() => {
  claims = new InMemoryExpenseClaimRepository();
  receipts = new InMemoryExpenseReceiptRepository();
  policies = new InMemoryExpensePolicyRepository();
});

function checked(reasons: readonly CheckReason[], items = [itemFixture('item-1'), itemFixture('item-2', { description: '会議費' })]): ExpenseClaim {
  const claim = claimFixture('c1', { items });
  return withJudgment(claim, {
    verdict: verdictOf(reasons),
    items: claim.items.map((item) => ({ itemId: item.id, verdict: 'pass', reasons: reasons.filter((entry) => entry.itemId === item.id) })),
    claimReasons: reasons.filter((entry) => entry.itemId === undefined),
    totals: { amount: 0, byCategory: [] }, searchKeysComplete: true, policyUpdatedAt: AT, itemsFingerprint: claimFingerprint(claim), checkedAt: AT,
  }, AT);
}

describe('AcknowledgeExpenseReasonUseCase', () => {
  it('正常: 要確認を確認済みにして保存する', async () => {
    await claims.save(checked([reason('purpose-missing', 'review', 'item-1')]), new Map());
    await new AcknowledgeExpenseReasonUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', itemId: 'item-1', code: 'purpose-missing', note: '口頭で確認', by: 'boss' });
    expect((await claims.findById(scope, 'c1'))!.acknowledgements).toEqual([{ itemId: 'item-1', code: 'purpose-missing', note: '口頭で確認', by: 'boss', at: NOW.toISOString() }]);
  });

  it('正常: 申請単位の理由（itemId なし）も確認済みにできる', async () => {
    await claims.save(checked([reason('policy-unreviewed', 'review')]), new Map());
    const updated = await new AcknowledgeExpenseReasonUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', code: 'policy-unreviewed', note: '見た', by: 'boss' });
    expect(updated.acknowledgements[0]).not.toHaveProperty('itemId');
  });

  it('異常: 差し戻し理由は 409、無い申請は 404', async () => {
    await claims.save(checked([reason('receipt-missing', 'return', 'item-1')]), new Map());
    const useCase = new AcknowledgeExpenseReasonUseCase(claims, receipts, () => NOW);
    await expect(useCase.execute({ scope, claimId: 'c1', itemId: 'item-1', code: 'receipt-missing', note: 'x', by: 'b' })).rejects.toBeInstanceOf(ExpenseTransitionError);
    await expect(useCase.execute({ scope, claimId: 'none', code: 'receipt-missing', note: 'x', by: 'b' })).rejects.toBeInstanceOf(ExpenseClaimNotFoundError);
  });
});

describe('GetReturnDraftUseCase', () => {
  it('正常: 申請者名・期間・申請 id と、明細順の番号付きの項目を並べる', async () => {
    let claim = checked([
      reason('payee-missing', 'review', 'item-2'),
      reason('receipt-missing', 'return', 'item-1'),
      reason('category-unknown', 'return', 'item-1'),
      reason('policy-unreviewed', 'review'),
      reason('purpose-missing', 'review', 'item-2'),
    ]);
    claim = acknowledge(claim, { itemId: 'item-2', code: 'purpose-missing', note: '確認済み', by: 'boss' } as never, 'boss', AT);
    await claims.save(claim, new Map());
    const text = await new GetReturnDraftUseCase(claims).execute(scope, 'c1');
    const lines = text.split('\n');
    expect(lines[0]).toBe('テスト太郎 さん');
    expect(lines[1]).toContain('2026-09-01〜2026-09-30 の経費精算（c1）を差し戻します');
    const numbered = lines.filter((line) => /^\d+\. /u.test(line));
    // 経理側の問題（category-unknown / policy-unreviewed）と確認済みの要確認（purpose-missing）は含めない
    expect(numbered).toHaveLength(2);
    expect(numbered[0]).toMatch(/^1\. 明細「タクシー代」: /u);
    expect(numbered[1]).toMatch(/^2\. 明細「会議費」: /u);
  });

  it('境界: 申請者向けの項目が無ければ書き足すよう促す', async () => {
    await claims.save(checked([reason('policy-unreviewed', 'review')]), new Map());
    expect(await new GetReturnDraftUseCase(claims).execute(scope, 'c1')).toContain('差し戻しの理由として挙げる項目がありません');
  });

  it('異常: checked 以外は 409', async () => {
    await claims.save(claimFixture('c1'), new Map());
    await expect(new GetReturnDraftUseCase(claims).execute(scope, 'c1')).rejects.toMatchObject({ nextStep: expect.stringContaining('チェック済みの申請だけ') });
  });
});

describe('ReturnExpenseClaimUseCase', () => {
  it('正常: 差し戻して文言を保存する', async () => {
    await claims.save(checked([reason('receipt-missing', 'return', 'item-1')]), new Map());
    await new ReturnExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', message: '領収書を添付してください', by: 'boss' });
    const saved = await claims.findById(scope, 'c1');
    expect(saved).toMatchObject({ status: 'returned', returnNote: { message: '領収書を添付してください', by: 'boss', reasons: [{ code: 'receipt-missing', itemId: 'item-1', severity: 'return' }] } });
  });
});

describe('ApproveExpenseClaimUseCase / UnapproveExpenseClaimUseCase', () => {
  it('異常: 承認できない理由を blockingReasons に並べて 409、保存しない', async () => {
    await claims.save(checked([reason('purpose-missing', 'review', 'item-1')]), new Map());
    const promise = new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW).execute({ scope, claimId: 'c1', by: 'boss' });
    await expect(promise).rejects.toMatchObject({ blockingReasons: [{ code: 'purpose-missing', itemId: 'item-1' }] });
    expect((await claims.findById(scope, 'c1'))!.status).toBe('checked');
  });

  it('異常: 保存し直した規程の版で判定が古ければ judgment-stale', async () => {
    await claims.save(checked([]), new Map());
    await policies.save(scope, policyFixture('2026-09-15T00:00:00.000Z'));
    await expect(new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW).execute({ scope, claimId: 'c1', by: 'boss' })).rejects.toMatchObject({ blockingReasons: [{ code: 'judgment-stale' }] });
  });

  it('正常: 承認して表示名とコメントを残し、承認取消で checked に戻す', async () => {
    await claims.save(checked([]), new Map());
    const approved = await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW).execute({ scope, claimId: 'c1', by: 'boss', displayName: '上司', comment: 'OK' });
    expect(approved.approval).toEqual({ by: 'boss', displayName: '上司', at: NOW.toISOString(), comment: 'OK' });
    expect((await claims.findById(scope, 'c1'))!.status).toBe('approved');
    const unapproved = await new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', note: '金額誤り', by: 'boss' });
    expect(unapproved.status).toBe('checked');
    expect((await claims.findById(scope, 'c1'))!.approval).toBeUndefined();
  });

  it('正常: 表示名・コメントを省略した承認', async () => {
    await claims.save(checked([]), new Map());
    const approved = await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW).execute({ scope, claimId: 'c1', by: 'boss' });
    expect(approved.approval).toEqual({ by: 'boss', at: NOW.toISOString() });
  });

  it('異常: 承認されていない申請の承認取消は 409', async () => {
    await claims.save(checked([]), new Map());
    await expect(new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', note: 'x', by: 'b' })).rejects.toBeInstanceOf(ExpenseTransitionError);
  });
});

describe('既定の時刻', () => {
  it('正常: now を省略すると現在時刻で確認済み・承認・承認取消・差し戻しを記録する', async () => {
    const before = Date.now();
    await claims.save(checked([reason('purpose-missing', 'review', 'item-1')]), new Map());
    const acked = await new AcknowledgeExpenseReasonUseCase(claims, receipts).execute({ scope, claimId: 'c1', itemId: 'item-1', code: 'purpose-missing', note: 'ok', by: 'boss' });
    expect(Date.parse(acked.acknowledgements[0]!.at)).toBeGreaterThanOrEqual(before);
    const approved = await new ApproveExpenseClaimUseCase(claims, receipts, policies).execute({ scope, claimId: 'c1', by: 'boss' });
    expect(Date.parse(approved.approval!.at)).toBeGreaterThanOrEqual(before);
    const unapproved = await new UnapproveExpenseClaimUseCase(claims, receipts).execute({ scope, claimId: 'c1', note: '見直し', by: 'boss' });
    expect(Date.parse(unapproved.updatedAt)).toBeGreaterThanOrEqual(before);
    const returned = await new ReturnExpenseClaimUseCase(claims, receipts).execute({ scope, claimId: 'c1', message: '直してください', by: 'boss' });
    expect(Date.parse(returned.returnNote!.at)).toBeGreaterThanOrEqual(before);
  });
});

/* ---------------------------------------------------------------------------
 * 実用化（§20.2.12）: 段の承認・承認取消の仮払・承認の見通し
 * ------------------------------------------------------------------------- */

const LATER = new Date('2026-09-17T00:00:00.000Z');

const twoSteps: ApprovalPlan = {
  routeId: 'r1', routeName: '部門長 → 経理', unresolved: [],
  steps: [
    { stepId: 'head', name: '部門長', approverKind: 'department-head', approvers: [{ employeeId: 'e2', name: '花子' }], skipped: false },
    { stepId: 'acct', name: '経理', approverKind: 'group', approvers: [{ employeeId: 'e3', name: '次郎' }], skipped: false },
  ],
};

const actorOf = (subject: string, employeeId?: string): ExpenseActor => ({ subject, roles: ['publisher'], singleUser: false, canApprove: true, ...(employeeId === undefined ? {} : { employeeId }) });

/** 偽のプランナー（A の実装の代わり）。承認者の索引には現在の段の承認者を返す。 */
function fakePlanner(plan: ApprovalPlan = twoSteps, decision: ApprovalActorDecision = { blockers: [], proxy: false }) {
  return {
    plan: vi.fn(async (..._args: Parameters<ApprovalRoutePlanner['plan']>) => plan),
    actorBlockers: vi.fn(async (..._args: Parameters<ApprovalRoutePlanner['actorBlockers']>) => decision),
    currentApprovers: vi.fn(async (..._args: Parameters<ApprovalRoutePlanner['currentApprovers']>) => {
      const flow = _args[1].approvalFlow;
      return flow === undefined ? [] : currentApprovalStep(flow)?.approvers.map((entry) => entry.employeeId) ?? [];
    }),
  } satisfies ApprovalRoutePlanner;
}

const inApprovalClaim = (): ExpenseClaim => approveStep(checked([]), policyFixture(AT), twoSteps, [], 'hanako', AT, { employeeId: 'e2' });
const approvedFlowClaim = (): ExpenseClaim => approveStep(inApprovalClaim(), policyFixture(AT), mvpApprovalPlan(), [], 'jiro', NOW.toISOString(), { stepId: 'acct', employeeId: 'e3' });

describe('ApproveExpenseClaimUseCase: 段の承認（プランナーあり）', () => {
  it('正常: 2 段の経路は 1 段目で in-approval（承認者の索引を次の段へ入れ直す）、2 段目で approved。計画は checked のときだけ解決する', async () => {
    await claims.save(checked([]), new Map());
    const planner = fakePlanner();
    const hanako = actorOf('hanako@example.com', 'e2');
    const first = await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, planner).execute({ scope, claimId: 'c1', by: hanako.subject, displayName: '花子', actor: hanako, comment: '部門として承認', stepId: 'head' });
    expect(first).toMatchObject({
      status: 'in-approval',
      approvalFlow: {
        routeId: 'r1', resolvedAt: NOW.toISOString(), currentIndex: 1,
        steps: [{ stepId: 'head', status: 'approved', decision: { by: 'hanako@example.com', employeeId: 'e2', displayName: '花子', comment: '部門として承認', proxy: false } }, { stepId: 'acct', status: 'pending' }],
      },
    });
    expect(planner.actorBlockers).toHaveBeenCalledWith(scope, { claim: expect.objectContaining({ status: 'checked' }), policy: expect.objectContaining({ updatedAt: AT }), flow: expect.objectContaining({ currentIndex: 0 }), actor: hanako, comment: '部門として承認' });
    expect((await claims.list(scope, { awaitingEmployeeId: 'e3' })).map((summary) => summary.id)).toEqual(['c1']);

    const jiro = actorOf('jiro@example.com', 'e3');
    const second = await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => LATER, planner).execute({ scope, claimId: 'c1', by: jiro.subject, actor: jiro, stepId: 'acct' });
    expect(second).toMatchObject({ status: 'approved', approval: { by: 'jiro@example.com', at: LATER.toISOString() }, approvalFlow: { currentIndex: 2, resolvedAt: NOW.toISOString() } });
    // 承認中は申請へ写した承認者に固定する（計画を解決し直さない）。
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(planner.actorBlockers).toHaveBeenLastCalledWith(scope, { claim: expect.objectContaining({ status: 'in-approval' }), policy: expect.anything(), flow: first.approvalFlow, actor: jiro });
    expect(await claims.list(scope, { awaitingEmployeeId: 'e3' })).toEqual([]);
    expect((await claims.findById(scope, 'c1'))!.status).toBe('approved');
  });

  it('異常: プランナーの拒否理由（現在の段の承認者でない）は 409 に並べ、保存も承認者の索引の入れ直しもしない', async () => {
    await claims.save(checked([]), new Map(), ['e9']);
    const planner = fakePlanner(twoSteps, { blockers: [{ code: 'approval-not-current-approver', params: { stepName: '部門長' } }], proxy: false });
    const promise = new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, planner).execute({ scope, claimId: 'c1', by: 'saburo@example.com', actor: actorOf('saburo@example.com', 'e4') });
    await expect(promise).rejects.toMatchObject({ code: 'EXPENSE_TRANSITION', blockingReasons: [{ code: 'approval-not-current-approver', params: { stepName: '部門長' } }], nextStep: expect.stringContaining('現在の段の承認者ではありません') });
    expect(planner.currentApprovers).not.toHaveBeenCalled();
    expect((await claims.findById(scope, 'c1'))!.status).toBe('checked');
    expect(await claims.list(scope, { awaitingEmployeeId: 'e9' })).toHaveLength(1);
  });

  it('異常: 未解決の段は approval-route-unresolved、画面が見ていた段と違えば approval-step-changed を並べる', async () => {
    await claims.save(checked([]), new Map());
    const unresolved = fakePlanner({ ...twoSteps, unresolved: [{ stepId: 'head', stepName: '部門長', cause: 'department-head-missing', params: { department: '営業部' } }] });
    await expect(new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, unresolved).execute({ scope, claimId: 'c1', by: 'x', stepId: 'acct' }))
      .rejects.toMatchObject({ blockingReasons: [{ code: 'approval-route-unresolved', params: { stepId: 'head', cause: 'department-head-missing', department: '営業部' } }, { code: 'approval-step-changed', params: { stepName: '部門長' } }] });
  });

  it('異常: 承認中に別の人が先に進めた段を押すと approval-step-changed（再読み込みを促す）', async () => {
    await claims.save(checked([]), new Map());
    const planner = fakePlanner();
    await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, planner).execute({ scope, claimId: 'c1', by: 'hanako', actor: actorOf('hanako', 'e2') });
    await expect(new ApproveExpenseClaimUseCase(claims, receipts, policies, () => LATER, planner).execute({ scope, claimId: 'c1', by: 'jiro', actor: actorOf('jiro', 'e3'), stepId: 'head' }))
      .rejects.toMatchObject({ blockingReasons: [{ code: 'approval-step-changed', params: { stepName: '経理' } }], nextStep: expect.stringContaining('再読み込み') });
  });

  it('正常: 代理承認はコメント必須で、コメントがあれば proxy として記録する', async () => {
    await claims.save(checked([]), new Map());
    const useCase = new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, fakePlanner(twoSteps, { blockers: [], proxy: true }));
    await expect(useCase.execute({ scope, claimId: 'c1', by: 'keiri', actor: actorOf('keiri', 'e4') })).rejects.toMatchObject({ blockingReasons: [{ code: 'approval-proxy-comment-missing' }] });
    const proxied = await useCase.execute({ scope, claimId: 'c1', by: 'keiri', actor: actorOf('keiri', 'e4'), comment: '花子さんの出張中につき代理' });
    expect(proxied.approvalFlow!.steps[0]!.decision).toMatchObject({ by: 'keiri', employeeId: 'e4', proxy: true, comment: '花子さんの出張中につき代理' });
    expect(proxied.history.at(-1)).toMatchObject({ type: 'approval-step', proxy: true });
  });

  it('境界: 操作者を渡さないとき（ツール・既存の呼び出し）は by から操作者を作り、単一ユーザーは singleUser。MVP の計画は approvalFlow を書かない', async () => {
    const planner = fakePlanner(mvpApprovalPlan());
    await claims.save(checked([]), new Map());
    await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, planner).execute({ scope, claimId: 'c1', by: 'boss', displayName: '上司' });
    expect(planner.actorBlockers.mock.calls[0]![1].actor).toEqual({ subject: 'boss', displayName: '上司', roles: [], singleUser: false, canApprove: true });
    await claims.save(checked([]), new Map());
    const approved = await new ApproveExpenseClaimUseCase(claims, receipts, policies, () => NOW, planner).execute({ scope, claimId: 'c1', by: 'single-user' });
    expect(planner.actorBlockers.mock.calls[1]![1].actor).toEqual({ subject: 'single-user', roles: [], singleUser: true, canApprove: true });
    expect(approved.approvalFlow).toBeUndefined();
    expect(approved.approval).toEqual({ by: 'single-user', at: NOW.toISOString() });
  });

  it('正常: プランナーを配線しない構成の既定（MVP_APPROVAL_PLANNER）は 1 段で、操作者を妨げず承認者の索引は空', async () => {
    const claim = checked([]);
    const policy = policyFixture(AT);
    expect(await MVP_APPROVAL_PLANNER.plan(scope, claim, policy)).toEqual(mvpApprovalPlan());
    expect(await MVP_APPROVAL_PLANNER.actorBlockers(scope, { claim, policy, flow: flowFromPlan(mvpApprovalPlan(), AT, AT), actor: actorOf('boss') })).toEqual({ blockers: [], proxy: false });
    expect(await MVP_APPROVAL_PLANNER.currentApprovers(scope, claim, policy)).toEqual([]);
  });
});

describe('UnapproveExpenseClaimUseCase: 仮払・承認中', () => {
  const approvedWith = (advanceId?: string): ExpenseClaim => claimFixture('c1', { status: 'approved', approval: { by: 'boss', at: AT }, ...(advanceId === undefined ? {} : { advanceId }) });
  let advances: InMemoryExpenseAdvanceRepository;

  beforeEach(async () => {
    advances = new InMemoryExpenseAdvanceRepository();
    await advances.save(advanceFixture('adv-settled', 'settled'));
    await advances.save(advanceFixture('adv-paid', 'paid'));
  });

  it('異常: 紐付けた仮払が精算済みなら 409（仮払の精算の取消は後回し）で、承認を残す', async () => {
    await claims.save(approvedWith('adv-settled'), new Map());
    await expect(new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW, advances).execute({ scope, claimId: 'c1', note: '金額誤り', by: 'boss' }))
      .rejects.toMatchObject({ code: 'EXPENSE_TRANSITION', nextStep: expect.stringContaining('仮払 adv-settled で精算済み') });
    expect((await claims.findById(scope, 'c1'))!.status).toBe('approved');
  });

  it.each([
    ['支払済み（未精算）の仮払', 'adv-paid'],
    ['見つからない仮払', 'adv-missing'],
    ['仮払なし', undefined],
  ])('正常: %s なら承認を取り消せる（仮払が無ければ読まない）', async (_label, advanceId) => {
    await claims.save(approvedWith(advanceId), new Map());
    const find = vi.spyOn(advances, 'findById');
    const unapproved = await new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW, advances).execute({ scope, claimId: 'c1', note: '金額誤り', by: 'boss' });
    expect(unapproved.status).toBe('checked');
    expect(find).toHaveBeenCalledTimes(advanceId === undefined ? 0 : 1);
  });

  it('境界: 仮払のリポジトリを渡さない構成は仮払を見ない（MVP の配線のまま取り消せる）', async () => {
    await claims.save(approvedWith('adv-settled'), new Map());
    expect((await new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW).execute({ scope, claimId: 'c1', note: '見直し', by: 'boss' })).status).toBe('checked');
  });

  it('正常: 承認中の申請の承認取消は段の承認を捨てて checked に戻す', async () => {
    await claims.save(inApprovalClaim(), new Map());
    const unapproved = await new UnapproveExpenseClaimUseCase(claims, receipts, () => NOW, advances).execute({ scope, claimId: 'c1', note: '経路の誤り', by: 'boss' });
    expect(unapproved.status).toBe('checked');
    expect(unapproved.approvalFlow).toBeUndefined();
  });
});

describe('GetReturnDraftUseCase: 承認中', () => {
  it('正常: 承認中（in-approval）の申請も差し戻しの下書きを作れる', async () => {
    await claims.save(inApprovalClaim(), new Map());
    expect(await new GetReturnDraftUseCase(claims).execute(scope, 'c1')).toContain('テスト太郎 さん');
  });
});

describe('DescribeExpenseApprovalUseCase', () => {
  it('境界: checked / in-approval 以外は計画を解決しない。MVP の 1 段で承認した申請は plan なし、流れのある申請は保存済みの流れ', async () => {
    const planner = fakePlanner();
    const useCase = new DescribeExpenseApprovalUseCase(policies, planner, () => NOW);
    expect(await useCase.execute(scope, claimFixture('c1'), actorOf('x'))).toEqual({ blockers: [] });
    expect(await useCase.execute(scope, claimFixture('c2', { status: 'approved', approval: { by: 'b', at: AT } }))).toEqual({ blockers: [] });
    const approved = approvedFlowClaim();
    expect(approved.status).toBe('approved');
    expect(await useCase.execute(scope, approved, actorOf('x'))).toEqual({ plan: planFromFlow(approved.approvalFlow!), blockers: [] });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.actorBlockers).not.toHaveBeenCalled();
  });

  it('正常: checked は計画を解決し、未解決の段を approval-route-unresolved として並べる（見ている人がいなければ操作者の理由は尋ねない）', async () => {
    const unresolvedPlan: ApprovalPlan = { ...twoSteps, unresolved: [{ stepId: 'head', stepName: '部門長', cause: 'manager-missing', params: { claimant: 'テスト太郎' } }] };
    const planner = fakePlanner(unresolvedPlan);
    const result = await new DescribeExpenseApprovalUseCase(policies, planner, () => NOW).execute(scope, checked([]));
    expect(result).toEqual({ plan: unresolvedPlan, blockers: [{ code: 'approval-route-unresolved', params: { routeName: '部門長 → 経理', stepId: 'head', stepName: '部門長', cause: 'manager-missing', claimant: 'テスト太郎' } }] });
    expect(planner.actorBlockers).not.toHaveBeenCalled();
  });

  it('正常: 見ている人がいれば自己承認と操作者の拒否理由を足し、代理のコメント未入力は押す前には妨げにしない', async () => {
    const base = policyFixture(AT);
    await policies.save(scope, createExpensePolicy({ ...base, claimRules: { ...base.claimRules, forbidSelfApproval: true } }));
    const planner = fakePlanner(twoSteps, { blockers: [{ code: 'approval-not-current-approver' }, { code: 'approval-proxy-comment-missing' }], proxy: true });
    const viewer = actorOf('tester', 'e1');
    const result = await new DescribeExpenseApprovalUseCase(policies, planner, () => NOW).execute(scope, checked([]), viewer);
    expect(result.plan).toEqual(twoSteps);
    expect(result.blockers).toEqual([{ code: 'self-approval' }, { code: 'approval-not-current-approver' }]);
    expect(planner.actorBlockers).toHaveBeenCalledWith(scope, { claim: expect.objectContaining({ id: 'c1' }), policy: expect.objectContaining({ updatedAt: AT }), flow: expect.objectContaining({ routeId: 'r1', currentIndex: 0, resolvedAt: NOW.toISOString() }), actor: viewer });
  });

  it('正常: in-approval は保存済みの流れを計画の形で返し、計画を解決し直さない', async () => {
    const claim = inApprovalClaim();
    const planner = fakePlanner();
    const viewer = actorOf('jiro', 'e3');
    const result = await new DescribeExpenseApprovalUseCase(policies, planner, () => NOW).execute(scope, claim, viewer);
    expect(result).toEqual({ plan: planFromFlow(claim.approvalFlow!), blockers: [] });
    expect(planner.plan).not.toHaveBeenCalled();
    expect(planner.actorBlockers).toHaveBeenCalledWith(scope, expect.objectContaining({ flow: claim.approvalFlow, actor: viewer }));
  });

  it('異常: 判定の無い・古い checked の拒否理由（MVP の理由）は先頭に並ぶ', async () => {
    const result = await new DescribeExpenseApprovalUseCase(policies, fakePlanner(), () => NOW).execute(scope, claimFixture('c1', { status: 'checked' }), actorOf('boss'));
    expect(result.blockers[0]).toEqual({ code: 'judgment-missing' });
  });

  it('正常: プランナーと時計を省略すると MVP の 1 段（操作者を妨げない）', async () => {
    expect(await new DescribeExpenseApprovalUseCase(policies).execute(scope, checked([]), actorOf('boss'))).toEqual({ plan: mvpApprovalPlan(), blockers: [] });
  });
});
