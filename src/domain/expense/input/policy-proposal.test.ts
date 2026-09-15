import { describe, expect, it } from 'vitest';
import { defaultExpensePolicy } from '../default-policy';
import { mergeProposalDrafts, normalizeQuoteText, quoteFoundIn, relatedPaths, stableJson, validatePolicyProposal, type ProposalValidationContext } from './policy-proposal';

const current = defaultExpensePolicy('2026-09-15T00:00:00.000Z');
const SOURCE = '株式会社サンプル商事 旅費・経費規程\n第5条 接待の飲食は1人あたり8,000円までとする。\n第6条 経費は利用日から60日以内に提出する。';
const context: ProposalValidationContext = {
  current, sourceText: SOURCE,
  groupIds: new Set(['group-accounting']),
  accountIds: new Set(['expense.entertainment', 'expense.travel', 'expense.misc', 'expense.meetings']),
};

const route = {
  id: 'entertainment-route', name: '交際費は部門長 → 経理',
  when: { categoryIds: ['meal.entertainment'], minClaimAmount: 50_000 },
  steps: [{ id: 'head', name: '部門長', approver: { kind: 'department-head' } }, { id: 'accounting', name: '経理', approver: { kind: 'group', groupId: 'group-accounting' } }],
};

describe('validatePolicyProposal: 費目', () => {
  it('正常: 既存の費目の上限を変え、根拠の引用が規程文にあれば quoteFound で警告なし（null は既存の値を保つ）', () => {
    const { proposal, issues } = validatePolicyProposal({
      categories: [{ id: 'meal.entertainment', limits: { perPerson: 8000, perItem: null }, note: null }],
      rationales: [{ path: 'categories.meal.entertainment.limits.perPerson', quote: '接待の飲食は1人あたり 8,000円までとする', note: null }],
    }, context);
    expect(issues).toEqual([]);
    const category = proposal.candidate.categories?.[0];
    expect(category?.limits).toEqual({ perPerson: 8000, perPersonBasis: 'tax-included' });
    expect(category?.note).toBe(current.categories.find((entry) => entry.id === 'meal.entertainment')?.note);
    expect(proposal.rationales).toEqual([{ path: 'categories.meal.entertainment.limits.perPerson', quote: '接待の飲食は1人あたり 8,000円までとする', quoteFound: true }]);
    expect(proposal.warnings).toEqual([]);
  });

  it('異常: 数値の変更で引用が無い・規程文に見つからなければ警告にする（案には残す）', () => {
    const { proposal } = validatePolicyProposal({
      categories: [{ id: 'transport.taxi', limits: { perItem: 5000 } }],
      rationales: [{ path: 'categories.transport.taxi', quote: 'タクシーは5,000円まで', note: '' }],
    }, context);
    expect(proposal.candidate.categories?.[0]?.limits.perItem).toBe(5000);
    expect(proposal.rationales[0]).toEqual({ path: 'categories.transport.taxi', quote: 'タクシーは5,000円まで', quoteFound: false });
    expect(proposal.warnings).toEqual(['規程文に根拠が見つからない数値です: categories.transport.taxi.limits.perItem']);
  });

  it('正常: 新しい費目は既定の欄で補い、並び順は末尾', () => {
    const { proposal, issues } = validatePolicyProposal({ categories: [{ id: 'transport.parking', name: '駐車場代', aliases: ['駐車場'], accountId: 'expense.travel', receipt: { required: false } }] }, context);
    expect(issues).toEqual([]);
    expect(proposal.candidate.categories?.[0]).toMatchObject({
      id: 'transport.parking', name: '駐車場代', enabled: true, sortOrder: 121, defaultTaxRate: 10, receipt: { required: false }, invoice: { required: true },
      requires: { purpose: false, attendees: false, attendeeDetails: false }, taxCodeByRate: current.categories[0]?.taxCodeByRate,
    });
  });

  it('異常: 科目マスタに無い科目・名前の無い新しい費目・別名の重複・id の無い案は理由付きで落とす', () => {
    const { proposal, issues } = validatePolicyProposal({
      categories: [
        { id: 'x.unknown-account', name: '不明', accountId: 'expense.unknown' },
        { id: 'x.no-name' },
        { id: 'x.alias', name: '重複', aliases: ['交際費'] },
        { name: 'id が無い' },
        'not-an-object',
      ],
    }, context);
    expect(proposal.candidate.categories).toBeUndefined();
    expect(proposal.dropped.map((entry) => entry.path)).toEqual(['categories.x.unknown-account.accountId', 'categories.x.no-name', 'categories.x.alias', 'categories[3]', 'categories[4]']);
    expect(proposal.dropped[2]?.reason).toContain('交際費');
    expect(issues).toHaveLength(5);
  });

  it('境界: 科目マスタが読めない（accountIds なし）なら科目 id を検査しない。配列でない categories は落とす', () => {
    const { accountIds: _accountIds, ...withoutChart } = context;
    expect(validatePolicyProposal({ categories: [{ id: 'x.any', name: '何か', accountId: 'expense.unknown' }] }, withoutChart).proposal.candidate.categories).toHaveLength(1);
    expect(validatePolicyProposal({ categories: 'x' }, context).proposal.dropped).toEqual([{ path: 'categories', reason: '配列ではないので読めませんでした' }]);
  });
});

describe('validatePolicyProposal: 申請ルール・事前承認・承認経路・重さ', () => {
  it('正常: 申請ルールは通るキーだけ残す（未知のキー・範囲外の値は落とす）', () => {
    const { proposal } = validatePolicyProposal({
      claimRules: { submissionDeadlineDays: 60, attendeesIncludeClaimant: false, foo: 1, forbidSelfApproval: 'yes' },
      rationales: [{ path: 'claimRules.submissionDeadlineDays', quote: '利用日から60日以内に提出する', note: null }],
    }, context);
    expect(proposal.candidate.claimRules).toEqual({ submissionDeadlineDays: 60, attendeesIncludeClaimant: false });
    expect(proposal.dropped.map((entry) => entry.path)).toEqual(['claimRules.foo', 'claimRules.forbidSelfApproval']);
    expect(proposal.warnings).toEqual([]);
    expect(validatePolicyProposal({ claimRules: { submissionDeadlineDays: 0 } }, context).proposal.dropped[0]?.path).toBe('claimRules.submissionDeadlineDays');
    expect(validatePolicyProposal({ claimRules: [1] }, context).proposal.dropped).toEqual([{ path: 'claimRules', reason: 'オブジェクトではないので読めませんでした' }]);
  });

  it('正常: 事前承認の条件を足し、既存の条件は id で重ねる。全明細に当たる条件・id の無い条件は落とす', () => {
    const { proposal } = validatePolicyProposal({
      preApprovalRules: [
        { id: 'taxi-20000', name: 'タクシー 2 万円以上', categoryIds: ['transport.taxi'], minAmount: 20_000 },
        { id: 'any-100000', minAmount: 80_000 },
        { id: 'everything', name: '全部' },
        { name: 'id なし' },
      ],
    }, context);
    expect(proposal.candidate.preApprovalRules).toEqual([
      { id: 'any-100000', name: '1 件 100,000 円以上', enabled: true, categoryIds: [], minAmount: 80_000 },
      { id: 'taxi-20000', name: 'タクシー 2 万円以上', enabled: true, categoryIds: ['transport.taxi'], minAmount: 20_000 },
    ]);
    expect(proposal.dropped.map((entry) => entry.path)).toEqual(['preApprovalRules.everything', 'preApprovalRules[3]']);
    expect(proposal.warnings).toEqual(['規程文に根拠が見つからない数値です: preApprovalRules.taxi-20000.minAmount', '規程文に根拠が見つからない数値です: preApprovalRules.any-100000.minAmount']);
  });

  it('正常: 承認経路は段の種類と組織にある承認グループまで。特定の従業員・無いグループ・部門の条件・壊れた経路は落とす', () => {
    const { proposal } = validatePolicyProposal({
      approvalRoutes: [
        route,
        { ...route, id: 'employee-route', steps: [{ id: 's', name: '指名', approver: { kind: 'employee', employeeId: 'emp-jiro' } }] },
        { ...route, id: 'unknown-group', steps: [{ id: 's', name: 'G', approver: { kind: 'group', groupId: 'group-x' } }] },
        { ...route, id: 'department-route', when: { departmentIds: ['dept-sales'] } },
        { ...route, id: 'no-steps', steps: [] },
        { name: 'id なし' },
      ],
    }, context);
    expect(proposal.candidate.approvalRoutes).toEqual([{
      id: 'entertainment-route', name: '交際費は部門長 → 経理', enabled: true,
      when: { categoryIds: ['meal.entertainment'], minClaimAmount: 50_000, departmentIds: [] },
      steps: [{ id: 'head', name: '部門長', approver: { kind: 'department-head' }, skipWhenSameAsPrevious: false }, { id: 'accounting', name: '経理', approver: { kind: 'group', groupId: 'group-accounting' }, skipWhenSameAsPrevious: false }],
    }]);
    expect(proposal.dropped.map((entry) => entry.path)).toEqual(['approval.routes.employee-route', 'approval.routes.unknown-group', 'approval.routes.department-route', 'approval.routes.no-steps', 'approval.routes[5]']);
    expect(proposal.dropped[0]?.reason).toContain('特定の従業員');
    expect(proposal.warnings).toContain('規程文に根拠が見つからない数値です: approval.routes.entertainment-route.when.minClaimAmount');
  });

  it('正常: 重さは変更できるコードと値だけ残す', () => {
    const { proposal } = validatePolicyProposal({ severityOverrides: { 'payee-missing': 'return', 'claim-empty': 'review', 'no-such-code': 'off', 'route-missing': null } }, context);
    expect(proposal.candidate.severityOverrides).toEqual({ 'payee-missing': 'return' });
    expect(proposal.dropped.map((entry) => entry.path)).toEqual(['severityOverrides.claim-empty', 'severityOverrides.no-such-code']);
    expect(validatePolicyProposal({ severityOverrides: 'x' }, context).proposal.dropped).toEqual([{ path: 'severityOverrides', reason: 'オブジェクトではないので読めませんでした' }]);
  });

  it('境界: 根拠は path の無いものを捨て、空の引用・補足は省く。最大 200 件', () => {
    const rationales = [{ quote: 'x' }, { path: ' ', quote: 'x' }, 'x', { path: 'claimRules', quote: ' ', note: '補足' }, ...Array.from({ length: 250 }, () => ({ path: 'p', quote: null }))];
    const { proposal } = validatePolicyProposal({ rationales }, context);
    expect(proposal.rationales[0]).toEqual({ path: 'claimRules', quoteFound: false, note: '補足' });
    expect(proposal.rationales).toHaveLength(197);
    expect(proposal.candidate).toEqual({});
  });
});

describe('mergeProposalDrafts', () => {
  it('正常: 節ごとの案をまとめ、同じ項目に違う値が出たらどちらも入れずに警告する', () => {
    const { merged, warnings } = mergeProposalDrafts([
      { categories: [{ id: 'a', name: 'A' }], claimRules: { submissionDeadlineDays: 60 }, severityOverrides: { 'payee-missing': 'return' }, rationales: [{ path: 'r1' }] },
      {
        categories: [{ name: 'A', id: 'a' }, { id: 'b', name: 'B' }, { name: 'loose' }], claimRules: { submissionDeadlineDays: 30, attendeesIncludeClaimant: true, forbidSelfApproval: null },
        severityOverrides: { 'payee-missing': 'review' }, preApprovalRules: [{ id: 'p', minAmount: 1 }, { id: 'p', minAmount: 2 }, { id: 'p', minAmount: 3 }], rationales: [{ path: 'r2' }],
      },
      { categories: 'broken', claimRules: 'broken' },
    ]);
    expect(merged).toEqual({
      categories: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { name: 'loose' }],
      claimRules: { attendeesIncludeClaimant: true },
      preApprovalRules: [],
      approvalRoutes: [],
      severityOverrides: {},
      rationales: [{ path: 'r1' }, { path: 'r2' }],
    });
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('申請ルール submissionDeadlineDays');
    expect(warnings[1]).toContain('事前承認の条件 p');
    expect(warnings[2]).toContain('重さ payee-missing');
  });
});

describe('小さな関数', () => {
  it('stableJson はキーを並べ、undefined のキーを書かない', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(stableJson(undefined)).toBe('null');
  });

  it('relatedPaths は親子の関係でも同じ項目とみなし、id の途中では切らない', () => {
    expect(relatedPaths('categories.meal.entertainment', 'categories.meal.entertainment.limits.perPerson')).toBe(true);
    expect(relatedPaths('categories.meal.entertainment.limits', 'categories.meal.entertainment')).toBe(true);
    expect(relatedPaths('categories.meal', 'categories.meal2.limits')).toBe(false);
  });

  it('引用の検査は NFKC・空白・大文字小文字の違いを吸収し、空の引用は見つからない扱い', () => {
    expect(normalizeQuoteText(' Ａ Ｂ\n')).toBe('ab');
    expect(quoteFoundIn('第1条 AB', 'ａｂ')).toBe(true);
    expect(quoteFoundIn('第1条 AB', undefined)).toBe(false);
    expect(quoteFoundIn('第1条 AB', '   ')).toBe(false);
  });
});
