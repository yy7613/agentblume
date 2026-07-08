// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, SerializedAgentDto } from '../api/types';
import { AgentInspectorPage } from './AgentInspectorPage';

afterEach(cleanup);

const definition = {
  metadata: { internalId: 'agent', workingName: 'w', displayName: 'Agent', publishName: 'agent', version: '1.2.0', owner: 'o', state: 'draft', tenant: { tenantId: 'local', workspaceId: 'default' } },
  kind: 'normal', systemPrompt: 'Use tools.',
  skills: [{ internalId: 'skill-a', version: '1.0.0' }],
  tools: [{ internalId: 'tool-x', version: '2.0.0' }],
  agents: [],
} as SerializedAgentDto;

const run: AgentPreviewRunDto = {
  runId: 'run-123', mode: 'preview', agent: { internalId: 'agent', version: '1.2.0' }, tools: [{ internalId: 'tool-x', version: '2.0.0' }],
  response: '42 rows matched', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  trace: [
    { sequence: 1, kind: 'model-request', step: 1, toolNames: ['tool_x'] },
    { sequence: 2, kind: 'tool-call', name: 'tool_x', arguments: { minAge: 18 } },
    { sequence: 3, kind: 'tool-result', name: 'tool_x', terminalId: 'n1', nodes: [{ nodeId: 'n1', rowCount: 42, truncated: false }], outputPreview: [{}] },
    { sequence: 4, kind: 'model-response', content: '42 rows matched' },
  ],
};

function makeClient(overrides: Partial<Record<'runSavedAgent' | 'getAgent' | 'listAgents' | 'evaluate', unknown>> = {}) {
  return {
    listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.2.0', kind: 'normal', state: 'draft' }]),
    getAgent: vi.fn().mockResolvedValue(definition),
    runSavedAgent: vi.fn().mockResolvedValue(run),
    ...overrides,
  } as unknown as ToolApiClient;
}

describe('AgentInspectorPage', () => {
  it('選択エージェントの能力（Skill/Tool）を能力バーに表示する', async () => {
    const client = makeClient();
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    // getAgentで取得した定義のSkill/Toolがチップとして出る。
    expect(await screen.findByText('skill-a')).toBeTruthy();
    expect(screen.getByText('tool-x')).toBeTruthy();
    await waitFor(() => expect(client.getAgent).toHaveBeenCalledWith('agent', expect.anything(), undefined, expect.any(AbortSignal)));
  });

  it('応答をMastra Evalsで評価しスコアバーを表示する（v20）', async () => {
    const evaluate = vi.fn().mockResolvedValue({ scores: [{ metric: 'keyword-coverage', score: 0.83 }, { metric: 'completeness', score: 0.66 }], average: 0.75 });
    const client = makeClient({ evaluate });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    const evalButton = await screen.findByRole('button', { name: 'Evaluate response' });
    await userEvent.click(evalButton);
    await waitFor(() => expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ output: '42 rows matched' })));
    // 直前のユーザー発話が input として渡る。
    expect((evaluate.mock.calls[0]?.[0] as { input: string }).input).toContain('Call your tools');
    expect(await screen.findByText('keyword-coverage')).toBeTruthy();
    expect(screen.getByText('completeness')).toBeTruthy();
    expect(screen.getByText(/Average 75%/)).toBeTruthy();
  });

  it('実行するとトークン・所要時間・呼ばれたTool・トレースを観測表示する', async () => {
    const client = makeClient();
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    // 応答本文はバブルとトレース(model-response)の両方に現れる。
    expect((await screen.findAllByText('42 rows matched')).length).toBeGreaterThan(0);

    // メトリクス: 合計トークンと各ラベル。
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('100 → 20')).toBeTruthy();
    expect(screen.getByText('Total tokens')).toBeTruthy();
    expect(screen.getByText('Tool calls')).toBeTruthy();
    expect(screen.getByText('Model rounds')).toBeTruthy();
    expect(screen.getByText('Elapsed')).toBeTruthy();

    // 呼ばれたTool: 回数・行数。
    expect(screen.getByText('×1')).toBeTruthy();
    expect(screen.getByText('42 rows')).toBeTruthy();

    // トレースの件数サマリ。
    expect(screen.getByText(/Trace · 4 events · run run-123/)).toBeTruthy();

    expect(client.runSavedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agent: { internalId: 'agent', version: '1.2.0' }, mode: 'preview' }),
    );
  });

  it('ツール未使用の実行では「呼ばれたツールなし」を示す', async () => {
    const noTools: AgentPreviewRunDto = {
      runId: 'run-x', mode: 'preview', response: 'no tools here', usage: {},
      trace: [
        { sequence: 1, kind: 'model-request', step: 1, toolNames: [] },
        { sequence: 2, kind: 'model-response', content: 'no tools here' },
      ],
    };
    const client = makeClient({ runSavedAgent: vi.fn().mockResolvedValue(noTools) });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('No tools were called.')).toBeTruthy();
  });

  it('実行失敗をエラー吹き出しと所要時間で表示する（非Error理由）', async () => {
    const client = makeClient({ runSavedAgent: vi.fn().mockRejectedValue('kaboom') });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Request failed')).toBeTruthy();
    expect(screen.getByText('Error')).toBeTruthy();
  });

  it('トレース詳細でerror・空応答を整形し、長い引数を切り詰める', async () => {
    const run: AgentPreviewRunDto = {
      runId: 'run-t', mode: 'preview', response: '', usage: {},
      trace: [
        { sequence: 1, kind: 'model-request', step: 1, toolNames: ['t'] },
        { sequence: 2, kind: 'tool-call', name: 't', arguments: { q: 'x'.repeat(200) } },
        { sequence: 3, kind: 'model-response', content: '' },
        { sequence: 4, kind: 'error', code: 'E_Y', message: 'boom' },
      ],
    };
    const client = makeClient({ runSavedAgent: vi.fn().mockResolvedValue(run) });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('E_Y: boom')).toBeTruthy();
    expect(screen.getByText('(empty)')).toBeTruthy();
    expect(screen.getAllByText(/…/).length).toBeGreaterThan(0);
  });

  it('構造化出力あり・Skill/Tool未設定の能力バーを表示する', async () => {
    const def = { ...definition, skills: [], tools: [], output: { name: 'result', fields: [] } } as SerializedAgentDto;
    const client = makeClient({ getAgent: vi.fn().mockResolvedValue(def) });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    expect(await screen.findByText(/Structured output/)).toBeTruthy();
    expect(screen.getAllByText('none').length).toBe(2);
  });

  it('Agentが無い場合は保存を促し、getAgentを呼ばない', async () => {
    const getAgent = vi.fn();
    const client = { listAgents: vi.fn().mockResolvedValue([]), getAgent, runSavedAgent: vi.fn() } as unknown as ToolApiClient;
    render(<AgentInspectorPage client={client} />);
    expect(await screen.findByText('Save an Agent in Agent Builder first.')).toBeTruthy();
    expect(getAgent).not.toHaveBeenCalled();
  });

  it('getAgent失敗時は能力バーを出さずに動作する', async () => {
    const client = makeClient({ getAgent: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    expect(screen.queryByText('skill-a')).toBeNull();
    expect(screen.queryByText(/Structured output/)).toBeNull();
  });
});
