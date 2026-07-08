// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { useToolBuilderStore } from '../tool-builder/store';
import { StatusPage } from './StatusPage';

beforeEach(() => useToolBuilderStore.getState().reset());
afterEach(cleanup);

describe('StatusPage', () => {
  it('run一覧から失敗trace詳細を開く', async () => {
    const summary = { runId: 'run-1', status: 'failed', mode: 'preview', tool: { internalId: 'tool', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', failure: { code: 'MODEL_PROVIDER', message: 'offline' }, traceEventCount: 2 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [
      { sequence: 1, kind: 'model-request', step: 1, toolNames: ['tool'] },
      { sequence: 2, kind: 'error', code: 'MODEL_PROVIDER', message: 'offline' },
    ] };
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record) } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /tool/ }));
    await waitFor(() => expect(client.getRunTrace).toHaveBeenCalledWith('run-1', { tenantId: 'local', workspaceId: 'default' }));
    expect(screen.getAllByText(/MODEL_PROVIDER/).length).toBeGreaterThan(0);
    expect(screen.getByText('run-1')).toBeTruthy();
  });

  it('Agent runのstructured responseを整形表示する', async () => {
    const summary = { runId: 'run-json', status: 'succeeded', mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: '{"answer":"done"}', traceEventCount: 1 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, structuredResponse: { answer: 'done' }, trace: [{ sequence: 1, kind: 'model-response', content: '{"answer":"done"}' }] };
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record) } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /agent/ }));
    expect(await screen.findByText(/"answer": "done"/)).toBeTruthy();
  });

  it('agent_callイベントのchild runボタンから子Runトレースへ辿る', async () => {
    const parentSummary = { runId: 'run-parent', status: 'succeeded', mode: 'preview', agent: { internalId: 'coordinator', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'ok', traceEventCount: 2 };
    const parent = { ...parentSummary, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [
      { sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' },
      { sequence: 2, kind: 'model-response', content: 'ok' },
    ] };
    const child = { runId: 'run-child', status: 'succeeded', mode: 'preview', scope: { tenantId: 'local', workspaceId: 'default' }, agent: { internalId: 'scorer', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'scored 42', trace: [{ sequence: 1, kind: 'model-response', content: 'scored 42' }] };
    const getRunTrace = vi.fn().mockResolvedValueOnce(parent).mockResolvedValueOnce(child);
    const client = { listRuns: vi.fn().mockResolvedValue([parentSummary]), getRunTrace } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /coordinator/ }));
    expect(await screen.findByText(/ask_scorer/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'child run' }));
    await waitFor(() => expect(getRunTrace).toHaveBeenLastCalledWith('run-child', { tenantId: 'local', workspaceId: 'default' }));
    expect(await screen.findByText('run-child')).toBeTruthy();
  });
});
