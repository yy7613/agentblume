// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDiagnosticsDto, ToolDiagnosticsDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { diagnosticCheckLabel, DiagnosticsPanel, toolCheckTarget, topIssue } from './DiagnosticsPanel';

afterEach(() => { cleanup(); consumePendingOpen('Tool'); consumePendingOpen('Agent'); });

const toolX: ToolDiagnosticsDto = {
  internalId: 'tool-x', version: '2.0.0', source: 'direct', functionName: 'tool_x', status: 'error',
  checks: [
    { id: 'resolved', status: 'ok' },
    { id: 'graph', status: 'error', nodeId: 'filter-1', detail: "node 'filter-1' (type 'filter') expects 1 input(s) but has in-degree 0" },
    { id: 'function-definition', status: 'error', detail: "function name 'tool x' is invalid" },
    { id: 'output-schema', status: 'warning', detail: 'declared output schema does not match' },
    { id: 'state', status: 'warning', detail: 'tool is deprecated' },
  ],
};

const agentDiagnostics: AgentDiagnosticsDto = {
  agent: { internalId: 'agent-a', version: '1.2.0' },
  status: 'error',
  checks: [
    { id: 'skills', status: 'ok' },
    { id: 'mcp-servers', status: 'warning', detail: "MCP server 'ghost' is not registered" },
    { id: 'model', status: 'error', detail: 'configured model provider does not support tool-calling' },
    { id: 'harness', status: 'warning', detail: 'web search enabled without a provider' },
    { id: 'function-names', status: 'error', detail: "duplicate function name 'tool_x'" },
    { id: 'sub-agents', status: 'error', detail: 'sub-agent not found: helper' },
  ],
  tools: [toolX],
};

function renderPanel(ui: React.ReactElement, navigate = vi.fn(), language: 'en' | 'ja' = 'en') {
  return { navigate, ...render(<I18nProvider initialLanguage={language}><NavigationProvider navigate={navigate}>{ui}</NavigationProvider></I18nProvider>) };
}

describe('DiagnosticsPanel', () => {
  it('全体バッジと件数、検査ラベル、ノードチップを描き、ok 行は1行に畳む', () => {
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" />);
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.getByText('5 error(s) · 4 warning(s)')).toBeTruthy();
    expect(screen.getByText('MCP servers')).toBeTruthy();
    expect(screen.getByText('Model capabilities')).toBeTruthy();
    expect(screen.getByText('Harness features')).toBeTruthy();
    expect(screen.getByText('Tool lifecycle state')).toBeTruthy();
    // nodeId 付きの検査は、どのノードで落ちたかをチップで示す。
    expect(screen.getByText('filter-1')).toBeTruthy();
    expect(screen.getByText('tool_x')).toBeTruthy();
    // ok 行はラベルだけ（生idや本文を持たない）。問題行は原因を主文にして生idを小さく添える。
    const okRow = screen.getByText('Skill references').closest('li');
    expect(okRow?.className).toContain('ok');
    expect(okRow?.querySelector('.ins-diag-detail')).toBeNull();
    const errorRow = screen.getByText('Model capabilities').closest('li');
    expect(errorRow?.querySelector('.ins-diag-detail')?.textContent).toContain('does not support tool calling');
    expect(errorRow?.querySelector('.ins-diag-id')?.textContent).toBe('model');
  });

  it('detail を「原因 + 次の一手」の文言へ直す（日本語UI）', () => {
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" />, vi.fn(), 'ja');
    expect(screen.getByText('呼び出し不可あり')).toBeTruthy();
    // ETL の GraphError 定型文と、モデル能力不足の定型文が日本語になる。
    expect(screen.getByText(/ノード「filter-1」\(filter\)には1本の入力が必要ですが、0本接続されています/)).toBeTruthy();
    expect(screen.getByText(/選択中のモデルはツール呼び出しに対応していません/)).toBeTruthy();
    expect(screen.queryByText(/in-degree 0/)).toBeNull();
  });

  it('ツール検査は直す場所まで指す: ノード行はそのノード、function 定義はエージェント向け設定、出力スキーマは出力', async () => {
    const { navigate } = renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" />);
    const toolBlock = screen.getByRole('list', { name: 'Checks for tool-x' });
    // ok の行にはボタンを出さない（error / warning の行だけ）。
    expect(within(toolBlock).getAllByRole('button')).toHaveLength(4);

    await userEvent.click(within(toolBlock).getByRole('button', { name: 'Open node "filter-1"' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'tool-x', version: '2.0.0', nodeId: 'filter-1' });

    await userEvent.click(within(toolBlock).getByRole('button', { name: 'Open tool "tool_x" (agent context)' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'tool-x', version: '2.0.0', section: 'agent-context' });

    await userEvent.click(within(toolBlock).getByRole('button', { name: 'Open tool "tool_x" (output)' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'tool-x', version: '2.0.0', section: 'output' });

    await userEvent.click(within(toolBlock).getByRole('button', { name: 'Open tool "tool_x"' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'tool-x', version: '2.0.0' });
  });

  it('エージェント検査は原因の画面・区画へ飛ぶボタンを出す（inspector）', async () => {
    const { navigate } = renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" />);
    await userEvent.click(screen.getByRole('button', { name: 'Open MCP settings' }));
    expect(navigate).toHaveBeenCalledWith('MCP');
    await userEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');

    await userEvent.click(screen.getByRole('button', { name: 'Open agent "agent-a" (tools)' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'agent-a', version: '1.2.0', section: 'tools' });
    await userEvent.click(screen.getByRole('button', { name: 'Open agent "agent-a" (sub-agents)' }));
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'agent-a', version: '1.2.0', section: 'sub-agents' });
    await userEvent.click(screen.getByRole('button', { name: 'Open agent "agent-a" (runtime options)' }));
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'agent-a', version: '1.2.0', section: 'harness' });
  });

  it('agent-editor では別画面で自分を開かず、画面内の区画へ移る（ハーネスは実行オプション）', async () => {
    const onOpenHarness = vi.fn();
    const onOpenLocal = vi.fn();
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="agent-editor" onOpenHarness={onOpenHarness} onOpenLocal={onOpenLocal} agentId="agent-a" />);
    expect(screen.queryByRole('button', { name: /^Open agent/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open runtime options (harness)' }));
    expect(onOpenHarness).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Go to tool selection' }));
    expect(onOpenLocal).toHaveBeenCalledWith({ section: 'tools' });
    await userEvent.click(screen.getByRole('button', { name: 'Go to sub-agent selection' }));
    expect(onOpenLocal).toHaveBeenCalledWith({ section: 'sub-agents' });
    // ツールへは編集中でも飛べる。
    expect(screen.getByRole('button', { name: 'Open node "filter-1"' })).toBeTruthy();
    expect(consumePendingOpen('Agent')).toBeUndefined();
  });

  it('tool-editor では Tool 単体の診断を描き、ノード行は行クリックでもボタンでもそのノードを選ぶ', async () => {
    const onOpenLocal = vi.fn();
    renderPanel(<DiagnosticsPanel diagnostics={{ kind: 'tool', tool: toolX }} context="tool-editor" onOpenLocal={onOpenLocal} />);
    expect(screen.getByText('tool_x')).toBeTruthy();
    expect(screen.getByText('2 error(s) · 2 warning(s)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open tool/ })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Agent checks' })).toBeNull();
    expect(screen.queryByText('This agent references no tools.')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Open node "filter-1"' }));
    expect(onOpenLocal).toHaveBeenLastCalledWith({ nodeId: 'filter-1' });
    await userEvent.click(screen.getByText('Graph validation'));
    expect(onOpenLocal).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Go to Agent context' }));
    expect(onOpenLocal).toHaveBeenLastCalledWith({ section: 'agent-context' });
    await userEvent.click(screen.getByRole('button', { name: 'Select the output node' }));
    expect(onOpenLocal).toHaveBeenLastCalledWith({ section: 'output' });
    // 何も指せない検査（公開状態）にはボタンを出さない。
    expect(screen.getByText('Tool lifecycle state').closest('li')?.querySelector('button')).toBeNull();
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('onClose があるときだけ閉じるボタンを出す', async () => {
    const onClose = vi.fn();
    const { unmount } = renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" />);
    expect(screen.queryByRole('button', { name: 'Close diagnostics' })).toBeNull();
  });

  it('ツール参照が無いエージェントはその旨を出す', () => {
    renderPanel(<DiagnosticsPanel diagnostics={{ ...agentDiagnostics, status: 'ok', checks: [{ id: 'skills', status: 'ok' }], tools: [] }} context="inspector" />);
    expect(screen.getByText('No blockers')).toBeTruthy();
    expect(screen.getByText('This agent references no tools.')).toBeTruthy();
  });
});

describe('DiagnosticsPanel の境界と欠けた入力', () => {
  it('全て ok なら「問題なし」と 0 件を出し、ボタンもノードチップも本文も出さない', () => {
    const allOk: AgentDiagnosticsDto = {
      agent: { internalId: 'agent-a', version: '1.0.0' }, status: 'ok',
      checks: [{ id: 'skills', status: 'ok' }, { id: 'model', status: 'ok' }],
      tools: [{ internalId: 'tool-x', version: '1.0.0', source: 'direct', functionName: 'tool_x', status: 'ok', checks: [{ id: 'resolved', status: 'ok' }, { id: 'graph', status: 'ok', nodeId: 'filter-1' }] }],
    };
    renderPanel(<DiagnosticsPanel diagnostics={allOk} context="inspector" onOpenLocal={vi.fn()} />);
    expect(screen.getByText('No blockers')).toBeTruthy();
    expect(screen.getByText('0 error(s) · 0 warning(s)')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    // ok 行は nodeId を持っていてもチップ・本文・生idを出さず、クリック対象にもならない。
    expect(screen.queryByText('filter-1')).toBeNull();
    expect(document.querySelector('.ins-diag-detail')).toBeNull();
    expect(document.querySelector('.ins-diag-check.clickable')).toBeNull();
  });

  it('未知の検査idはそのままラベルにし、detail の無い問題行はラベルを主文にしてボタンを出さない', () => {
    const unknown: AgentDiagnosticsDto = {
      agent: { internalId: 'agent-a', version: '1.0.0' }, status: 'warning',
      checks: [{ id: 'brand-new-check', status: 'warning' }],
      tools: [{ internalId: 'tool-x', version: '1.0.0', source: 'direct', functionName: 'tool_x', status: 'warning', checks: [{ id: 'state', status: 'warning' }] }],
    };
    renderPanel(<DiagnosticsPanel diagnostics={unknown} context="inspector" />);
    expect(screen.getByText('Needs attention')).toBeTruthy();
    expect(screen.getByText('0 error(s) · 2 warning(s)')).toBeTruthy();
    const agentRow = screen.getByRole('list', { name: 'Agent checks' }).querySelector('li');
    expect(agentRow?.querySelector('.ins-diag-label span')?.textContent).toBe('brand-new-check');
    expect(agentRow?.querySelector('.ins-diag-id')?.textContent).toBe('brand-new-check');
    expect(agentRow?.querySelector('.ins-diag-detail')?.textContent).toBe('brand-new-check');
    expect(agentRow?.querySelector('button')).toBeNull();
    // 既知の検査でも detail が無ければラベルが主文になる。
    const toolRow = screen.getByRole('list', { name: 'Checks for tool-x' }).querySelector('li');
    expect(toolRow?.querySelector('.ins-diag-detail')?.textContent).toBe('Tool lifecycle state');
  });

  it('tool-editor で onOpenLocal が無ければボタンも行クリックも出さず、落ちない', () => {
    renderPanel(<DiagnosticsPanel diagnostics={{ kind: 'tool', tool: toolX }} context="tool-editor" />);
    expect(screen.getByText('Blocked')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(document.querySelector('.ins-diag-check.clickable')).toBeNull();
    // ノードチップ（直す場所の情報）は残す。
    expect(screen.getByText('filter-1')).toBeTruthy();
  });

  it('agent-editor で onOpenHarness が無ければハーネス検査は区画（harness）へ移る', async () => {
    const onOpenLocal = vi.fn();
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="agent-editor" onOpenLocal={onOpenLocal} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open runtime options (harness)' }));
    expect(onOpenLocal).toHaveBeenCalledWith({ section: 'harness' });
  });

  it('agent-editor で onOpenLocal も onOpenHarness も無ければ区画ボタンは出さず、別画面への導線だけ残す', () => {
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="agent-editor" />);
    expect(screen.queryByRole('button', { name: 'Go to tool selection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to sub-agent selection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open runtime options (harness)' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Open agent/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open MCP settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open model settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open node "filter-1"' })).toBeTruthy();
  });

  it('inspector で agentId を渡すと診断結果のエージェントIDより優先し、バージョンは診断結果のものを添える', async () => {
    renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" agentId="other-agent" />);
    await userEvent.click(screen.getByRole('button', { name: 'Open agent "other-agent" (tools)' }));
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'other-agent', version: '1.2.0', section: 'tools' });
  });

  it('functionName の無いツールは internalId を名前にし、スキル経由はチップで示す', () => {
    const viaSkill: ToolDiagnosticsDto = {
      internalId: 'tool-s', version: '1.0.0', source: 'skill', skillId: 'analysis', status: 'error',
      checks: [{ id: 'function-definition', status: 'error', detail: "function name 'tool s' is invalid" }, { id: 'state', status: 'warning', detail: 'tool is deprecated' }],
    };
    const { unmount } = renderPanel(<DiagnosticsPanel diagnostics={{ ...agentDiagnostics, checks: [], tools: [viaSkill] }} context="inspector" />);
    expect(screen.getByText('tool-s', { selector: 'b' })).toBeTruthy();
    expect(screen.getByText('via skill: analysis')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open tool "tool-s" (agent context)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open tool "tool-s"' })).toBeTruthy();
    unmount();

    // skillId が無いスキル経由は「スキル経由」だけ。直付けはチップ無し。
    const { skillId: _omitted, ...withoutSkillId } = viaSkill;
    renderPanel(<DiagnosticsPanel diagnostics={{ ...agentDiagnostics, checks: [], tools: [withoutSkillId, { ...toolX, checks: [] }] }} context="inspector" />);
    expect(screen.getByText('via skill')).toBeTruthy();
    expect(document.querySelectorAll('.ins-chip.skill')).toHaveLength(1);
  });

  it('inspector ではノード行をクリックしても何も起きない（行クリックは tool-editor だけ）', async () => {
    const onOpenLocal = vi.fn();
    const { navigate } = renderPanel(<DiagnosticsPanel diagnostics={agentDiagnostics} context="inspector" onOpenLocal={onOpenLocal} />);
    expect(document.querySelector('.ins-diag-check.clickable')).toBeNull();
    await userEvent.click(screen.getByText('Graph validation'));
    expect(onOpenLocal).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('tool-editor でも ok 行と nodeId の無い行はクリック対象にせず、ボタンのクリックは行クリックを重ねて発火しない', async () => {
    const onOpenLocal = vi.fn();
    const tool: ToolDiagnosticsDto = {
      ...toolX,
      checks: [
        { id: 'resolved', status: 'ok', nodeId: 'source-1' },
        { id: 'graph', status: 'error', nodeId: 'filter-1', detail: 'graph has a cycle' },
        { id: 'state', status: 'warning', detail: 'tool is deprecated' },
      ],
    };
    renderPanel(<DiagnosticsPanel diagnostics={{ kind: 'tool', tool }} context="tool-editor" onOpenLocal={onOpenLocal} />);
    expect(document.querySelectorAll('.ins-diag-check.clickable')).toHaveLength(1);
    await userEvent.click(screen.getByText('Tool version exists'));
    await userEvent.click(screen.getByText('Tool lifecycle state'));
    expect(onOpenLocal).not.toHaveBeenCalled();
    // stopPropagation: ボタン1回のクリックで onOpenLocal は1回だけ。
    await userEvent.click(screen.getByRole('button', { name: 'Open node "filter-1"' }));
    expect(onOpenLocal).toHaveBeenCalledTimes(1);
    expect(onOpenLocal).toHaveBeenCalledWith({ nodeId: 'filter-1' });
  });

  it('「; 」で連結された複数の detail は1件ずつ言語化して「、」で繋ぐ（日本語UI）', () => {
    const multi: AgentDiagnosticsDto = {
      ...agentDiagnostics,
      checks: [{ id: 'mcp-servers', status: 'error', detail: 'referenced MCP server not found: files; additional sub-agent not found: helper' }],
      tools: [],
    };
    renderPanel(<DiagnosticsPanel diagnostics={multi} context="inspector" />, vi.fn(), 'ja');
    expect(document.querySelector('.ins-diag-detail')?.textContent).toBe(
      '参照しているMCPサーバー「files」が登録されていません。MCP設定画面でサーバーを登録するか、エージェント画面のMCPサーバー一覧から外してください、'
      + '委譲先のサブエージェント「helper」が見つかりませんでした。該当バージョンが削除されていないか確認してください',
    );
    expect(screen.queryByText(/not found/)).toBeNull();
  });
});

describe('toolCheckTarget / topIssue', () => {
  it('nodeId を最優先し、無ければ検査idごとの区画へ写す', () => {
    expect(toolCheckTarget({ id: 'execution', status: 'error', nodeId: 'n1' })).toEqual({ nodeId: 'n1' });
    expect(toolCheckTarget({ id: 'function-definition', status: 'error' })).toEqual({ section: 'agent-context' });
    expect(toolCheckTarget({ id: 'agent-input', status: 'error' })).toEqual({ section: 'agent-context' });
    expect(toolCheckTarget({ id: 'operator-arguments', status: 'warning' })).toEqual({ section: 'agent-context' });
    expect(toolCheckTarget({ id: 'output-schema', status: 'error' })).toEqual({ section: 'output' });
    expect(toolCheckTarget({ id: 'state', status: 'warning' })).toEqual({});
  });

  it('正常: 複数値の引数の検査（list-arguments）は、直す場所としてエージェント向け設定を指し、ラベルを日本語にする', () => {
    expect(toolCheckTarget({ id: 'list-arguments', status: 'warning' })).toEqual({ section: 'agent-context' });
    expect(toolCheckTarget({ id: 'list-arguments', status: 'warning', nodeId: 'f1' })).toEqual({ nodeId: 'f1' });
    expect(diagnosticCheckLabel('list-arguments', (_en, ja) => ja)).toBe('複数値の引数');
    expect(diagnosticCheckLabel('list-arguments', (en) => en)).toBe('Multi-value arguments');
  });

  it('最初の error、無ければ最初の warning を一番目の問題とする', () => {
    expect(topIssue(toolX.checks)?.id).toBe('graph');
    expect(topIssue([{ id: 'a', status: 'ok' }, { id: 'b', status: 'warning' }, { id: 'c', status: 'warning' }])?.id).toBe('b');
    expect(topIssue([{ id: 'a', status: 'ok' }])).toBeUndefined();
  });

  it('graph / execution / resolved は nodeId が無ければ指す場所が無く、nodeId は区画のある検査でも優先する', () => {
    expect(toolCheckTarget({ id: 'graph', status: 'error' })).toEqual({});
    expect(toolCheckTarget({ id: 'execution', status: 'error' })).toEqual({});
    expect(toolCheckTarget({ id: 'resolved', status: 'error' })).toEqual({});
    expect(toolCheckTarget({ id: 'brand-new-check', status: 'error' })).toEqual({});
    expect(toolCheckTarget({ id: 'function-definition', status: 'error', nodeId: 'n1' })).toEqual({ nodeId: 'n1' });
    expect(toolCheckTarget({ id: 'output-schema', status: 'warning', nodeId: 'n2' })).toEqual({ nodeId: 'n2' });
  });

  it('warning が先に並んでいても error を一番目の問題とし、空配列は undefined', () => {
    expect(topIssue([{ id: 'a', status: 'warning' }, { id: 'b', status: 'ok' }, { id: 'c', status: 'error' }])?.id).toBe('c');
    expect(topIssue([{ id: 'x', status: 'error' }, { id: 'y', status: 'error' }])?.id).toBe('x');
    expect(topIssue([])).toBeUndefined();
  });
});
