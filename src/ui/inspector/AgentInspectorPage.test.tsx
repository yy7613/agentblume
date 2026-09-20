// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { AgentPreviewRunDto, SerializedAgentDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { AgentInspectorPage } from './AgentInspectorPage';

afterEach(() => { cleanup(); consumePendingOpen('Tool'); });

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

function makeClient(overrides: Partial<Record<'runSavedAgent' | 'getAgent' | 'listAgents' | 'evaluate' | 'reflectRun' | 'listWiki' | 'resumeRun' | 'diagnoseAgent', unknown>> = {}) {
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

  it('ツール診断を実行し、段階別の検査結果と原因を表示する', async () => {
    const diagnoseAgent = vi.fn().mockResolvedValue({
      agent: { internalId: 'agent', version: '1.2.0' },
      status: 'error',
      checks: [
        { id: 'skills', status: 'ok' },
        { id: 'function-names', status: 'ok' },
      ],
      tools: [{
        internalId: 'tool-x', version: '2.0.0', source: 'direct', functionName: 'tool_x', status: 'error',
        checks: [
          { id: 'resolved', status: 'ok' },
          { id: 'output-schema', status: 'error', detail: "declared output schema does not match the graph's inferred output (column count mismatch: expected 1, received 5)" },
        ],
      }],
    });
    const client = makeClient({ diagnoseAgent });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnose tools' }));
    await waitFor(() => expect(diagnoseAgent).toHaveBeenCalledWith('agent', expect.anything(), '1.2.0', expect.any(AbortSignal)));
    // 全体バッジ・検査ラベル・原因の生メッセージが出る。ok の項目も一覧される。
    expect(await screen.findByText('Blocked')).toBeTruthy();
    expect(screen.getByText('Skill references')).toBeTruthy();
    expect(screen.getByText('Output schema consistency')).toBeTruthy();
    expect(screen.getByText(/column count mismatch: expected 1, received 5/)).toBeTruthy();
    expect(screen.getByText('tool_x')).toBeTruthy();
    // 閉じるとパネルが消える。
    await userEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
    expect(screen.queryByText('Blocked')).toBeNull();
  });

  it('診断の問題行から「ツールを開く」で Tool 画面へ対象を預けて遷移する', async () => {
    const diagnoseAgent = vi.fn().mockResolvedValue({
      agent: { internalId: 'agent', version: '1.2.0' }, status: 'error', checks: [{ id: 'skills', status: 'ok' }],
      tools: [{ internalId: 'tool-x', version: '2.0.0', source: 'direct', functionName: 'tool_x', status: 'error', checks: [{ id: 'graph', status: 'error', nodeId: 'filter-1', detail: 'graph has a cycle' }] }],
    });
    const navigate = vi.fn();
    render(<NavigationProvider navigate={navigate}><AgentInspectorPage client={makeClient({ diagnoseAgent })} /></NavigationProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnose tools' }));
    await screen.findByText('Blocked');
    // どのノードで落ちたかを示し、そのツールをそのノードで開いて直せる。
    expect(screen.getByText('filter-1')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open node "filter-1"' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'tool-x', version: '2.0.0', nodeId: 'filter-1' });
  });

  it('トレースの error は次の一手が分かる文言へ直す（日本語UI）', async () => {
    const failed: AgentPreviewRunDto = {
      runId: 'run-l', mode: 'preview', response: '', usage: {},
      trace: [{ sequence: 1, kind: 'error', code: 'AGENT_RUN', message: 'tool call limit exceeded: maximum 8' }],
    };
    render(<I18nProvider initialLanguage="ja"><AgentInspectorPage client={makeClient({ runSavedAgent: vi.fn().mockResolvedValue(failed) })} /></I18nProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByLabelText('動作確認メッセージ'), 'go');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText(/AGENT_RUN: 1回の実行で使えるツール呼び出しの上限（8回）に達しました/)).toBeTruthy();
    expect(screen.queryByText(/tool call limit exceeded/)).toBeNull();
  });

  it('トレースの error は再試行の注記を言語に合わせて付け直し、mcp-server-skipped の行も描く（日本語UI）', async () => {
    const failed: AgentPreviewRunDto = {
      runId: 'run-retry', mode: 'preview', response: '', usage: {},
      trace: [
        { sequence: 1, kind: 'mcp-server-skipped', server: 'files', reason: 'disabled' },
        { sequence: 2, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 1/1)' },
      ],
    };
    render(<I18nProvider initialLanguage="ja"><AgentInspectorPage client={makeClient({ runSavedAgent: vi.fn().mockResolvedValue(failed) })} /></I18nProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByLabelText('動作確認メッセージ'), 'go');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
    expect(await screen.findByText('TOOL_ARGUMENTS: モデルがツールの必須引数「month」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください（再試行 1/1）')).toBeTruthy();
    expect(screen.queryByText(/retrying 1\/1/)).toBeNull();
    expect(screen.getByText('MCPサーバーをスキップ: files (disabled)')).toBeTruthy();
  });

  it('正常: 0行だったツール実行の行に、外した条件と実在する値の例を出す（日本語UI）', async () => {
    const zero: AgentPreviewRunDto = {
      runId: 'run-nomatch', mode: 'preview', response: '該当データはありません', usage: {},
      trace: [
        { sequence: 1, kind: 'tool-result', name: 'get_population_data', terminalId: 'narrow', nodes: [{ nodeId: 'narrow', rowCount: 0, truncated: false }], outputPreview: [], noMatch: {
          message: 'No rows matched.', nodeId: 'narrow', combine: 'and',
          conditions: [
            { column: '地域', op: 'eq', argument: 'region_name', value: '東京都', matchingRows: 70 },
            { column: '時点', op: 'eq', argument: 'time_point', value: '2015年12月31日', matchingRows: 0, availableValues: ['2015年', '2016年'], distinctValues: 70 },
          ],
        } },
      ],
    };
    render(<I18nProvider initialLanguage="ja"><AgentInspectorPage client={makeClient({ runSavedAgent: vi.fn().mockResolvedValue(zero) })} /></I18nProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByLabelText('動作確認メッセージ'), 'go');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));

    expect(await screen.findByText('get_population_data · narrow:0 · 該当0件: 時点 eq "2015年12月31日" → 2015年 / 2016年')).toBeTruthy();
  });

  async function renderNoMatch(condition: Record<string, unknown>): Promise<void> {
    const zero = {
      runId: 'run-nomatch-list', mode: 'preview', response: '該当データはありません', usage: {},
      trace: [{ sequence: 1, kind: 'tool-result', name: 'get_population', terminalId: 'narrow', nodes: [{ nodeId: 'narrow', rowCount: 0, truncated: false }], outputPreview: [], noMatch: { message: 'No rows matched.', nodeId: 'narrow', combine: 'and', conditions: [condition] } }],
    } as unknown as AgentPreviewRunDto;
    render(<I18nProvider initialLanguage="ja"><AgentInspectorPage client={makeClient({ runSavedAgent: vi.fn().mockResolvedValue(zero) })} /></I18nProvider>);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.type(screen.getByLabelText('動作確認メッセージ'), 'go');
    await userEvent.click(screen.getByRole('button', { name: '送信' }));
  }

  it('正常: 複数値の条件（in）は渡した並びを見せ、空振りした値を「該当なし」として添える', async () => {
    await renderNoMatch({ column: '地域', op: 'in', argument: 'regions', values: ['東京', '大阪'], matchingRows: 0, unmatchedValues: ['東京', '大阪'], availableValues: ['東京都', '大阪府'], distinctValues: 48 });

    expect(await screen.findByText('get_population · narrow:0 · 該当0件: 地域 in ["東京","大阪"] (該当なし: 東京 / 大阪) → 東京都 / 大阪府')).toBeTruthy();
  });

  it('境界: 空振りした値は 3 件まで出す。空の一覧なら「該当なし」の括弧ごと出さない', async () => {
    await renderNoMatch({ column: '地域', op: 'in', values: ['a', 'b', 'c', 'd'], matchingRows: 0, unmatchedValues: ['a', 'b', 'c', 'd'] });
    expect(await screen.findByText('get_population · narrow:0 · 該当0件: 地域 in ["a","b","c","d"] (該当なし: a / b / c)')).toBeTruthy();
    cleanup();

    await renderNoMatch({ column: '地域', op: 'notIn', values: ['a'], matchingRows: 0, unmatchedValues: [] });
    expect(await screen.findByText('get_population · narrow:0 · 該当0件: 地域 notIn ["a"]')).toBeTruthy();
  });

  it('英語UIでは再試行の注記を原文の形で残し、mcp-server-skipped の detail を添える', async () => {
    const failed: AgentPreviewRunDto = {
      runId: 'run-retry-en', mode: 'preview', response: '', usage: {},
      trace: [
        { sequence: 1, kind: 'mcp-server-skipped', server: 'files', reason: 'unreachable', detail: 'ECONNREFUSED' },
        { sequence: 2, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: month (retrying 1/1)' },
      ],
    };
    render(<AgentInspectorPage client={makeClient({ runSavedAgent: vi.fn().mockResolvedValue(failed) })} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('go');
    expect(await screen.findByText("TOOL_ARGUMENTS: the model omitted the required tool argument 'month'. Describe that argument more concretely in the tool, or state its value in your request (retrying 1/1)")).toBeTruthy();
    expect(screen.getByText('MCP server skipped: files (unreachable) · ECONNREFUSED')).toBeTruthy();
  });

  it('診断中はボタンを無効にし、エージェントを切り替えると進行中の診断を中断して結果を捨てる', async () => {
    const pending: { readonly resolve: (value: unknown) => void; readonly signal: AbortSignal | undefined }[] = [];
    const diagnoseAgent = vi.fn((_id: string, _scope: unknown, _version: string | undefined, signal?: AbortSignal) => new Promise((resolve) => { pending.push({ resolve, signal }); }));
    const listAgents = vi.fn().mockResolvedValue([
      { internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.2.0', kind: 'normal', state: 'draft' },
      { internalId: 'other', displayName: 'Other', publishName: 'other', latestVersion: '1.0.0', kind: 'normal', state: 'draft' },
    ]);
    render(<AgentInspectorPage client={makeClient({ diagnoseAgent, listAgents })} />);
    await screen.findByRole('option', { name: /Other/ });
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnose tools' }));
    expect((screen.getByRole('button', { name: 'Diagnosing…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(pending).toHaveLength(1);

    await userEvent.selectOptions(screen.getByRole('combobox'), 'other');
    expect(pending[0]?.signal?.aborted).toBe(true);
    expect(await screen.findByRole('button', { name: 'Diagnose tools' })).toBeTruthy();
    await act(async () => { pending[0]?.resolve({ agent: { internalId: 'agent', version: '1.2.0' }, status: 'error', checks: [{ id: 'model', status: 'error', detail: 'x' }], tools: [] }); });
    expect(screen.queryByText('Blocked')).toBeNull();
  });

  it('診断リクエストの失敗はアラートとして表示する', async () => {
    const client = makeClient({ diagnoseAgent: vi.fn().mockRejectedValue(new Error('server unreachable')) });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await userEvent.click(await screen.findByRole('button', { name: 'Diagnose tools' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/server unreachable/)).toBeTruthy();
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
      expect.any(AbortSignal),
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
    await waitFor(() => expect(runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ memoryPageIds: ['w1'] }), expect.any(AbortSignal)));
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

  it('承認待ちのRunで承認バナーを出し、Approveのたびにresume結果を積んで完走で消す', async () => {
    const waiting = (runId: string, tool: string): AgentPreviewRunDto => ({
      runId, mode: 'preview', response: `Approve ${tool}?`, usage: {},
      trace: [{ sequence: 1, kind: 'approval-requested', tool, sideEffect: 'write', prompt: `Approve ${tool}?` }],
      status: 'waiting-approval',
      checkpoint: { prompt: `Approve ${tool}?`, expiresAt: '2026-07-27T00:00:00.000Z', tool, sideEffect: 'write' },
    });
    const done: AgentPreviewRunDto = { runId: 'run-w2', mode: 'preview', response: 'all writes applied', usage: {}, trace: [] };
    const resumeRun = vi.fn().mockResolvedValueOnce(waiting('run-w2', 'delete_rows')).mockResolvedValueOnce(done);
    const client = makeClient({ runSavedAgent: vi.fn().mockResolvedValue(waiting('run-w1', 'write_rows')), resumeRun });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('write and delete');

    const banner = await screen.findByRole('group', { name: 'Tool approval' });
    expect(banner.textContent).toContain('Approve write_rows?');

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(resumeRun).toHaveBeenNthCalledWith(1, 'run-w1', { tenantId: 'local', workspaceId: 'default' }, 'approve', undefined, expect.any(AbortSignal)));
    // 再びwaiting-approvalなら次のツールの承認バナーを出し直す（前のバナーは残さない）。
    const next = await screen.findByRole('group', { name: 'Tool approval' });
    expect(next.textContent).toContain('Approve delete_rows?');

    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(resumeRun).toHaveBeenNthCalledWith(2, 'run-w2', { tenantId: 'local', workspaceId: 'default' }, 'approve', undefined, expect.any(AbortSignal)));
    expect(await screen.findByText('all writes applied')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Tool approval' })).toBeNull();
  });

  it('Rejectはdecision=rejectでresumeRunを呼ぶ', async () => {
    const waiting: AgentPreviewRunDto = {
      runId: 'run-r1', mode: 'preview', response: 'Approve write_rows?', usage: {}, trace: [],
      status: 'waiting-approval',
      checkpoint: { prompt: 'Approve write_rows?', expiresAt: '2026-07-27T00:00:00.000Z', tool: 'write_rows', sideEffect: 'write' },
    };
    const resumeRun = vi.fn().mockResolvedValue({ runId: 'run-r1', mode: 'preview', response: 'skipped the write', usage: {}, trace: [] });
    const client = makeClient({ runSavedAgent: vi.fn().mockResolvedValue(waiting), resumeRun });
    render(<AgentInspectorPage client={client} />);
    await screen.findByRole('option', { name: /Agent/ });
    await sendMessage('write it');
    await screen.findByRole('group', { name: 'Tool approval' });

    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(resumeRun).toHaveBeenCalledWith('run-r1', { tenantId: 'local', workspaceId: 'default' }, 'reject', undefined, expect.any(AbortSignal)));
    expect(await screen.findByText('skipped the write')).toBeTruthy();
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
  describe('実行の中断', () => {
    function pendingClient(): { readonly client: ToolApiClient; readonly signals: (AbortSignal | undefined)[] } {
      const signals: (AbortSignal | undefined)[] = [];
      const runSavedAgent = vi.fn((_input: unknown, signal?: AbortSignal) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      });
      return { client: makeClient({ runSavedAgent }), signals };
    }

    it('中断ボタンは実行中だけ出る', async () => {
      const { client } = pendingClient();
      render(<AgentInspectorPage client={client} />);
      await screen.findByRole('option', { name: /Agent/ });
      expect(screen.queryByRole('button', { name: 'Stop run' })).toBeNull();

      await sendMessage('slow question');
      expect(await screen.findByRole('button', { name: 'Stop run' })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('クリックでabortし、中断として扱って入力を戻す', async () => {
      const { client, signals } = pendingClient();
      render(<AgentInspectorPage client={client} />);
      await screen.findByRole('option', { name: /Agent/ });
      await sendMessage('slow question');

      await userEvent.click(await screen.findByRole('button', { name: 'Stop run' }));

      expect(signals[0]?.aborted).toBe(true);
      expect(await screen.findByText('Run cancelled. Your message is back in the composer.')).toBeTruthy();
      expect(screen.queryByText('Error')).toBeNull();
      expect((screen.getByLabelText('Inspect message') as HTMLTextAreaElement).value).toBe('slow question');
    });

    it('実行が長引くと段階的な案内を出す', async () => {
      vi.useFakeTimers();
      try {
        const { client } = pendingClient();
        render(<AgentInspectorPage client={client} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        fireEvent.change(screen.getByLabelText('Inspect message'), { target: { value: 'slow question' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByText('Sending the request to the model…')).toBeTruthy();
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(screen.getByText('Tools or the model are taking a while. You can stop the run at any time.')).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
