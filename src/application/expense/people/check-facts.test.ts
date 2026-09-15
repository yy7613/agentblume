/** 判定に要る「人と承認」の事実（docs/21 §20.3.3）。マスタも経路も無ければ理由を 1 つも出さない事実になる。 */
import { describe, expect, it } from 'vitest';
import { peopleTestDeps, policyWithApproval, seedPeople, TWO_STEP_APPROVAL } from '../../../adapters/storage/expense-people-deps.fixtures';
import { claimFixture } from '../../../adapters/storage/expense-repository.fixtures';
import { employeeFixture, scope } from '../../../adapters/storage/expense-v9.fixtures';
import { defaultExpensePolicy } from '../../../domain/expense/default-policy';
import { allReasons } from '../../../domain/expense/judgment';
import { judgeClaim } from '../check-claims';
import { PeopleCheckFactsProvider } from './check-facts';

describe('PeopleCheckFactsProvider', () => {
  it('正常: 従業員がいない・経路が無いワークスペースでは masterInUse=false だけで、判定は MVP と同じ', async () => {
    const deps = peopleTestDeps();
    const provider = new PeopleCheckFactsProvider(deps);
    const claim = claimFixture('c1');
    expect(await provider.gather(scope, claim, defaultExpensePolicy())).toEqual({ people: { masterInUse: false } });
    const { judgment } = await judgeClaim(deps.repositories.claims, deps.repositories.receipts, claim, defaultExpensePolicy(), true, '2026-09-30', [provider]);
    expect(allReasons(judgment).map((reason) => reason.code).filter((code) => code.startsWith('claimant') || code.startsWith('approval'))).toEqual([]);
  });

  it('正常: マスタを使っていて未紐付けなら、氏名が一致する有効な従業員を候補にする（判定に claimant-unlinked が出る）', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const provider = new PeopleCheckFactsProvider(deps);
    const claim = claimFixture('c1', { claimant: { name: 'テスト 太郎' } });
    expect(await provider.gather(scope, claim, defaultExpensePolicy())).toEqual({ people: { masterInUse: true, nameCandidates: [{ id: 'emp-taro', name: 'テスト太郎' }] } });
    const { judgment } = await judgeClaim(deps.repositories.claims, deps.repositories.receipts, claim, defaultExpensePolicy(), true, '2026-09-30', [provider]);
    expect(judgment.claimReasons.find((reason) => reason.code === 'claimant-unlinked')?.params).toMatchObject({ claimant: 'テスト 太郎', candidates: 'テスト太郎', employeeId: 'emp-taro' });
    // 無効な従業員と同名でも候補にしない。
    expect(await provider.gather(scope, claimFixture('c2', { claimant: { name: 'テスト四郎' } }), defaultExpensePolicy())).toEqual({ people: { masterInUse: true } });
  });

  it('異常: 紐付いた従業員が無効なら enabled=false、見つからなければ null', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const provider = new PeopleCheckFactsProvider(deps);
    expect((await provider.gather(scope, claimFixture('c1', { claimant: { name: 'テスト四郎', employeeId: 'emp-shiro' } }), defaultExpensePolicy())).people).toMatchObject({ claimantEmployee: { id: 'emp-shiro', name: 'テスト四郎', enabled: false } });
    expect((await provider.gather(scope, claimFixture('c1', { claimant: { name: '誰か', employeeId: 'emp-ghost' } }), defaultExpensePolicy())).people).toMatchObject({ claimantEmployee: null });
  });

  it('正常: 承認計画の未解決は claimant-unlinked 原因を除いた最初の 1 件を経路 id つきで渡す', async () => {
    const deps = peopleTestDeps();
    await seedPeople(deps);
    const provider = new PeopleCheckFactsProvider(deps);
    const policy = policyWithApproval(TWO_STEP_APPROVAL);
    const jiro = await provider.gather(scope, claimFixture('c1', { claimant: { name: 'テスト次郎', employeeId: 'emp-jiro' } }), policy);
    expect(jiro.people?.approvalUnresolved).toEqual({ routeId: 'two-step', routeName: '上長と経理', stepId: 'manager', stepName: '上長', cause: 'manager-missing', params: { claimant: 'テスト次郎', employeeId: 'emp-jiro' } });
    expect((await provider.gather(scope, claimFixture('c2'), policy)).people).not.toHaveProperty('approvalUnresolved');
    // 既定の段の未解決（経路 id なし）。
    const lonely = policyWithApproval({ defaultSteps: [{ id: 'boss', name: '社長', approver: { kind: 'employee', employeeId: 'emp-shiro' } }] });
    await deps.repositories.employees.save(employeeFixture('emp-extra', { name: '追加', loginSubjects: [] }));
    expect((await provider.gather(scope, claimFixture('c3'), lonely)).people?.approvalUnresolved).toEqual({ routeName: '既定の承認', stepId: 'boss', stepName: '社長', cause: 'employee-disabled', params: { employee: 'テスト四郎', employeeId: 'emp-shiro' } });
  });
});
