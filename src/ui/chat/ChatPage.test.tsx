// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('2ターン目以降は直前までの会話をhistoryとして送る（マルチターン会話）', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]),
      runSavedAgent: vi.fn()
        .mockResolvedValueOnce({ runId: 'run-1', response: 'first answer', trace: [], usage: {}, mode: 'preview' })
        .mockResolvedValueOnce({ runId: 'run-2', response: 'second answer', trace: [], usage: {}, mode: 'preview' }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    await sendMessage('first question');
    expect(await screen.findByText('first answer')).toBeTruthy();
    expect(client.runSavedAgent).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ history: expect.anything() }));

    await sendMessage('second question');
    expect(await screen.findByText('second answer')).toBeTruthy();
    expect(client.runSavedAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: 'second question',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    }));
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

  it('実行失敗後も送信したユーザー発話がスレッドに残り、再試行で同じ内容を再送する', async () => {
    const runSavedAgent = vi.fn().mockRejectedValueOnce(new Error('LM Studio timed out')).mockResolvedValueOnce({ runId: 'run-retry', response: 'recovered', trace: [], usage: {}, mode: 'preview' });
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('please help');
    expect(await screen.findByText('LM Studio timed out')).toBeTruthy();
    // 失敗しても送信したユーザー発話はスレッドに残る。
    expect(screen.getByText('please help')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('recovered')).toBeTruthy();
    expect(runSavedAgent).toHaveBeenCalledTimes(2);
    // 再試行でも同じメッセージ本文が渡る。
    expect((runSavedAgent.mock.calls[1]?.[0] as { message: string }).message).toBe('please help');
    // 再試行は新しいユーザー発話ターンとして積まれる（元の発話も残ったまま）。
    expect(screen.getAllByText('please help')).toHaveLength(2);
  });

  it('Harnessの計画承認待ち・入力待ちの通知は中立トーン（notice）で出す', async () => {
    const harnessRun = { runId: 'h-1', harness: { internalId: 'h', version: '1.0.0' }, status: 'waiting-approval', events: [], checkpoint: { kind: 'magentic-approval', plan: 'do the thing' } };
    const client = {
      listAgents: vi.fn().mockResolvedValue([]),
      listHarnesses: vi.fn().mockResolvedValue([{ internalId: 'h', displayName: 'Harness', publishName: 'h', latestVersion: '1.0.0', pattern: 'magentic', state: 'draft' }]),
      runHarness: vi.fn().mockResolvedValue(harnessRun),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Harness/ });
    await userEvent.selectOptions(screen.getByLabelText('Chat agent'), 'harness:h');
    await sendMessage('start it');
    const notice = await screen.findByText('The Magentic plan is waiting for approval. Enter feedback to request a revision.');
    expect(notice.closest('.cc-alert')?.className).toContain('notice');
  });

  it('単一Agent実行の承認待ちで承認バナーを出し、ApproveでresumeRunを呼んで完走応答へ戻る', async () => {
    const waiting = {
      runId: 'run-approval', mode: 'preview', response: 'Approve write_rows before it runs?', usage: {},
      trace: [{ sequence: 1, kind: 'approval-requested', tool: 'write_rows', sideEffect: 'write', prompt: 'Approve write_rows before it runs?' }],
      status: 'waiting-approval',
      checkpoint: { prompt: 'Approve write_rows before it runs?', expiresAt: '2026-07-27T00:00:00.000Z', tool: 'write_rows', sideEffect: 'write' },
    };
    const resumed = { runId: 'run-approval', mode: 'preview', response: 'wrote 3 rows', trace: [], usage: {} };
    const resumeRun = vi.fn().mockResolvedValue(resumed);
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockResolvedValue(waiting), resumeRun } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('write the rows');

    const banner = await screen.findByRole('group', { name: 'Tool approval' });
    expect(banner.textContent).toContain('Approve write_rows before it runs?');
    // 承認対象のツールと副作用も添える。
    expect(banner.textContent).toContain('write_rows');

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('run-approval', { tenantId: 'local', workspaceId: 'default' }, 'approve'));
    expect(await screen.findByText('wrote 3 rows')).toBeTruthy();
    // 完走したので承認バナーは消える。
    expect(screen.queryByRole('group', { name: 'Tool approval' })).toBeNull();
  });

  it('Rejectはdecision=rejectでresumeRunを呼ぶ', async () => {
    const waiting = {
      runId: 'run-reject', mode: 'preview', response: 'Approve delete_rows?', usage: {}, trace: [],
      status: 'waiting-approval',
      checkpoint: { prompt: 'Approve delete_rows?', expiresAt: '2026-07-27T00:00:00.000Z', tool: 'delete_rows', sideEffect: 'write' },
    };
    const resumeRun = vi.fn().mockResolvedValue({ runId: 'run-reject', mode: 'preview', response: 'cancelled by user', trace: [], usage: {} });
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockResolvedValue(waiting), resumeRun } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('delete them');
    await screen.findByRole('group', { name: 'Tool approval' });

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('run-reject', { tenantId: 'local', workspaceId: 'default' }, 'reject'));
    expect(await screen.findByText('cancelled by user')).toBeTruthy();
  });

  it('busy中は経過秒数を1秒毎に更新して表示する', async () => {
    vi.useFakeTimers();
    try {
      let resolveRun: (value: unknown) => void = () => {};
      const runSavedAgent = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
      const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent } as unknown as ToolApiClient;
      render(<ChatPage client={client} />);
      // Agent一覧解決（listAgentsのPromiseチェーン）を待つ。
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('You')).toBeTruthy();
      expect(screen.getByText('Running… 0s')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByText('Running… 1s')).toBeTruthy();
      resolveRun({ runId: 'run-slow', response: 'done at last', trace: [], usage: {}, mode: 'preview' });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('done at last')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('画像を添付してプレビューし、保存済みAgentの実行入力へ渡す', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue(oneAgent),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-image', response: 'I can see it.', trace: [], usage: {}, mode: 'preview' }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    const file = new File(['tiny image'], 'tiny.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(input, file);
    expect(await screen.findByAltText('tiny.png')).toBeTruthy();
    await sendMessage('What is this?');
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ name: 'tiny.png', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) })] })));
    expect(await screen.findByText('I can see it.')).toBeTruthy();
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

  it('opens a chart Artifact from the session workspace', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue(oneAgent),
      createAgentSession: vi.fn().mockResolvedValue({ id: 'session-1', scope: { tenantId: 'local', workspaceId: 'default' }, rootAgent: { internalId: 'agent', version: '1.0.0' }, status: 'active', createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z', quota: { maxBytes: 1, maxArtifactBytes: 1, maxArtifacts: 1 } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-chart', response: 'stored', trace: [], usage: {}, mode: 'preview' }),
      listSessionArtifacts: vi.fn().mockResolvedValue([{ id: 'chart-1', sessionId: 'session-1', name: 'Trend', kind: 'chart', revision: 1, contentType: 'application/json', sizeBytes: 128, checksum: 'sum', createdAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' }]),
      getSessionArtifact: vi.fn().mockResolvedValue({ artifact: {}, payload: { specVersion: 1, chartType: 'time-series', mapping: { timeColumn: 'at', valueColumn: 'value' }, rows: [{ at: '2026-07-01', value: 3 }], sourceRowCount: 1, sampled: false } }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />); await screen.findByRole('option', { name: /Agent/ }); await sendMessage();
    await userEvent.click(await screen.findByRole('button', { name: /Trend · chart/ }));
    expect(await screen.findByRole('dialog', { name: 'Chart preview' })).toBeTruthy();
    expect(client.getSessionArtifact).toHaveBeenCalledWith('session-1', 'chart-1', { tenantId: 'local', workspaceId: 'default' });
  });

  it('数値ポイントが無いチャートは翻訳済みの空状態文言を表示する', async () => {
    const client = {
      listAgents: vi.fn().mockResolvedValue(oneAgent),
      createAgentSession: vi.fn().mockResolvedValue({ id: 'session-1', scope: { tenantId: 'local', workspaceId: 'default' }, rootAgent: { internalId: 'agent', version: '1.0.0' }, status: 'active', createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z', quota: { maxBytes: 1, maxArtifactBytes: 1, maxArtifacts: 1 } }),
      runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-chart', response: 'stored', trace: [], usage: {}, mode: 'preview' }),
      listSessionArtifacts: vi.fn().mockResolvedValue([{ id: 'chart-1', sessionId: 'session-1', name: 'Empty', kind: 'chart', revision: 1, contentType: 'application/json', sizeBytes: 32, checksum: 'sum', createdAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' }]),
      getSessionArtifact: vi.fn().mockResolvedValue({ artifact: {}, payload: { specVersion: 1, chartType: 'time-series', mapping: { timeColumn: 'at', valueColumn: 'value' }, rows: [], sourceRowCount: 0, sampled: false } }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />); await screen.findByRole('option', { name: /Agent/ }); await sendMessage();
    await userEvent.click(await screen.findByRole('button', { name: /Empty · chart/ }));
    expect(await screen.findByText('No numeric chart points.')).toBeTruthy();
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
