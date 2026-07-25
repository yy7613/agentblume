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

  it('運用メトリクスを表示しAgent runへfeedbackを保存する', async () => {
    const summary = { runId: 'run-observed', status: 'succeeded', mode: 'preview', purpose: 'interactive', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', response: 'answer', traceEventCount: 1 };
    const record = { ...summary, scope: { tenantId: 'local', workspaceId: 'default' }, model: { provider: 'scripted', model: 'scripted', modelConfigHash: 'hash' }, latency: { totalMs: 20, modelMs: 18, toolMs: 0 }, estimatedCost: { kind: 'estimated', amount: 0.0002, currency: 'USD', price: { currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '1970-01-01T00:00:00Z' } }, trace: [{ sequence: 1, kind: 'model-response', content: 'answer' }] };
    const operations = { from: '2026-07-01T00:00:00Z', to: '2026-07-03T00:00:00Z', summary: { runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }, points: [{ bucketStart: '2026-07-03T00:00:00Z', runCount: 1, failureRate: 0, p50LatencyMs: 20, p95LatencyMs: 20, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 0 }] };
    const submitRunFeedback = vi.fn().mockResolvedValue({ id: 'feedback', scope: record.scope, runId: record.runId, agent: record.agent, thumb: 'down', rating: 2, comment: 'wrong', issueTags: ['incorrect'], createdAt: 'now', updatedAt: 'now' });
    const client = { listRuns: vi.fn().mockResolvedValue([summary]), getRunTrace: vi.fn().mockResolvedValue(record), getOperationsStatus: vi.fn().mockResolvedValue(operations), getRunFeedback: vi.fn().mockResolvedValue(null), submitRunFeedback } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    expect((await screen.findAllByText('20.0 ms')).length).toBe(2);
    await userEvent.click(screen.getByRole('button', { name: /agent/ }));
    expect(await screen.findByText('scripted / scripted')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Needs work|要改善/ }));
    await userEvent.selectOptions(screen.getByLabelText(/Rating|評価/), '2');
    await userEvent.type(screen.getByLabelText(/Issue tags|課題タグ/), 'incorrect');
    await userEvent.type(screen.getByLabelText(/Comment|コメント/), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /Save feedback|フィードバックを保存/ }));
    await waitFor(() => expect(submitRunFeedback).toHaveBeenCalledWith('run-observed', expect.objectContaining({ thumb: 'down', rating: 2, comment: 'wrong', issueTags: ['incorrect'] })));
    expect((await screen.findByRole('status')).textContent).toMatch(/Saved|保存しました/);

    // コメント再編集で「保存しました」表示がリセットされ、誤って最新扱いされない。
    await userEvent.type(screen.getByLabelText(/Comment|コメント/), '!');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('トレース選択に失敗した後、別の選択が成功すると前回のエラーが消える（role=alertの誤通知防止）', async () => {
    const summaryA = { runId: 'run-a', status: 'failed', mode: 'preview', tool: { internalId: 'tool-a', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', traceEventCount: 0 };
    const summaryB = { runId: 'run-b', status: 'succeeded', mode: 'preview', tool: { internalId: 'tool-b', version: '1.0.0' }, startedAt: '2026-07-03T00:00:00Z', traceEventCount: 1 };
    const recordB = { ...summaryB, scope: { tenantId: 'local', workspaceId: 'default' }, trace: [{ sequence: 1, kind: 'model-response', content: 'ok' }] };
    const getRunTrace = vi.fn().mockRejectedValueOnce(new Error('trace unavailable')).mockResolvedValueOnce(recordB);
    const client = { listRuns: vi.fn().mockResolvedValue([summaryA, summaryB]), getRunTrace } as unknown as ToolApiClient;
    render(<StatusPage client={client} />);
    await userEvent.click(await screen.findByRole('button', { name: /tool-a/ }));
    expect(await screen.findByText('trace unavailable')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /tool-b/ }));
    await waitFor(() => expect(screen.queryByText('trace unavailable')).toBeNull());
    expect(await screen.findByText('run-b')).toBeTruthy();
  });
});
