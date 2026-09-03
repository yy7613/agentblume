// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen } from '../navigation';
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
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ agent: { internalId: 'agent', version: '2.0.0' }, mode: 'preview' }), expect.any(AbortSignal)));
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
    expect(client.runSavedAgent).toHaveBeenNthCalledWith(1, expect.not.objectContaining({ history: expect.anything() }), expect.any(AbortSignal));

    await sendMessage('second question');
    expect(await screen.findByText('second answer')).toBeTruthy();
    expect(client.runSavedAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: 'second question',
      history: [
        { role: 'user', content: 'first question' },
        { role: 'assistant', content: 'first answer' },
      ],
    }), expect.any(AbortSignal));
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

  it('Run の失敗（ApiError）は失敗トレースを引き直し、次の一手・失敗箇所・直す場所へのボタン・技術的な詳細を返答の位置に出す', async () => {
    const failed = new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail', { tool: { internalId: 'sales-lookup', version: '1.0.0', publishName: 'sales_lookup' }, nodeId: 'in-1' });
    const getRunTrace = vi.fn().mockResolvedValue({
      runId: 'run-fail', scope: { tenantId: 'local', workspaceId: 'default' }, status: 'failed', mode: 'preview', startedAt: 'now',
      trace: [
        { sequence: 1, kind: 'tool-call', name: 'sales_lookup', arguments: { month: '2026-06' } },
        { sequence: 2, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year' },
      ],
    });
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockRejectedValue(failed), getRunTrace } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('sales please');
    await waitFor(() => expect(getRunTrace).toHaveBeenCalledWith('run-fail', { tenantId: 'local', workspaceId: 'default' }));
    const alert = await screen.findByRole('alert');
    // 次の一手が先頭・太字。失敗箇所はツール名 + ノードID。
    expect(alert.querySelector('strong')?.textContent).toBe('Describe that argument more concretely in the tool, or state its value in your request');
    expect(alert.textContent).toContain('Failed in tool sales_lookup v1.0.0 · node in-1');
    expect(screen.getByRole('button', { name: 'Open node "in-1" in tool "sales_lookup"' })).toBeTruthy();
    // 生の code: message とモデルが渡した引数は折りたたみの中。
    const details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).toContain('TOOL_ARGUMENTS: required argument missing: year');
    expect(details?.textContent).toContain('{"month":"2026-06"}');
    // 返答の位置（エージェント名の吹き出し）に出て、再試行もできる。
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.queryByText('Error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('失敗トレースの取得に失敗しても通知自体は出す（best-effort）', async () => {
    const failed = new ApiError(502, 'MODEL_PROVIDER', 'fetch failed', 'run-fail');
    const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent: vi.fn().mockRejectedValue(failed), getRunTrace: vi.fn().mockRejectedValue(new Error('gone')) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    expect(await screen.findByRole('button', { name: 'Open model settings' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Could not reach the model server');
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
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('run-approval', { tenantId: 'local', workspaceId: 'default' }, 'approve', undefined, expect.any(AbortSignal)));
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
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('run-reject', { tenantId: 'local', workspaceId: 'default' }, 'reject', undefined, expect.any(AbortSignal)));
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
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ name: 'tiny.png', dataUrl: expect.stringMatching(/^data:image\/png;base64,/) })] }), expect.any(AbortSignal)));
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
    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1' }), expect.any(AbortSignal)));
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

    // キーボードだけで脱出でき、フォーカスは開いたArtifactボタンへ戻る。
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Chart preview' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Trend · chart/ }));
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

  it('会話が上限を超えると古いturnを落とし、落としたことを表示する', async () => {
    let counter = 0;
    const client = {
      listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '2.0.0', kind: 'normal', state: 'draft' }]),
      runSavedAgent: vi.fn().mockImplementation(() => { counter += 1; return Promise.resolve({ runId: `run-${counter}`, response: `answer ${counter}`, trace: [], usage: {}, mode: 'preview' }); }),
    } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    // 1往復で2turn積まれるため、51往復で上限100件を超える。
    const composer = screen.getByLabelText('Chat message');
    for (let round = 1; round <= 51; round += 1) {
      fireEvent.change(composer, { target: { value: `question ${round}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledTimes(round));
      await screen.findByText(`answer ${round}`);
    }

    expect(await screen.findByText('2 older message(s) were removed from this view.')).toBeTruthy();
    // 最初の往復は表示から消え、最新の往復は残る。
    expect(screen.queryByText('question 1')).toBeNull();
    expect(screen.getByText('question 51')).toBeTruthy();
    expect(screen.getByText('answer 51')).toBeTruthy();
  });
  /**
   * 中断。モデルのタイムアウトは最大10分あるので、「止められる」ことが体験の要になる。
   * ボタンの出現条件・abort・再送できることをまとめて押さえる。
   */
  describe('実行の中断', () => {
    function pendingClient(): { readonly client: ToolApiClient; readonly signals: (AbortSignal | undefined)[] } {
      const signals: (AbortSignal | undefined)[] = [];
      const runSavedAgent = vi.fn((_input: unknown, signal?: AbortSignal) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      });
      return { client: { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent } as unknown as ToolApiClient, signals };
    }

    it('中断ボタンは実行中だけ出る（読み込み中や待機中には出さない）', async () => {
      const { client } = pendingClient();
      render(<ChatPage client={client} />);
      await screen.findByRole('option', { name: /Agent/ });
      expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();

      await sendMessage('slow question');
      expect(await screen.findByRole('button', { name: 'Stop run' })).toBeTruthy();
      // 実行中は送信ボタンと入れ替わる。
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('クリックでリクエストをabortし、エラーではなく中断として扱って入力を戻す', async () => {
      const { client, signals } = pendingClient();
      render(<ChatPage client={client} />);
      await screen.findByRole('option', { name: /Agent/ });
      await sendMessage('slow question');
      // 送信時点でコンポーザーは空になっている。
      expect((screen.getByLabelText('Chat message') as HTMLTextAreaElement).value).toBe('');

      await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));

      expect(signals[0]?.aborted).toBe(true);
      expect(await screen.findByText('Run cancelled. Your message is back in the composer.')).toBeTruthy();
      // 赤いエラーturnにはしない（Retryボタンも出さない）。
      expect(screen.queryByText('Error')).toBeNull();
      // 入力が戻るので、そのまま再送できる。
      expect((screen.getByLabelText('Chat message') as HTMLTextAreaElement).value).toBe('slow question');
      expect(await screen.findByRole('button', { name: 'Send' })).toBeTruthy();
    });

    it('中断後にそのまま再送できる', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const runSavedAgent = vi.fn()
        .mockImplementationOnce((_input: unknown, signal?: AbortSignal) => {
          signals.push(signal);
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
          });
        })
        .mockResolvedValue({ runId: 'run-retry', response: 'answered at last', trace: [], usage: {}, mode: 'preview' });
      const client = { listAgents: vi.fn().mockResolvedValue(oneAgent), runSavedAgent } as unknown as ToolApiClient;
      render(<ChatPage client={client} />);
      await screen.findByRole('option', { name: /Agent/ });
      await sendMessage('slow question');
      await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
      await screen.findByText('Run cancelled. Your message is back in the composer.');

      await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
      expect(await screen.findByText('answered at last')).toBeTruthy();
      expect(runSavedAgent).toHaveBeenNthCalledWith(2, expect.objectContaining({ message: 'slow question' }), expect.any(AbortSignal));
    });

    it('実行が長引くと段階的な案内を出す', async () => {
      vi.useFakeTimers();
      try {
        const { client } = pendingClient();
        render(<ChatPage client={client} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.change(screen.getByLabelText('Chat message'), { target: { value: 'slow question' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText('Sending the request to the model…')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        expect(screen.getByText('Waiting for the model to respond…')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(screen.getByText('Tools or the model are taking a while. You can stop the run at any time.')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
        expect(screen.getByText(/Still running\. The model can take up to 10 minutes/)).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Run 失敗の通知（RunFailureNotice）まわりの境界。トレースを引けない・runId が無い・古いクライアント・
 * 承認再開の失敗・中断・再試行後の見え方・日本語UI。
 */
describe('ChatPage の失敗通知（境界）', () => {
  const scope = { tenantId: 'local', workspaceId: 'default' };
  const agents = [{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }];

  afterEach(() => {
    consumePendingOpen('Tool'); consumePendingOpen('Agent');
    // I18nProvider(ja) は localStorage に言語を書く。後続テストの ApiError（構築時に言語を判定する）へ漏らさない。
    localStorage.removeItem('agentcontext.language');
  });

  it('runId の無い失敗（HTTP 層の ApiError）はトレースを引かず、通知と再試行だけを出す', async () => {
    const getRunTrace = vi.fn();
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent: vi.fn().mockRejectedValue(new ApiError(502, 'HTTP_ERROR', 'Bad Gateway')), getRunTrace } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    const alert = await screen.findByRole('alert');
    expect(getRunTrace).not.toHaveBeenCalled();
    expect(alert.querySelector('strong')?.textContent).toBe('Check that it is running, then retry');
    expect(alert.textContent).toContain('Could not reach the API server');
    expect(screen.getByText('Technical details').closest('details')?.textContent).not.toContain('Last tool call');
    expect(screen.queryByText('Error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('getRunTrace を持たないクライアントでも通知を出し、エージェント側のボタンは選択中のエージェントを区画つきで開く', async () => {
    const navigate = vi.fn();
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent: vi.fn().mockRejectedValue(new ApiError(422, 'AGENT_RUN', 'model requested unknown tool: lookup', 'run-old')) } as unknown as ToolApiClient;
    render(<NavigationProvider navigate={navigate}><ChatPage client={client} /></NavigationProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    expect((await screen.findByRole('alert')).textContent).toContain('Check the tools attached to this agent');
    await userEvent.click(screen.getByRole('button', { name: 'Open agent settings' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'agent', section: 'tools' });
  });

  it('失敗したツールのノードを開くボタンは、ツール・バージョン・ノード・区画を揃えて Tool 画面へ渡す', async () => {
    const navigate = vi.fn();
    const failed = new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail', { tool: { internalId: 'sales-lookup', version: '1.0.0', publishName: 'sales_lookup' }, nodeId: 'in-1' });
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent: vi.fn().mockRejectedValue(failed), getRunTrace: vi.fn().mockRejectedValue(new Error('gone')) } as unknown as ToolApiClient;
    render(<NavigationProvider navigate={navigate}><ChatPage client={client} /></NavigationProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    await userEvent.click(await screen.findByRole('button', { name: 'Open node "in-1" in tool "sales_lookup"' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'sales-lookup', version: '1.0.0', nodeId: 'in-1', section: 'agent-context' });
  });

  it('失敗の通知は会話ログに残り、再試行の成功応答はその後ろに積まれる', async () => {
    const runSavedAgent = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'AGENT_RUN', 'model requested unknown tool: lookup', 'run-fail'))
      .mockResolvedValueOnce({ runId: 'run-ok', response: 'recovered', trace: [], usage: {}, mode: 'preview' });
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent, getRunTrace: vi.fn().mockRejectedValue(new Error('gone')) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('please help');
    const alert = await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    const answer = await screen.findByText('recovered');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    // 通知（先）→ 成功応答（後）の順。
    expect(alert.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('成功した Run のトレースに mcp-server-skipped があれば、ステップ行として理由つきで言語化する（失敗通知は出さない）', async () => {
    const run = { runId: 'run-skip', mode: 'preview', response: 'ok', usage: {}, trace: [
      { sequence: 1, kind: 'mcp-server-skipped', server: 'files', reason: 'not-found' },
      { sequence: 2, kind: 'model-response', content: 'ok' },
    ] };
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent: vi.fn().mockResolvedValue(run) } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    expect(await screen.findByText(/MCP server 'files' were not loaded \(server not registered\)/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('中断は失敗通知にしない（role=alert も技術的な詳細も出さない）', async () => {
    const runSavedAgent = vi.fn((_input: unknown, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }));
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('slow question');
    await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));
    await screen.findByText('Run cancelled. Your message is back in the composer.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Technical details')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('承認後の再開で Run が失敗しても同じ通知（失敗箇所・直前のツール呼び出し）を出し、再試行は再開を呼び直す', async () => {
    const waiting = {
      runId: 'run-approval', mode: 'preview', response: 'Approve write_rows?', usage: {}, trace: [],
      status: 'waiting-approval', checkpoint: { prompt: 'Approve write_rows?', expiresAt: '2026-07-27T00:00:00.000Z', tool: 'write_rows', sideEffect: 'write' },
    };
    const failed = new ApiError(422, 'ETL_SCHEMA', 'sort: column(s) not found: total', 'run-approval', { tool: { internalId: 'writer', version: '1.0.0', publishName: 'write_rows' }, nodeId: 'sort-1' });
    const resumeRun = vi.fn().mockRejectedValue(failed);
    const getRunTrace = vi.fn().mockResolvedValue({ runId: 'run-approval', scope, status: 'failed', mode: 'preview', startedAt: 'now', trace: [
      { sequence: 1, kind: 'approval-resolved', decision: 'approve' },
      { sequence: 2, kind: 'tool-call', name: 'write_rows', arguments: { rows: 3 } },
    ] });
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent: vi.fn().mockResolvedValue(waiting), resumeRun, getRunTrace } as unknown as ToolApiClient;
    render(<ChatPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('write the rows');
    await screen.findByRole('group', { name: 'Tool approval' });
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed in tool write_rows v1.0.0 · node sort-1');
    expect(screen.getByText('Technical details').closest('details')?.textContent).toContain('{"rows":3}');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledTimes(2));
  });

  it('日本語UIでは通知の失敗箇所・ボタン・折りたたみが日本語になり、吹き出しの名前はエージェント名のまま', async () => {
    // ApiError は構築時に言語を判定するので、I18nProvider(ja) が localStorage へ書いた後に作る。
    const runSavedAgent = vi.fn().mockImplementation(() => Promise.reject(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail', { tool: { internalId: 'sales-lookup', publishName: 'sales_lookup' }, nodeId: 'in-1' })));
    const client = { listAgents: vi.fn().mockResolvedValue(agents), runSavedAgent, getRunTrace: vi.fn().mockRejectedValue(new Error('gone')) } as unknown as ToolApiClient;
    render(<I18nProvider initialLanguage="ja"><ChatPage client={client} /></I18nProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByLabelText('チャットメッセージ'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe('ツールの引数の説明を具体的にするか、指示の中でその値を明示してください');
    expect(alert.textContent).toContain('失敗箇所: ツール sales_lookup · ノード in-1');
    expect(screen.getByRole('button', { name: 'ツール「sales_lookup」のノード「in-1」を開いて直す' })).toBeTruthy();
    expect(screen.getByText('技術的な詳細')).toBeTruthy();
    expect(screen.getByText('Agent')).toBeTruthy();
    expect(screen.queryByText('エラー')).toBeNull();
  });
});
