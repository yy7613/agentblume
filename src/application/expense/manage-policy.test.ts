import { describe, expect, it, vi } from 'vitest';
import { InMemoryExpensePolicyRepository } from '../../adapters/storage/in-memory-expense-repositories';
import { DEFAULT_EXPENSE_POLICY_UPDATED_AT, defaultExpensePolicy } from '../../domain/expense/default-policy';
import { ExpenseDomainError } from '../../domain/expense/errors';
import type { ExpenseCategory } from '../../domain/expense/policy';
import { GetExpensePolicyUseCase, loadExpensePolicy, ResetExpensePolicyUseCase, SaveExpensePolicyUseCase, type SaveExpensePolicyInput } from './manage-policy';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const otherWorkspace = { tenantId: 'tenant', workspaceId: 'other' };
const NOW = new Date('2026-09-20T01:00:00.000Z');
const clock = (): Date => NOW;

function saveInput(overrides: Partial<SaveExpensePolicyInput> = {}): SaveExpensePolicyInput {
  const { categories, claimRules, preApprovalRules, severityOverrides, journal } = defaultExpensePolicy();
  return { scope, categories, claimRules, preApprovalRules, severityOverrides, journal, ...overrides };
}

describe('loadExpensePolicy / GetExpensePolicyUseCase', () => {
  it('境界: 未保存なら初期テンプレートを saved=false で返し、**書き込まない**（参照が書き込みを起こさない）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const save = vi.spyOn(policies, 'save');
    const { policy, saved } = await new GetExpensePolicyUseCase(policies).execute(scope);
    expect(saved).toBe(false);
    expect(policy).toEqual(defaultExpensePolicy(DEFAULT_EXPENSE_POLICY_UPDATED_AT));
    expect(policy.updatedAt).toBe(DEFAULT_EXPENSE_POLICY_UPDATED_AT);
    expect(save).not.toHaveBeenCalled();
    expect(await policies.get(scope)).toBeNull();
  });

  it('正常: 保存済みなら saved=true でその規程を返す', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput());
    const result = await loadExpensePolicy(policies, scope);
    expect(result.saved).toBe(true);
    expect(result.policy.updatedAt).toBe(NOW.toISOString());
  });

  it('境界: 返した初期テンプレートを呼び出し側が書き換えても、次の取得に影響しない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const usecase = new GetExpensePolicyUseCase(policies);
    const first = (await usecase.execute(scope)).policy;
    (first.categories as unknown as { name: string }[])[0]!.name = '書き換え';
    expect((await usecase.execute(scope)).policy.categories[0]?.name).not.toBe('書き換え');
  });

  it('境界: 別のワークスペースで保存した規程は見えない（未保存のまま）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ scope: otherWorkspace }));
    expect((await loadExpensePolicy(policies, scope)).saved).toBe(false);
  });
});

describe('SaveExpensePolicyUseCase', () => {
  it('正常: 規程全体を置き換え、updatedAt に保存時刻を入れる', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const taxi = defaultExpensePolicy().categories.find((category) => category.id === 'transport.taxi')!;
    const saved = await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ categories: [taxi], preApprovalRules: [] }));
    expect(saved.categories.map((category) => category.id)).toEqual(['transport.taxi']);
    expect(saved.updatedAt).toBe(NOW.toISOString());
    expect(await policies.get(scope)).toEqual(saved);
  });

  it('例外: 規程の検証に通らなければ ExpenseDomainError で、何も保存しない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const taxi = defaultExpensePolicy().categories.find((category) => category.id === 'transport.taxi')!;
    await expect(new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ categories: [taxi, { ...taxi }], preApprovalRules: [] })))
      .rejects.toThrow(ExpenseDomainError);
    expect(await policies.get(scope)).toBeNull();
  });

  it('異常: 事前承認条件が規程に無い費目を指す保存は断る（参照切れを保存しない）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const taxi = defaultExpensePolicy().categories.find((category) => category.id === 'transport.taxi')!;
    // 初期の事前承認条件は meal.entertainment を参照している。
    await expect(new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ categories: [taxi] })))
      .rejects.toThrow(/refers to categories that are not in the policy: meal\.entertainment/u);
  });
});

describe('ResetExpensePolicyUseCase', () => {
  it('正常: 時計を注入しなければ現在時刻で保存・初期化する（本番の配線の既定）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const before = Date.now();
    const saved = await new SaveExpensePolicyUseCase(policies).execute(saveInput());
    expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(before);
    const reset = await new ResetExpensePolicyUseCase(policies).execute(scope);
    expect(Date.parse(reset.updatedAt)).toBeGreaterThanOrEqual(before);
    expect((await new GetExpensePolicyUseCase(policies).execute(scope)).saved).toBe(true);
  });

  it('正常: 初期テンプレートを保存時刻付きで**保存する**（以後は saved=true になり policy-unreviewed が消える）', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const reset = await new ResetExpensePolicyUseCase(policies, clock).execute(scope);
    expect(reset).toEqual(defaultExpensePolicy(NOW.toISOString()));
    expect(await policies.get(scope)).toEqual(reset);
    expect((await loadExpensePolicy(policies, scope)).saved).toBe(true);
  });

  it('境界: 保存済みの独自規程を初期テンプレートで上書きし、他のワークスペースには触らない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const taxi = defaultExpensePolicy().categories.find((category) => category.id === 'transport.taxi')!;
    await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ categories: [taxi], preApprovalRules: [] }));
    await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ scope: otherWorkspace, categories: [taxi], preApprovalRules: [] }));
    await new ResetExpensePolicyUseCase(policies, clock).execute(scope);
    expect((await policies.get(scope))?.categories.length).toBe(defaultExpensePolicy().categories.length);
    expect((await policies.get(otherWorkspace))?.categories).toHaveLength(1);
  });
});

describe('SaveExpensePolicyUseCase: 実用化の節の引き継ぎ（§20.2.2）', () => {
  const approval = {
    routes: [{
      id: 'large', name: '高額の申請', enabled: true, when: { categoryIds: [], minClaimAmount: 50000, departmentIds: [] },
      steps: [{ id: 'acct', name: '経理', approver: { kind: 'group', groupId: 'group-accounting' }, skipWhenSameAsPrevious: false }],
    }],
    forbidClaimantApproval: true,
    requireDistinctApprovers: true,
  };
  const route = { required: true, commuterPass: true, fareTable: false };
  const LATER = new Date('2026-09-21T01:00:00.000Z');

  async function seeded(policies: InMemoryExpensePolicyRepository) {
    const base = saveInput();
    const defaults = defaultExpensePolicy();
    return new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({
      categories: base.categories.map((category) => (category.id === 'transport.public' ? { ...category, route } : category)),
      journal: { ...base.journal, departmentDimensionId: 'department' },
      approval,
      transport: { commuterPassDeduction: false, fareToleranceYen: 50, defaultFareType: 'ticket' },
      card: { ...defaults.card, acceptCorporatePaymentItems: true, creditAccountId: 'liability.accounts_payable' },
      advance: { ...defaults.advance, settleWithinDays: 30 },
    }));
  }

  it('正常: 節のキーを送らない保存（MVP の画面・古いクライアント）は、承認経路・交通費・カード・仮払・費目の route・部門の補助軸を保つ', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const first = await seeded(policies);
    // 初期テンプレートの費目は route を持つので、route を知らないクライアントの形（キーごと無い）にして送る。
    const categories = saveInput().categories.map(({ route: _route, ...category }) => category);
    const second = await new SaveExpensePolicyUseCase(policies, () => LATER).execute(saveInput({ categories, severityOverrides: { 'payee-missing': 'return' } }));
    expect(second.updatedAt).toBe(LATER.toISOString());
    expect(second.severityOverrides).toEqual({ 'payee-missing': 'return' });
    expect(second.approval).toEqual(first.approval);
    expect(second.approval.routes.map((entry) => entry.id)).toEqual(['large']);
    expect(second.transport).toEqual({ commuterPassDeduction: false, fareToleranceYen: 50, defaultFareType: 'ticket' });
    expect(second.card).toMatchObject({ acceptCorporatePaymentItems: true, creditAccountId: 'liability.accounts_payable' });
    expect(second.advance.settleWithinDays).toBe(30);
    expect(second.categories.find((category) => category.id === 'transport.public')?.route).toEqual(route);
    expect(second.categories.find((category) => category.id === 'transport.taxi')).not.toHaveProperty('route');
    expect(second.journal.departmentDimensionId).toBe('department');
    expect(await policies.get(scope)).toEqual(second);
  });

  it('正常: キーを明示すれば置き換え・消去できる（route のキーあり・departmentDimensionId 空・routes 空）。送らなかった節は保つ', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    await seeded(policies);
    const base = saveInput();
    const cleared = await new SaveExpensePolicyUseCase(policies, () => LATER).execute(saveInput({
      categories: base.categories.map((category) => (category.id === 'transport.public' ? { ...category, route: undefined } : category)),
      journal: { ...base.journal, departmentDimensionId: '' },
      approval: { routes: [] },
      transport: { commuterPassDeduction: true, fareToleranceYen: 0, defaultFareType: 'ic' },
    }));
    expect(cleared.categories.find((category) => category.id === 'transport.public')).not.toHaveProperty('route');
    expect(cleared.journal).not.toHaveProperty('departmentDimensionId');
    expect(cleared.approval.routes).toEqual([]);
    expect(cleared.transport.fareToleranceYen).toBe(0);
    expect(cleared.card.acceptCorporatePaymentItems).toBe(true);
    expect(cleared.advance.settleWithinDays).toBe(30);
  });

  it('境界: 現在の規程に無い費目（新しい id）には何も引き継がない。未保存のワークスペースは初期テンプレートの節を使う', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    const taxi = defaultExpensePolicy().categories.find((category) => category.id === 'transport.taxi')!;
    const added: ExpenseCategory = { ...taxi, id: 'transport.bike', name: 'シェアサイクル', aliases: [] };
    const saved = await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ categories: [taxi, added], preApprovalRules: [] }));
    expect(saved.categories.find((category) => category.id === 'transport.bike')).not.toHaveProperty('route');
    expect(saved.approval).toEqual(defaultExpensePolicy().approval);
    expect(saved.card).toEqual(defaultExpensePolicy().card);
    expect(saved.journal).not.toHaveProperty('departmentDimensionId');
  });

  it('異常: 引き継いだ節と矛盾する保存（経路の条件が消した費目を指す）は ExpenseDomainError で、保存しない', async () => {
    const policies = new InMemoryExpensePolicyRepository();
    await new SaveExpensePolicyUseCase(policies, clock).execute(saveInput({ approval: { routes: [{ ...approval.routes[0], when: { categoryIds: ['transport.taxi'], departmentIds: [] } }] } }));
    const before = await policies.get(scope);
    const others = defaultExpensePolicy().categories.filter((category) => category.id !== 'transport.taxi');
    await expect(new SaveExpensePolicyUseCase(policies, () => LATER).execute(saveInput({ categories: others }))).rejects.toThrow(/categories that are not in the policy: transport\.taxi/u);
    expect(await policies.get(scope)).toEqual(before);
  });
});
