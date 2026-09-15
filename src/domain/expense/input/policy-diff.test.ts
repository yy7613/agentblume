import { describe, expect, it } from 'vitest';
import type { ApprovalRoute } from '../approval';
import { defaultExpensePolicy } from '../default-policy';
import { ExpenseDomainError } from '../errors';
import { createExpensePolicy, type ExpenseCategory, type PreApprovalRule } from '../policy';
import type { ProposedPolicyPatch } from '../policy-hearing';
import { applyPolicyChanges, diffExpensePolicy } from './policy-diff';

const AT = '2026-09-15T00:00:00.000Z';
const current = defaultExpensePolicy(AT);
const byId = (id: string): ExpenseCategory => current.categories.find((category) => category.id === id)!;
const ruleById = (id: string): PreApprovalRule => current.preApprovalRules.find((rule) => rule.id === id)!;

const entertainment = byId('meal.entertainment');
const taxi = byId('transport.taxi');
const parking: ExpenseCategory = { ...byId('misc'), id: 'transport.parking', name: '駐車場代', aliases: ['駐車場'], sortOrder: 10, note: '運用は架空' };
const route: ApprovalRoute = {
  id: 'ent-route', name: '交際費', enabled: true, when: { categoryIds: ['meal.entertainment'], minClaimAmount: 50_000, departmentIds: [] },
  steps: [{ id: 'head', name: '部門長', approver: { kind: 'department-head' }, skipWhenSameAsPrevious: false }],
};
const newRule: PreApprovalRule = { id: 'taxi-20000', name: 'タクシー 2 万円以上', enabled: true, categoryIds: ['transport.taxi'], minAmount: 20_000 };

const candidate: ProposedPolicyPatch = {
  categories: [
    { ...entertainment, aliases: [...entertainment.aliases, '会食'], limits: { ...entertainment.limits, perPerson: 8000 } },
    parking,
    { ...taxi, enabled: false, limits: { perPersonBasis: 'tax-included' } },
  ],
  claimRules: { submissionDeadlineDays: 60, attendeesIncludeClaimant: true },
  preApprovalRules: [newRule, { ...ruleById('any-100000'), minAmount: 80_000 }, { ...ruleById('entertainment-50000'), enabled: false }, ruleById('entertainment-50000')],
  approvalRoutes: [route],
  severityOverrides: { 'payee-missing': 'return' },
};
const rationales = [
  { path: 'categories.meal.entertainment', quote: '交際費の規程', quoteFound: false },
  { path: 'categories.meal.entertainment.limits.perPerson', quote: '1人あたり8,000円', quoteFound: true },
];

describe('diffExpensePolicy', () => {
  const changes = diffExpensePolicy(current, candidate, rationales);

  it('正常: 項目ごと（費目は欄ごと）に、費目 → 申請ルール → 事前承認 → 承認経路 → 重さの順で並ぶ。同じ値は差分にしない', () => {
    expect(changes.map((change) => [change.id, change.kind])).toEqual([
      ['category:meal.entertainment:aliases', 'update'],
      ['category:meal.entertainment:limits.perPerson', 'update'],
      ['category:transport.parking', 'add'],
      ['category:transport.taxi:enabled', 'disable'],
      ['category:transport.taxi:limits.perItem', 'update'],
      ['claim-rule:submissionDeadlineDays', 'update'],
      ['pre-approval:taxi-20000', 'add'],
      ['pre-approval:any-100000', 'update'],
      ['pre-approval:entertainment-50000', 'disable'],
      ['approval-route:ent-route', 'add'],
      ['severity:payee-missing', 'add'],
    ]);
    expect(changes.find((change) => change.id === 'category:transport.taxi:limits.perItem')).toMatchObject({ before: 10_000, after: null, path: 'categories.transport.taxi.limits.perItem', field: 'limits.perItem', key: 'transport.taxi' });
  });

  it('正常: 根拠は同じ項目を指す引用を付け、見つかった引用を優先する', () => {
    expect(changes[1]?.rationale).toEqual(rationales[1]);
    expect(changes[0]?.rationale).toEqual(rationales[0]);
    expect(changes[2]?.rationale).toBeUndefined();
  });

  it('境界: 既に上書きがある重さは update、同じ値なら差分にしない。空の案は差分なし', () => {
    const withOverride = createExpensePolicy({ ...current, severityOverrides: { 'payee-missing': 'review' } });
    expect(diffExpensePolicy(withOverride, { severityOverrides: { 'payee-missing': 'return' } })).toMatchObject([{ kind: 'update', before: 'review', after: 'return' }]);
    expect(diffExpensePolicy(withOverride, { severityOverrides: { 'payee-missing': 'review' } })).toEqual([]);
    expect(diffExpensePolicy(current, {})).toEqual([]);
    expect(diffExpensePolicy(current, { approvalRoutes: [{ ...route, name: '別名' }] })[0]).toMatchObject({ kind: 'add' });
  });
});

describe('applyPolicyChanges', () => {
  const changes = diffExpensePolicy(current, candidate, rationales);
  const apply = (ids: readonly string[]) => createExpensePolicy({ ...applyPolicyChanges(current, changes, ids), updatedAt: AT });

  it('正常: 選んだ変更だけを当てる（選ばない欄は現在の値のまま）', () => {
    const policy = apply(['category:meal.entertainment:limits.perPerson']);
    const updated = policy.categories.find((category) => category.id === 'meal.entertainment')!;
    expect(updated.limits.perPerson).toBe(8000);
    expect(updated.aliases).toEqual(entertainment.aliases);
    expect(policy.categories).toHaveLength(current.categories.length);
  });

  it('正常: 費目の追加（並び順が重なれば末尾）・無効化・上限の削除、申請ルール・事前承認・承認経路・重さを当てる', () => {
    const policy = apply(changes.map((change) => change.id));
    expect(policy.categories.find((category) => category.id === 'transport.parking')).toMatchObject({ sortOrder: 121, name: '駐車場代' });
    const disabled = policy.categories.find((category) => category.id === 'transport.taxi')!;
    expect(disabled.enabled).toBe(false);
    expect(disabled.limits.perItem).toBeUndefined();
    expect(policy.claimRules.submissionDeadlineDays).toBe(60);
    expect(policy.preApprovalRules.map((rule) => [rule.id, rule.enabled, rule.minAmount])).toEqual([['entertainment-50000', false, 50_000], ['any-100000', true, 80_000], ['taxi-20000', true, 20_000]]);
    expect(policy.approval.routes).toEqual([route]);
    expect(policy.severityOverrides).toEqual({ 'payee-missing': 'return' });
    expect(policy.journal).toEqual(current.journal);
  });

  it('境界: 並び順が重ならない新しい費目は案の並び順のまま。最上位の欄の削除（メモ）も当たる', () => {
    const own = { ...parking, sortOrder: 500 };
    const noteless = { ...entertainment };
    delete (noteless as { note?: string }).note;
    const localChanges = diffExpensePolicy(current, { categories: [own, noteless] });
    const policy = createExpensePolicy({ ...applyPolicyChanges(current, localChanges, localChanges.map((change) => change.id)), updatedAt: AT });
    expect(policy.categories.find((category) => category.id === 'transport.parking')?.sortOrder).toBe(500);
    expect(policy.categories.find((category) => category.id === 'meal.entertainment')?.note).toBeUndefined();
  });

  it('例外: 差分に無い変更 id は作り直しを促す ExpenseDomainError', () => {
    expect(() => applyPolicyChanges(current, changes, ['category:nothing'])).toThrow(ExpenseDomainError);
    expect(() => applyPolicyChanges(current, changes, ['category:nothing'])).toThrow(/recreate the diff/u);
  });
});
