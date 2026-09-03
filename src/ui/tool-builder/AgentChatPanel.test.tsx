// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ToolApiClient } from '../api/tool-api';
import type { RunTraceEventDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { consumePendingOpen } from '../navigation';
import { AgentChatPanel } from './AgentChatPanel';
import { useToolBuilderStore } from './store';

const scope = { tenantId: 'local', workspaceId: 'default' };

/** 保存済みツールを編集中の状態にする（失敗箇所のフォールバック先）。 */
function savedTool(publishName = 'sales_lookup'): void {
  const store = useToolBuilderStore.getState();
  store.setMetadata('internalId', 'sales-lookup');
  store.setMetadata('publishName', publishName);
  store.setSavedVersion('1.2.0', ['1.2.0']);
}

function makeClient(overrides: Record<string, unknown> = {}): ToolApiClient {
  return { runAgent: vi.fn(), getRunTrace: vi.fn().mockRejectedValue(new Error('gone')), ...overrides } as unknown as ToolApiClient;
}

async function runAgent(message = 'use the tool'): Promise<void> {
  await userEvent.type(screen.getByLabelText('Chat message'), message);
  await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
}

const failedTrace: readonly RunTraceEventDto[] = [
  { sequence: 1, kind: 'model-request', step: 1, toolNames: ['sales_lookup'] },
  { sequence: 2, kind: 'mcp-server-skipped', server: 'files', reason: 'not-found' },
  { sequence: 3, kind: 'tool-call', name: 'sales_lookup', arguments: { month: '2026-06' } },
  { sequence: 4, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year (retrying 1/1)' },
];

beforeEach(() => useToolBuilderStore.getState().reset());
afterEach(() => { cleanup(); consumePendingOpen('Tool'); consumePendingOpen('Agent'); });

describe('AgentChatPanel', () => {
  it('保存前は実行できない（ボタン無効・保存を促す案内）', () => {
    render(<AgentChatPanel client={makeClient()} />);
    expect(screen.getByText('Save first')).toBeTruthy();
    expect(screen.getByText('Save a validated Tool before connecting it to an Agent.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Run agent' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('サーバーが失敗箇所のツールを返さない失敗は、編集中のツール（internalId / 保存済み version / publishName）を失敗箇所にしてボタンで開く', async () => {
    savedTool();
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail')) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledWith(expect.objectContaining({ tool: { internalId: 'sales-lookup', version: '1.2.0' }, mode: 'preview' }), expect.any(AbortSignal)));
    const alert = await screen.findByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe('Describe that argument more concretely in the tool, or state its value in your request');
    expect(alert.textContent).toContain('Failed in tool sales_lookup v1.2.0');
    await userEvent.click(screen.getByRole('button', { name: 'Open tool "sales_lookup"' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'sales-lookup', version: '1.2.0', section: 'agent-context' });
  });

  it('publishName が空なら internalId で名指しする（空文字の publishName を渡さない）', async () => {
    savedTool('');
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail')) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    expect((await screen.findByRole('alert')).textContent).toContain('Failed in tool sales-lookup v1.2.0');
    expect(screen.getByRole('button', { name: 'Open tool "sales-lookup"' })).toBeTruthy();
  });

  it('サーバーが失敗箇所のツールとノードを返せばそちらを優先する（編集中のツールで上書きしない）', async () => {
    savedTool();
    const failed = new ApiError(422, 'ETL_SCHEMA', 'sort: column(s) not found: total', 'run-fail', { tool: { internalId: 'other-tool', version: '2.0.0', publishName: 'other_tool' }, nodeId: 'sort-1' });
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(failed) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    expect((await screen.findByRole('alert')).textContent).toContain('Failed in tool other_tool v2.0.0 · node sort-1');
    await userEvent.click(screen.getByRole('button', { name: 'Open node "sort-1" in tool "other_tool"' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'other-tool', version: '2.0.0', nodeId: 'sort-1' });
  });

  it('失敗した Run のトレースを引き、通知の詳細（直前のツール呼び出し）と失敗トレース欄（言語化した行・code は title）を出す', async () => {
    savedTool();
    const getRunTrace = vi.fn().mockResolvedValue({ runId: 'run-fail', scope, status: 'failed', mode: 'preview', startedAt: 'now', trace: failedTrace });
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail')), getRunTrace });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    await waitFor(() => expect(getRunTrace).toHaveBeenCalledWith('run-fail', scope));
    expect(await screen.findByText('Failed trace · run-fail')).toBeTruthy();
    // error 行: 本文は言語化し retrying 接尾辞を保つ。code は本文に出さず title に残す。
    const row = screen.getByTitle('TOOL_ARGUMENTS');
    expect(row.textContent).toBe("the model omitted the required tool argument 'year'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)");
    expect(screen.queryByText('required argument missing: year (retrying 1/1)')).toBeNull();
    // mcp-server-skipped 行は理由つきの案内。
    expect(screen.getAllByText(/MCP server 'files' were not loaded \(server not registered\)/).length).toBeGreaterThan(0);
    // 通知の折りたたみには失敗直前の tool-call の引数が入る。
    expect(screen.getByText('Technical details').closest('details')?.textContent).toContain('{"month":"2026-06"}');
  });

  it('トレースの取得に失敗しても通知は出し、失敗トレース欄は出さない', async () => {
    savedTool();
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(422, 'AGENT_RUN', 'model requested unknown tool: lookup', 'run-fail')), getRunTrace: vi.fn().mockRejectedValue(new Error('trace unavailable')) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    expect((await screen.findByRole('alert')).textContent).toContain('Check the tools attached to this agent');
    expect(screen.queryByText(/Failed trace/)).toBeNull();
    expect(screen.queryByText('trace unavailable')).toBeNull();
  });

  it('runId の無い失敗はトレースを引かない', async () => {
    savedTool();
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(502, 'HTTP_ERROR', 'Bad Gateway')) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    await screen.findByRole('alert');
    expect(client.getRunTrace).not.toHaveBeenCalled();
  });

  it('ツール定義由来でない失敗（モデル障害・接続失敗）は編集中のツールを失敗箇所にせず、ツールを開くボタンも出さない', async () => {
    savedTool();
    const client = makeClient({ runAgent: vi.fn()
      .mockRejectedValueOnce(new ApiError(502, 'MODEL_PROVIDER', 'Model request failed: connect ECONNREFUSED', 'run-fail'))
      .mockRejectedValueOnce(new ApiError(422, 'AGENT_RUN', 'configured model provider does not support tool-calling', 'run-fail')) });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('Failed in tool');
    expect(screen.queryByRole('button', { name: /Open tool/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open model settings' })).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
    await waitFor(() => expect(client.runAgent).toHaveBeenCalledTimes(2));
    expect((await screen.findByRole('alert')).textContent).not.toContain('Failed in tool');
    expect(screen.queryByRole('button', { name: /Open tool/ })).toBeNull();
  });

  it('ApiError 以外の失敗は文言だけのエラーにする（非 Error の理由も既定文言で受ける）', async () => {
    savedTool();
    const runAgentMock = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce('boom');
    const client = makeClient({ runAgent: runAgentMock });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    expect((await screen.findByRole('alert')).textContent).toBe('offline');
    expect(screen.queryByText('Technical details')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
    expect(await screen.findByText('Agent run failed')).toBeTruthy();
  });

  it('失敗のあと成功すれば通知と失敗トレース欄は消え、応答とトレースに置き換わる', async () => {
    savedTool();
    const runAgentMock = vi.fn()
      .mockRejectedValueOnce(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail'))
      .mockResolvedValueOnce({ runId: 'run-ok', response: 'done', trace: [{ sequence: 1, kind: 'model-response', content: 'done' }], usage: {}, mode: 'preview' });
    const getRunTrace = vi.fn().mockResolvedValue({ runId: 'run-fail', scope, status: 'failed', mode: 'preview', startedAt: 'now', trace: failedTrace });
    const client = makeClient({ runAgent: runAgentMock, getRunTrace });
    render(<AgentChatPanel client={client} />);
    await runAgent();
    await screen.findByText('Failed trace · run-fail');
    await userEvent.click(screen.getByRole('button', { name: 'Run agent' }));
    expect(await screen.findByText('done')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/Failed trace/)).toBeNull();
    expect(screen.getByText('Trace · run-ok')).toBeTruthy();
  });

  it('日本語UIでは失敗箇所・失敗トレース欄・トレース行が日本語になる', async () => {
    savedTool();
    const getRunTrace = vi.fn().mockResolvedValue({ runId: 'run-fail', scope, status: 'failed', mode: 'preview', startedAt: 'now', trace: failedTrace });
    const client = makeClient({ runAgent: vi.fn().mockRejectedValue(new ApiError(422, 'TOOL_ARGUMENTS', 'required argument missing: year', 'run-fail')), getRunTrace });
    render(<I18nProvider initialLanguage="ja"><AgentChatPanel client={client} /></I18nProvider>);
    await userEvent.type(screen.getByLabelText('チャットメッセージ'), 'use the tool');
    await userEvent.click(screen.getByRole('button', { name: 'エージェントを実行' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('失敗箇所: ツール sales_lookup v1.2.0');
    expect(await screen.findByText('失敗トレース · run-fail')).toBeTruthy();
    expect(screen.getByTitle('TOOL_ARGUMENTS').textContent).toContain('必須引数「year」を渡しませんでした');
    expect(screen.getByTitle('TOOL_ARGUMENTS').textContent).toContain('（再試行 1/1）');
    expect(screen.getAllByText(/MCPサーバー「files」のツールを読み込めませんでした（未登録）/).length).toBeGreaterThan(0);
  });
});
