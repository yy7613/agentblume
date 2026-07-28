import { describe, expect, it } from 'vitest';
import type { AuthenticationRequest } from '../../application/security/authentication';
import { DEFAULT_TENANT_ID, DEFAULT_WORKSPACE_ID, SINGLE_USER_SUBJECT } from '../../domain/security/principal';
import { SingleUserAuthentication } from './single-user-authentication';

const REQUEST: AuthenticationRequest = { method: 'GET', url: '/tools', header: () => undefined };

describe('SingleUserAuthentication', () => {
  it('資格情報を要求せず、常に既定テナントの Principal を返す', async () => {
    const auth = new SingleUserAuthentication();
    expect(auth.mode).toBe('single-user');
    expect(auth.required).toBe(false);
    expect(await auth.authenticate(REQUEST)).toEqual({
      kind: 'authenticated',
      principal: {
        subject: SINGLE_USER_SUBJECT,
        tenantId: DEFAULT_TENANT_ID,
        workspaceId: DEFAULT_WORKSPACE_ID,
        displayName: 'Local operator',
        roles: ['operator'],
      },
    });
  });

  it('既定スコープを差し替えられる（AGENTCONTEXT_TENANT_ID 等の反映先）', async () => {
    const auth = new SingleUserAuthentication({ tenantId: 'acme', workspaceId: 'ops' });
    const result = await auth.authenticate(REQUEST);
    expect(result).toMatchObject({ principal: { tenantId: 'acme', workspaceId: 'ops' } });
  });

  it('Authorization ヘッダが何であっても結果は変わらない', async () => {
    const auth = new SingleUserAuthentication();
    const withHeader: AuthenticationRequest = { method: 'POST', url: '/tools', header: () => 'Bearer whatever' };
    expect(await auth.authenticate(withHeader)).toEqual(await auth.authenticate(REQUEST));
  });
});
