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

function makeClient(overrides: Partial<Record<'runSavedAgent' | 'getAgent' | 'listAgents', unknown>> = {}) {
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
});
