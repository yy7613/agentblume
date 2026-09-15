/**
 * 「人と承認」の contributor（docs/21 §20.3.2 / §20.3.3 / §20.4.1）。
 * `params` の名前は §20.4 の差し込み値に一致させる（骨格の文言が読む名前）。
 */
import { describe, expect, it } from 'vitest';
import { checkClaim } from '../check';
import type { CheckedClaim } from '../check-extensions';
import { createExpenseClaim } from '../claim';
import { defaultExpensePolicy } from '../default-policy';
import { PEOPLE_REASON_CODES } from '../reason-codes';
import { peopleClaimReasons, peopleContributor } from './check-people';

const claim = (claimant: CheckedClaim['claimant']): CheckedClaim => ({ id: 'c1', period: { from: '2026-09-01', to: '2026-09-30' }, items: [], ...(claimant === undefined ? {} : { claimant }) });
const unresolved = { routeId: 'big', routeName: '高額の交際費', stepId: 'group', stepName: '経理', cause: 'group-empty' as const, params: { group: '経理', groupId: 'accounting', employee: null } };

describe('peopleClaimReasons', () => {
  it('正常: 事実が無ければ何も出さない（系統を配線しない構成は MVP と同じ）', () => {
    expect(peopleClaimReasons(claim({ name: 'テスト太郎' }), undefined)).toEqual([]);
    expect(peopleContributor.codes).toEqual(PEOPLE_REASON_CODES);
    expect(peopleContributor.claimReasons?.(claim({ name: 'x' }), defaultExpensePolicy(), {})).toEqual([]);
  });

  it('正常: マスタを使っているのに未紐付けなら claimant-unlinked。候補は「、」で連結し、1 人なら導線の employeeId を付ける', () => {
    expect(peopleClaimReasons(claim({ name: 'テスト太郎' }), { masterInUse: true })).toEqual([{ code: 'claimant-unlinked', params: { claimant: 'テスト太郎' } }]);
    expect(peopleClaimReasons(claim({ name: 'テスト太郎' }), { masterInUse: true, nameCandidates: [{ id: 'emp-taro', name: 'テスト太郎' }] })).toEqual([
      { code: 'claimant-unlinked', params: { claimant: 'テスト太郎', candidates: 'テスト太郎', employeeId: 'emp-taro' } },
    ]);
    const many = ['a', 'b', 'c', 'd'].map((id) => ({ id, name: `テスト${id}` }));
    expect(peopleClaimReasons(claim({ name: 'テスト' }), { masterInUse: true, nameCandidates: many })[0]?.params).toEqual({ claimant: 'テスト', candidates: 'テストa、テストb、テストc' });
  });

  it('境界: マスタを使っていない・紐付き済み・申請者の無い申請には claimant-unlinked を出さない', () => {
    expect(peopleClaimReasons(claim({ name: 'テスト太郎' }), { masterInUse: false })).toEqual([]);
    expect(peopleClaimReasons(claim({ name: 'テスト太郎', employeeId: 'emp-taro' }), { masterInUse: true, claimantEmployee: { id: 'emp-taro', name: 'テスト太郎', enabled: true } })).toEqual([]);
    expect(peopleClaimReasons(claim(undefined), { masterInUse: true })).toEqual([{ code: 'claimant-unlinked', params: { claimant: '' } }]);
  });

  it('異常: 紐付いた従業員が無効なら missing=false、見つからなければ missing=true。調べていなければ出さない', () => {
    const linked = claim({ name: 'テスト四郎', employeeId: 'emp-shiro' });
    expect(peopleClaimReasons(linked, { masterInUse: true, claimantEmployee: { id: 'emp-shiro', name: 'テスト四郎', enabled: false } })).toEqual([
      { code: 'claimant-employee-disabled', params: { claimant: 'テスト四郎', missing: false, employeeId: 'emp-shiro' } },
    ]);
    // マスタに有効な従業員が居なくても、紐付いた相手の問題は見せる。
    expect(peopleClaimReasons(linked, { masterInUse: false, claimantEmployee: null })).toEqual([
      { code: 'claimant-employee-disabled', params: { claimant: 'テスト四郎', missing: true, employeeId: 'emp-shiro' } },
    ]);
    expect(peopleClaimReasons(linked, { masterInUse: true })).toEqual([]);
  });

  it('正常: 承認計画の未解決は approval-route-unresolved（null の差し込み値は落とし、経路 id・段 id・原因を足す）。claimant-unlinked 原因は出さない', () => {
    expect(peopleClaimReasons(claim({ name: 'テスト太郎', employeeId: 'emp-taro' }), { masterInUse: true, approvalUnresolved: unresolved })).toEqual([
      { code: 'approval-route-unresolved', params: { group: '経理', groupId: 'accounting', routeName: '高額の交際費', stepId: 'group', stepName: '経理', cause: 'group-empty', routeId: 'big' } },
    ]);
    const { routeId: _routeId, ...withoutRoute } = unresolved;
    expect(peopleClaimReasons(claim({ name: 'x', employeeId: 'e' }), { approvalUnresolved: withoutRoute })[0]?.params).not.toHaveProperty('routeId');
    expect(peopleClaimReasons(claim({ name: 'x' }), { masterInUse: true, approvalUnresolved: { ...unresolved, cause: 'claimant-unlinked', params: {} } }).map((draft) => draft.code)).toEqual(['claimant-unlinked']);
  });
});

describe('peopleContributor を checkClaim に差し込む', () => {
  const tenant = { tenantId: 't', workspaceId: 'w' };
  const at = '2026-09-15T00:00:00.000Z';
  const base = createExpenseClaim({ tenant, id: 'c1', claimant: { name: 'テスト太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [], acknowledgements: [], history: [{ type: 'created', by: 'u', at }], submittedBy: 'u', createdAt: at, updatedAt: at });
  const people = { masterInUse: true, nameCandidates: [{ id: 'emp-taro', name: 'テスト太郎' }], approvalUnresolved: unresolved };
  const input = (policy = defaultExpensePolicy(at)) => ({ claim: base, policy, policySaved: true, duplicateCandidates: [], today: '2026-09-30', receiptHashes: new Map<string, string>(), extensions: { people } });

  it('正常: 明細が無い申請でも申請の前提の理由が評価順（claimant-unlinked → approval-route-unresolved → claim-empty）に並び、既定は要確認', () => {
    const judgment = checkClaim(input());
    expect(judgment.claimReasons.map((reason) => [reason.code, reason.severity])).toEqual([
      ['claimant-unlinked', 'review'], ['approval-route-unresolved', 'review'], ['claim-empty', 'return'],
    ]);
  });

  it('正常: 規程の重さの上書きで claimant-unlinked を off にすると消え、差し戻しにもできる', () => {
    const policy = defaultExpensePolicy(at);
    expect(checkClaim(input({ ...policy, severityOverrides: { 'claimant-unlinked': 'off' } })).claimReasons.map((reason) => reason.code)).toEqual(['approval-route-unresolved', 'claim-empty']);
    expect(checkClaim(input({ ...policy, severityOverrides: { 'claimant-unlinked': 'return' } })).claimReasons[0]).toMatchObject({ code: 'claimant-unlinked', severity: 'return' });
  });
});
