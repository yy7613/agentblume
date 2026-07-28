/**
 * TokenAuthentication のテスト。
 *
 * 「通る条件」より「通してはいけない条件」を厚く見る（認証は失敗側が本体）。
 */
import { describe, expect, it } from 'vitest';
import type { AuthenticationRequest } from '../../application/security/authentication';
import { MINIMUM_TOKEN_LENGTH, TokenAuthentication, TokenAuthenticationConfigurationError } from './token-authentication';

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
      principal: { subject: 'alice', tenantId: 'local', workspaceId: 'default', displayName: 'Alice', roles: ['operator'] },
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
