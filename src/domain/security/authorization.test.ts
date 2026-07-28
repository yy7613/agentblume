/**
 * ロール×アクション表（`docs/08-security-auth.md` §3.2）の回帰テスト。
 *
 * ここが表そのものなので、**5ロール × 全アクション**を1マスずつ確かめる。
 * 表を書き換えたらこのテストも書き換わるはずで、片方だけ変わったら赤くなる。
 */
import { describe, expect, it } from 'vitest';
import {
  AUTHORIZATION_ACTIONS,
  AUTHORIZATION_ROLES,
  decideAuthorization,
  isAuthorizationRole,
  permissionOf,
  rolesOf,
  type AuthorizationAction,
  type AuthorizationResource,
  type AuthorizationRole,
} from './authorization';
import type { Principal } from './principal';

const principalWith = (roles: readonly string[], subject = 'alice'): Principal =>
  ({ subject, tenantId: 'acme', workspaceId: 'ops', roles });

const allows = (roles: readonly string[], action: AuthorizationAction, resource?: AuthorizationResource): boolean =>
  decideAuthorization(principalWith(roles), action, resource).kind === 'allow';

/** §3.2 の表をそのまま並べたもの（列 = ロール、行 = アクション）。 */
const MATRIX: Readonly<Record<AuthorizationAction, readonly AuthorizationRole[]>> = {
  read: ['viewer', 'editor', 'publisher', 'operator', 'workspace-admin'],
  create: ['editor', 'publisher', 'operator', 'workspace-admin'],
  edit: ['editor', 'publisher', 'operator', 'workspace-admin'],
  execute: ['editor', 'publisher', 'operator', 'workspace-admin'],
  approve: ['publisher', 'operator', 'workspace-admin'],
  publish: ['publisher', 'workspace-admin'],
  operate: ['operator', 'workspace-admin'],
  'manage-access': ['workspace-admin'],
  // delete は「自作のみ」を判定できないので、所有者を渡さない限り workspace-admin だけ。
  delete: ['workspace-admin'],
};

describe('decideAuthorization', () => {
  for (const action of AUTHORIZATION_ACTIONS) {
    for (const role of AUTHORIZATION_ROLES) {
      const expected = MATRIX[action].includes(role);
      it(`${role} は ${action} を ${expected ? '許可' : '拒否'} される`, () => {
        expect(allows([role], action, { kind: 'tool', id: 'x' })).toBe(expected);
      });
    }
  }

  it('ロールは加算的（1つでも許せば許可）', () => {
    expect(allows(['viewer'], 'operate')).toBe(false);
    expect(allows(['viewer', 'operator'], 'operate')).toBe(true);
  });

  it('ロールが空・未知の名前だけなら常に拒否（§3.1 フェイルセーフ）', () => {
    expect(allows([], 'read')).toBe(false);
    expect(allows(['admin', 'Operator', 'root'], 'read')).toBe(false);
    expect(allows(['admin', 'viewer'], 'read')).toBe(true);
  });

  it('audit-log は read だけ、しかも Operator 以上', () => {
    for (const role of AUTHORIZATION_ROLES) {
      const readable = role === 'operator' || role === 'workspace-admin';
      expect(allows([role], 'read', { kind: 'audit-log' })).toBe(readable);
      // 監査ログは誰も書き換えられない（台帳の意味が消えるため）。
      expect(allows([role], 'edit', { kind: 'audit-log' })).toBe(false);
      expect(allows([role], 'delete', { kind: 'audit-log' })).toBe(false);
    }
  });

  it('delete の「自作のみ」は所有者が分かるときだけ Editor / Publisher へ開く', () => {
    const own: AuthorizationResource = { kind: 'tool', id: 'mine', ownerSubject: 'alice' };
    const other: AuthorizationResource = { kind: 'tool', id: 'theirs', ownerSubject: 'bob' };
    expect(allows(['editor'], 'delete', own)).toBe(true);
    expect(allows(['publisher'], 'delete', own)).toBe(true);
    expect(allows(['editor'], 'delete', other)).toBe(false);
    // Operator は表のとおり自作でも削除できない（運用担当は消す側ではない）。
    expect(allows(['operator'], 'delete', own)).toBe(false);
    // 所有者不明は拒否。
    expect(allows(['editor'], 'delete', { kind: 'tool', id: 'mine' })).toBe(false);
    expect(allows(['workspace-admin'], 'delete', other)).toBe(true);
  });

  it('拒否理由は必要な権限だけを伝える（持っているロールは漏らさない）', () => {
    const decision = decideAuthorization(principalWith(['viewer']), 'delete', { kind: 'agent', id: 'secret-agent' });
    expect(decision).toEqual({ kind: 'deny', reason: "this operation requires the 'agent:delete' permission" });
    if (decision.kind !== 'deny') throw new Error('unreachable');
    expect(decision.reason).not.toContain('viewer');
    expect(decision.reason).not.toContain('alice');
  });

  it('リソースを渡さない判定はアクション名だけを理由に出す', () => {
    expect(decideAuthorization(principalWith(['viewer']), 'operate')).toEqual({ kind: 'deny', reason: "this operation requires the 'operate' permission" });
  });
});

describe('ロール名のユーティリティ', () => {
  it('isAuthorizationRole は値域だけを通す', () => {
    expect(isAuthorizationRole('operator')).toBe(true);
    expect(isAuthorizationRole('Operator')).toBe(false);
    expect(isAuthorizationRole('admin')).toBe(false);
  });

  it('rolesOf は未知の名前を落とす', () => {
    expect(rolesOf(principalWith(['viewer', 'admin', 'workspace-admin']))).toEqual(['viewer', 'workspace-admin']);
  });

  it('permissionOf は docs/04-api-spec.md と同じ表記を作る', () => {
    expect(permissionOf('tool', 'create')).toBe('tool:create');
    expect(permissionOf('agent', 'execute')).toBe('agent:execute');
  });
});
