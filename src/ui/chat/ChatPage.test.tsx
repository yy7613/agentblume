// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { ChatPage } from './ChatPage';
afterEach(cleanup);
async function sendMessage(message = 'hello'): Promise<void> {
  await userEvent.type(screen.getByLabelText('Chat message'), message);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}
describe('ChatPage', () => {
  it('保存済みAgent versionを固定して実行し応答を表示する', async () => {
    const client = { listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]), runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', response: 'done', trace: [], usage: {}, mode: 'preview' }) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
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

    await sendMessage();
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

  const oneAgent = [{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }];

  it('structuredResponse・全種トレース・トークンを応答に描画する', async () => {
    const run = {
      runId: 'run-s', mode: 'preview', response: 'text', usage: { totalTokens: 55 },
      structuredResponse: { answer: 'yes' },
      trace: [
        { sequence: 1, kind: 'model-request', step: 1, toolNames: ['t'] },
        { sequence: 2, kind: 'tool-call', name: 't', arguments: { a: 1 } },
        { sequence: 3, kind: 'tool-result', name: 't', terminalId: 'n', nodes: [{ nodeId: 'n', rowCount: 2, truncated: false }], outputPreview: [{}] },
        { sequence: 4, kind: 'model-response', content: 'done' },
        { sequence: 5, kind: 'error', code: 'E_X', message: 'bad' },
      ],
    };
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockResolvedValue(run) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    expect(await screen.findByText(/"answer": "yes"/)).toBeTruthy();
    expect(screen.getByText(/55 tokens/)).toBeTruthy();
    expect(screen.getByText(/Model response/)).toBeTruthy();
    expect(screen.getByText(/E_X: bad/)).toBeTruthy();
  });

  it('実行失敗をエラー吹き出しで表示する（非Error理由もハンドル）', async () => {
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockRejectedValue('boom') } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    expect(await screen.findByText('Request failed')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
  });

  it('creates one Agent Session, passes it to Runs, renders its artifacts, and closes it for a new chat', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue(oneAgent),
      createAgentSession: vi.fn().mockResolvedValue({ id: 'session-1', scope: { tenantId: 'local', workspaceId: 'default' }, rootAgent: { internalId: 'agent', version: '1.0.0' }, status: 'active', createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z', quota: { maxBytes: 1, maxArtifactBytes: 1, maxArtifacts: 1 } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-session', sessionId: 'session-1', response: 'stored', trace: [], usage: {}, mode: 'preview' }),
      listSessionArtifacts: vi.fn().mockResolvedValue([{ id: 'artifact-1', sessionId: 'session-1', name: 'scores', kind: 'table', revision: 1, contentType: 'application/json', sizeBytes: 1_024, checksum: 'sum', createdAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' }]),
      closeAgentSession: vi.fn().mockResolvedValue({}),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' })));
    expect(await screen.findByLabelText('Session workspace')).toBeTruthy();
    expect(screen.getByText(/scores · table · 1.0 KB/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'New chat' }));
    await waitFor(() => expect(client.closeAgentSession).toHaveBeenCalledWith('session-1', { tenantId: 'local', workspaceId: 'default' }));
  });

  it('starts a new Session when the selected Agent changes', async () => {
    const agents = [...oneAgent, { internalId: 'other', displayName: 'Other', publishName: 'other', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }];
    const client = {
      listAgents: vi.fn().mockResolvedValue(agents),
      createAgentSession: vi.fn().mockResolvedValue({ id: 'session-1', scope: { tenantId: 'local', workspaceId: 'default' }, rootAgent: { internalId: 'agent', version: '1.0.0' }, status: 'active', createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z', quota: { maxBytes: 1, maxArtifactBytes: 1, maxArtifacts: 1 } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-1', response: 'done', trace: [], usage: {}, mode: 'preview' }),
      closeAgentSession: vi.fn().mockResolvedValue({}),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Other/ });
    await userEvent.clear(screen.getByLabelText('Chat message'));
    await userEvent.type(screen.getByLabelText('Chat message'), 'go');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(client.createAgentSession).toHaveBeenCalled());
    await userEvent.selectOptions(screen.getByLabelText('Chat agent'), 'other');
    await waitFor(() => expect(client.closeAgentSession).toHaveBeenCalledWith('session-1', { tenantId: 'local', workspaceId: 'default' }));
  });

  it('Agent一覧の取得失敗をアラート表示し、未保存の案内を出す', async () => {
    const client = { listAgents: vi.fn().mockRejectedValue(new Error('offline')) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    expect(await screen.findByText('offline')).toBeTruthy();
    expect(screen.getByText('Save an Agent in Agent Builder first.')).toBeTruthy();
  });
});
