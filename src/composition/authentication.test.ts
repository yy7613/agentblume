import { describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { TokenAuthentication } from '../adapters/security/token-authentication';
import type { AuthSettings } from '../config/environment';
import { createAuthentication } from './authentication';

const SCOPE = { tenantId: 'acme', workspaceId: 'ops' };

describe('createAuthentication', () => {
  it('single-user 設定なら既定スコープの単一ユーザー実装を選ぶ', async () => {
    const settings: AuthSettings = { mode: 'single-user', tokens: [] };
    const auth = createAuthentication(settings, SCOPE);
    expect(auth).toBeInstanceOf(SingleUserAuthentication);
    const result = await auth.authenticate({ method: 'GET', url: '/tools', header: () => undefined });
    expect(result).toMatchObject({ kind: 'authenticated', principal: SCOPE });
  });

  it('token 設定なら Bearer 実装を選ぶ（既定スコープは使わない）', async () => {
    const token = 't'.repeat(40);
    const settings: AuthSettings = {
      mode: 'token',
      tokens: [{ subject: 'alice', token, tenantId: 'globex', workspaceId: 'main' }],
    };
    const auth = createAuthentication(settings, SCOPE);
    expect(auth).toBeInstanceOf(TokenAuthentication);
    expect(auth.required).toBe(true);
    const result = await auth.authenticate({ method: 'GET', url: '/tools', header: () => `Bearer ${token}` });
    expect(result).toMatchObject({ kind: 'authenticated', principal: { subject: 'alice', tenantId: 'globex', workspaceId: 'main' } });
  });
});
