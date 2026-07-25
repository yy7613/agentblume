// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, SerializedAgentDto } from '../api/types';
import { AgentInspectorPage } from './AgentInspectorPage';

afterEach(cleanup);

async function sendMessage(message = 'Inspect this run'): Promise<void> {
  await userEvent.type(screen.getByLabelText('Inspect message'), message);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

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

function makeClient(overrides: Partial<Record<'runSavedAgent' | 'getAgent' | 'listAgents' | 'evaluate' | 'reflectRun' | 'listWiki', unknown>> = {}) {
  return {
    listAgents: vi.fn().mockResolvedValue([{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.2.0', kind: 'normal', state: 'draft' }]),
    getAgent: vi.fn().mockResolvedValue(definition),
    runSavedAgent: vi.fn().mockResolvedValue(run),
    reflectRun: vi.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]),
    listWiki: vi.fn().mockResolvedValue([]),
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
    await sendMessage();
    const evalButton = await screen.findByRole('button', { name: 'Evaluate response' });
    await userEvent.click(evalButton);
    await waitFor(() => expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ output: '42 rows matched' })));
    // 直前のユーザー発話が input として渡る。
    expect((evaluate.mock.calls[0]?.[0] as { input: string }).input).toContain('Inspect this run');
    expect(await screen.findByText('keyword-coverage')).toBeTruthy();
    expect(screen.getByText('completeness')).toBeTruthy();
    expect(screen.getByText(/Average 75%/)).toBeTruthy();
  });

  it('応答を記憶へ蒸留し、生成された提案数を表示する（v21）', async () => {
    const reflectRun = vi.fn().mockResolvedValue([{ id: 'm1' }, { id: 'm2' }]);
    const client = makeClient({ reflectRun });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
    const distillButton = await screen.findByRole('button', { name: 'Distill to memory' });
    await userEvent.click(distillButton);
    // 直前ユーザー発話・応答・runId、対象Skill(先頭)を渡す。
    await waitFor(() => expect(reflectRun).toHaveBeenCalledWith(expect.objectContaining({ output: '42 rows matched', sourceRunId: 'run-123', targetSkillId: 'skill-a' })));
    expect(await screen.findByText(/2 proposal\(s\) drafted/)).toBeTruthy();
  });

  it('実行するとトークン・所要時間・呼ばれたTool・トレースを観測表示する', async () => {
    const client = makeClient();
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });

    await sendMessage();
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

  it('Wiki ページをアタッチして実行すると memoryPageIds を渡す（v21 M1）', async () => {
    const runSavedAgent = vi.fn().mockResolvedValue(run);
    const listWiki = vi.fn().mockResolvedValue([{ id: 'w1', title: 'Cohort SQL', tags: ['sql'], version: 2, updatedAt: 't' }]);
    const client = makeClient({ runSavedAgent, listWiki });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(await screen.findByText('Attach memory'));
    await userEvent.click(screen.getByRole('checkbox', { name: /Cohort SQL/ }));
    await sendMessage();
    await waitFor(() => expect(runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ memoryPageIds: ['w1'] })));
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
    await sendMessage();
    expect(await screen.findByText('No tools were called.')).toBeTruthy();
  });

  it('実行失敗をエラー吹き出しと所要時間で表示する（非Error理由）', async () => {
    const client = makeClient({ runSavedAgent: vi.fn().mockRejectedValue('kaboom') });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();
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
    await sendMessage();
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
    const client = { listAgents: vi.fn().mockResolvedValue([]), getAgent, runSavedAgent: vi.fn(), listWiki: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
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

  it('Agent一覧取得の失敗バナーは、その後の読み込みが成功すると消える', async () => {
    const failing = { listAgents: vi.fn().mockRejectedValue(new Error('offline')), listWiki: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
    const { rerender } = render(<AgentInspectorPage client={failing} />);
    expect(await screen.findByText('offline')).toBeTruthy();

    // client差し替え（再接続相当）で一覧取得が成功すると、居座っていたエラーバナーが消える。
    rerender(<AgentInspectorPage client={makeClient()} />);
    await waitFor(() => expect(screen.queryByText('offline')).toBeNull());
    expect(await screen.findByRole('option', { name: /Agent/ })).toBeTruthy();
  });

  it('実行失敗後、送信したユーザー発話は残りRetryで同じ入力を再送する', async () => {
    const runSavedAgent = vi.fn().mockRejectedValueOnce(new Error('model unavailable')).mockResolvedValueOnce(run);
    const client = makeClient({ runSavedAgent });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('please retry me');
    expect(await screen.findByText('model unavailable')).toBeTruthy();
    expect(screen.getByText('please retry me')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect((await screen.findAllByText('42 rows matched')).length).toBeGreaterThan(0);
    expect(runSavedAgent).toHaveBeenCalledTimes(2);
    expect((runSavedAgent.mock.calls[1]?.[0] as { message: string }).message).toBe('please retry me');
  });

  it('評価・蒸留の失敗はins-noneではなくfield-errorで目立たせる', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('eval down'));
    const reflectRun = vi.fn().mockRejectedValue(new Error('distill down'));
    const client = makeClient({ evaluate, reflectRun });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage();

    await userEvent.click(await screen.findByRole('button', { name: 'Evaluate response' }));
    const evalError = await screen.findByText('Evaluation failed.');
    expect(evalError.className).toContain('field-error');
    expect(evalError.className).not.toContain('ins-none');

    await userEvent.click(screen.getByRole('button', { name: 'Distill to memory' }));
    const distillError = await screen.findByText('Distillation failed.');
    expect(distillError.className).toContain('field-error');
    expect(distillError.className).not.toContain('ins-none');
  });

  it('busy中は経過秒数を1秒毎に更新して表示する', async () => {
    let resolveRun: (value: unknown) => void = () => {};
    const runSavedAgent = vi.fn().mockReturnValue(new Promise((resolve) => { resolveRun = resolve; }));
    const client = makeClient({ runSavedAgent });
    render(<AgentInspectorPage client={client} />);
    // Agent一覧の解決とテキスト入力は実タイマーで済ませてから、経過秒数の検証だけfake timersに切り替える。
    await screen.findByRole('option', { name: /Agent/ });
    fireEvent.change(screen.getByLabelText('Inspect message'), { target: { value: 'hello' } });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Running… 0s')).toBeTruthy();
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(screen.getByText('Running… 1s')).toBeTruthy();
      resolveRun(run);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getAllByText('42 rows matched').length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
