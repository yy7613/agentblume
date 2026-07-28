/**
 * TokenAuthentication のテスト。
 *
 * 「通る条件」より「通してはいけない条件」を厚く見る（認証は失敗側が本体）。
 */
import { describe, expect, it } from 'vitest';
import type { AuthenticationRequest } from '../../application/security/authentication';
import { DEFAULT_TOKEN_ROLES, MINIMUM_TOKEN_LENGTH, TokenAuthentication, TokenAuthenticationConfigurationError } from './token-authentication';

const ALICE = 'a'.repeat(40);
const BOB = 'b'.repeat(40);

/** Authorization ヘッダだけを差し替えた最小のリクエスト。 */
function request(authorization?: string): AuthenticationRequest {
  return {
    method: 'GET',
    url: '/tools',
    header: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  };
}

describe('TokenAuthentication', () => {
  const auth = new TokenAuthentication([
    { subject: 'alice', token: ALICE, displayName: 'Alice' },
    { subject: 'bob', token: BOB, tenantId: 'globex', workspaceId: 'main', roles: ['viewer'] },
  ]);

  it('認証は必須で、方式は token', () => {
    expect(auth.required).toBe(true);
    expect(auth.mode).toBe('token');
  });

  it('登録済みトークンを Principal へ解決する', async () => {
    const result = await auth.authenticate(request(`Bearer ${ALICE}`));
    expect(result).toEqual({
      kind: 'authenticated',
      // roles 未指定は既定の editor（作成・編集・実行はできるが、削除・承認・公開・運用はできない）。
      principal: { subject: 'alice', tenantId: 'local', workspaceId: 'default', displayName: 'Alice', roles: ['editor'] },
    });
  });

  it('トークンごとにテナントとロールを変えられる', async () => {
    const result = await auth.authenticate(request(`Bearer ${BOB}`));
    expect(result).toMatchObject({ kind: 'authenticated', principal: { subject: 'bob', tenantId: 'globex', workspaceId: 'main', roles: ['viewer'] } });
  });

  it('scheme の大小・前後の空白は許容する', async () => {
    for (const header of [`bearer ${ALICE}`, `BEARER ${ALICE}`, `  Bearer   ${ALICE}  `, `Bearer\t${ALICE}`]) {
      expect((await auth.authenticate(request(header))).kind).toBe('authenticated');
    }
  });

  it('資格情報が無ければ missing-credentials', async () => {
    expect(await auth.authenticate(request())).toEqual({ kind: 'rejected', reason: 'missing-credentials' });
  });

  it('Bearer 以外・空・壊れたヘッダは資格情報なし扱い', async () => {
    for (const header of ['', 'Basic abc', 'Bearer', 'Bearer   ', ALICE]) {
      expect(await auth.authenticate(request(header))).toEqual({ kind: 'rejected', reason: 'missing-credentials' });
    }
  });

  it('一致しないトークンは invalid-credentials', async () => {
    for (const token of ['c'.repeat(40), ALICE.slice(0, 39), `${ALICE}x`, ALICE.toUpperCase()]) {
      expect(await auth.authenticate(request(`Bearer ${token}`))).toEqual({ kind: 'rejected', reason: 'invalid-credentials' });
    }
  });

  it('roles 未指定は既定の editor（削除・承認・公開・運用は付かない）', async () => {
    expect(DEFAULT_TOKEN_ROLES).toEqual(['editor']);
    const carol = 'c'.repeat(40);
    const auth = new TokenAuthentication([{ subject: 'carol', token: carol }]);
    expect(await auth.authenticate(request(`Bearer ${carol}`))).toMatchObject({ principal: { roles: ['editor'] } });
  });

  /**
   * `roles: []` を「未指定」と同一視して editor を付けていた回帰。
   * 「何もさせないつもり」で書いた設定が**全権に近いトークン**になる、最悪の向きの fail-open だった。
   * 空配列は「1つも与えない」と読む（全操作が拒否される）。
   */
  it('roles の空配列は既定へ落とさず「1つも与えない」として通す', async () => {
    const carol = 'c'.repeat(40);
    const auth = new TokenAuthentication([{ subject: 'carol', token: carol, roles: [] }]);
    const result = await auth.authenticate(request(`Bearer ${carol}`));
    expect(result).toMatchObject({ kind: 'authenticated', principal: { subject: 'carol', roles: [] } });
  });

  it('未知のロール名は起動時に落とす（付けたつもりで付いていない状態を作らない）', () => {
    expect(() => new TokenAuthentication([{ subject: 'carol', token: 'c'.repeat(40), roles: ['admin'] }]))
      .toThrow(/unknown role 'admin'/);
    expect(() => new TokenAuthentication([{ subject: 'carol', token: 'c'.repeat(40), roles: ['Operator'] }]))
      .toThrow(TokenAuthenticationConfigurationError);
    // メッセージには選べる値を並べる（打ち間違いをその場で直せるように）。
    expect(() => new TokenAuthentication([{ subject: 'carol', token: 'c'.repeat(40), roles: ['root'] }]))
      .toThrow(/workspace-admin/);
  });

  it('トークンが1本も無い設定は組み立てられない', () => {
    expect(() => new TokenAuthentication([])).toThrow(TokenAuthenticationConfigurationError);
  });

  it('短すぎるトークンは拒否し、値そのものはメッセージへ出さない', () => {
    const short = 'x'.repeat(MINIMUM_TOKEN_LENGTH - 1);
    try {
      new TokenAuthentication([{ subject: 'alice', token: short }]);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TokenAuthenticationConfigurationError);
      expect((error as Error).message).toContain('alice');
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('subject 空・トークン重複・subject 重複は設定エラー', () => {
    expect(() => new TokenAuthentication([{ subject: '  ', token: ALICE }])).toThrow(TokenAuthenticationConfigurationError);
    // 同じトークンを配ると「誰が」を分けられず、1人分だけ失効させることもできない。
    expect(() => new TokenAuthentication([{ subject: 'alice', token: ALICE }, { subject: 'bob', token: ALICE }]))
      .toThrow(TokenAuthenticationConfigurationError);
    expect(() => new TokenAuthentication([{ subject: 'alice', token: ALICE }, { subject: 'alice', token: BOB }]))
      .toThrow(TokenAuthenticationConfigurationError);
  });
});
