// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { ChatPage } from './ChatPage';
afterEach(cleanup);
describe('ChatPage', () => {
  it('保存済みAgent versionを固定して実行し応答を表示する', async () => {
    const client = { listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]), runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', response: 'done', trace: [], usage: {}, mode: 'preview' }) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { internalId: 'agent', version: '2.0.0' }, mode: 'preview' })));
    expect(await screen.findByText('done')).toBeTruthy();
  });

  it('会話ログにユーザー発話とアシスタント応答を積み上げ、送信で入力を空にし、New chatで消去する', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-9', response: 'hello there', trace: [], usage: {}, mode: 'preview' }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('hello there')).toBeTruthy();
    // ユーザー発話とアシスタント応答が両方スレッドに残る。
    expect(screen.getByText('You')).toBeTruthy();
    // 送信後にコンポーザーは空になる。
    expect((screen.getByLabelText('Chat message') as HTMLTextAreaElement).value).toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('hello there')).toBeNull();
  });

  it('初期のウェルカム候補をクリックするとコンポーザーへ差し込む', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]),
      runSavedAgent: vi.fn(),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    await userEvent.click(screen.getByRole('button', { name: 'Summarize what this agent can do.' }));
    expect((screen.getByLabelText('Chat message') as HTMLTextAreaElement).value).toBe('Summarize what this agent can do.');
    expect(client.runSavedAgent).not.toHaveBeenCalled();
  });
});
