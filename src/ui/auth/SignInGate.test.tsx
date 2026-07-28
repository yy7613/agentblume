// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { AuthSessionDto } from '../api/types';
import { readAuthToken, writeAuthToken } from '../api/auth-token';
import { resetScope, scope } from '../scope';
import { I18nProvider } from '../i18n';
import { SignInGate } from './SignInGate';

const SINGLE_USER: AuthSessionDto = {
  mode: 'single-user',
  authenticationRequired: false,
  principal: { subject: 'single-user', tenantId: 'local', workspaceId: 'default', roles: ['operator'] },
};
const ALICE: AuthSessionDto = {
  mode: 'token',
  authenticationRequired: true,
  principal: { subject: 'alice', tenantId: 'acme', workspaceId: 'ops', displayName: 'Alice', roles: ['operator'] },
};

function gate(getSession: ToolApiClient['getSession']) {
  const client = { getSession } as unknown as ToolApiClient;
  return render(<I18nProvider><SignInGate client={client}>{(session) => <p>signed in: {session.principal.subject}</p>}</SignInGate></I18nProvider>);
}

beforeEach(() => { writeAuthToken(undefined); resetScope(); });
afterEach(() => { cleanup(); writeAuthToken(undefined); resetScope(); });

describe('SignInGate', () => {
  it('単一ユーザーモードでは何も聞かずに本体を描く', async () => {
    gate(vi.fn().mockResolvedValue(SINGLE_USER));
    expect(await screen.findByText('signed in: single-user')).toBeTruthy();
  });

  it('セッションのスコープをUI全体へ反映する（下書きキーと表示の基準になる）', async () => {
    gate(vi.fn().mockResolvedValue(ALICE));
    await screen.findByText('signed in: alice');
    expect(scope).toEqual({ tenantId: 'acme', workspaceId: 'ops' });
  });

  it('401 ならトークン入力を求め、本体は描かない', async () => {
    gate(vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'authentication required')));
    expect(await screen.findByLabelText('Access token')).toBeTruthy();
    expect(screen.queryByText(/signed in/)).toBeNull();
  });

  it('入力したトークンを保存して再確認し、通れば本体を描く', async () => {
    const getSession = vi.fn()
      .mockRejectedValueOnce(new ApiError(401, 'UNAUTHENTICATED', 'authentication required'))
      .mockResolvedValueOnce(ALICE);
    gate(getSession as unknown as ToolApiClient['getSession']);

    await userEvent.type(await screen.findByLabelText('Access token'), 'secret-token');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('signed in: alice')).toBeTruthy();
    expect(readAuthToken()).toBe('secret-token');
  });

  it('弾かれたら理由を出して入力へ戻す（黙って空白にしない）', async () => {
    const getSession = vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'rejected'));
    gate(getSession as unknown as ToolApiClient['getSession']);

    await userEvent.type(await screen.findByLabelText('Access token'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('rejected'));
    expect(screen.getByLabelText('Access token')).toBeTruthy();
  });

  it('401 以外の失敗はトークンの問題ではないので、接続エラーとして出す', async () => {
    gate(vi.fn().mockRejectedValue(new Error('fetch failed')));
    expect(await screen.findByText('Cannot reach the API server')).toBeTruthy();
    // トークン入力は出さない（入力しても直らない）。
    expect(screen.queryByLabelText('Access token')).toBeNull();
  });

  it('空のトークンでは送信できない', async () => {
    gate(vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'x')));
    await screen.findByLabelText('Access token');
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
