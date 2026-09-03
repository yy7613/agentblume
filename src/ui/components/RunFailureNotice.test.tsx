// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunTraceEventDto } from '../api/types';
import { I18nProvider } from '../i18n';
import { NavigationProvider, consumePendingOpen } from '../navigation';
import { RunFailureNotice } from './RunFailureNotice';

afterEach(() => { cleanup(); consumePendingOpen('Tool'); consumePendingOpen('Agent'); });

const trace: readonly RunTraceEventDto[] = [
  { sequence: 1, kind: 'model-request', step: 1, toolNames: ['sales_lookup'] },
  { sequence: 2, kind: 'tool-call', name: 'sales_lookup', arguments: { month: '2026-06', region: 'west' } },
  { sequence: 3, kind: 'error', code: 'TOOL_ARGUMENTS', message: 'required argument missing: year (retrying 1/1)' },
  { sequence: 4, kind: 'tool-call', name: 'sales_lookup', arguments: { month: '2026-06', year: 2026 } },
  { sequence: 5, kind: 'error', code: 'ETL_SCHEMA', message: 'sort: column(s) not found: total', tool: { internalId: 'sales-lookup', version: '1.2.0', publishName: 'sales_lookup' }, nodeId: 'sort-1' },
];

describe('RunFailureNotice', () => {
  it('次の一手を先頭に太字で、原因をその次に、失敗箇所（ツール / ノード）を続けて出す', () => {
    render(<RunFailureNotice
      code="AGENT_RUN"
      message="The agent run failed (the model called a tool named 'lookup' that is not connected. Check the tools attached to this agent)"
      serverMessage="model requested unknown tool: lookup"
      tool={{ internalId: 'sales-lookup', version: '1.2.0', publishName: 'sales_lookup' }}
      nodeId="sort-1"
      runId="run-9"
    />);
    const alert = screen.getByRole('alert');
    const paragraphs = alert.querySelectorAll(':scope > p');
    expect(paragraphs[0]?.querySelector('strong')?.textContent).toBe('Check the tools attached to this agent');
    expect(paragraphs[1]?.textContent).toBe("The agent run failed (the model called a tool named 'lookup' that is not connected)");
    expect(paragraphs[2]?.textContent).toBe('Failed in tool sales_lookup v1.2.0 · node sort-1');
  });

  it('分割できない文言は全文を次の一手として太字で出し、原因行は出さない', () => {
    render(<RunFailureNotice code="RUN_CANCELLED" message="The run was cancelled" />);
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe('The run was cancelled');
    expect(alert.querySelectorAll(':scope > p')).toHaveLength(1);
  });

  it('失敗したツールとノードが分かれば、ボタンがそれを名指しし、ノードと区画つきで Tool 画面へ遷移する', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice code="TOOL_ARGUMENTS" message="bad arguments" serverMessage="required argument missing: year" tool={{ internalId: 'sales-lookup', version: '1.2.0', publishName: 'sales_lookup' }} nodeId="in-1" />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open node "in-1" in tool "sales_lookup"' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'sales-lookup', version: '1.2.0', nodeId: 'in-1', section: 'agent-context' });
  });

  it('開く対象の無い遷移先（モデル設定）は画面遷移だけを要求する', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice code="MODEL_PROVIDER" message="Could not reach the model server" serverMessage="fetch failed" />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open model settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('エージェント側の遷移はエージェント設定を名指しし、区画（harness）つきで開く', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice code="AGENT_RUN" message="limit" serverMessage="tool call limit exceeded: maximum 4" agent={{ internalId: 'sales-agent' }} />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open agent settings' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
    expect(consumePendingOpen('Agent')).toEqual({ internalId: 'sales-agent', section: 'harness' });
  });

  it('遷移先が無い失敗はボタンを出さない', () => {
    render(<RunFailureNotice code="INTERNAL" message="The server hit an internal error" serverMessage="internal error" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('生の code: message・run ID・失敗直前の tool-call は「技術的な詳細」の折りたたみに入れる', () => {
    render(<RunFailureNotice code="ETL_SCHEMA" message="mismatch" serverMessage="sort: column(s) not found: total" runId="run-9" trace={trace} />);
    const details = screen.getByText('Technical details').closest('details');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('ETL_SCHEMA: sort: column(s) not found: total');
    expect(details?.textContent).toContain('run run-9');
    // 最後の error（sequence 5）の直前の tool-call（sequence 4）。sequence 2 の古い呼び出しではない。
    expect(details?.textContent).toContain('{"month":"2026-06","year":2026}');
    expect(details?.textContent).not.toContain('"region"');
    // 折りたたみの外（alert 直下の段落）には生メッセージを出さない。
    const outside = Array.from(screen.getByRole('alert').querySelectorAll(':scope > p')).map((node) => node.textContent).join('\n');
    expect(outside).not.toContain('ETL_SCHEMA');
  });

  it('props に失敗箇所が無ければ trace の error イベントが持つ tool / nodeId を使う', () => {
    render(<RunFailureNotice code="ETL_SCHEMA" message="mismatch" serverMessage="sort: column(s) not found: total" trace={trace} />);
    expect(screen.getByRole('alert').textContent).toContain('Failed in tool sales_lookup v1.2.0 · node sort-1');
    expect(screen.getByRole('button', { name: 'Open node "sort-1" in tool "sales_lookup"' })).toBeTruthy();
  });

  it('日本語UIでは次の一手・失敗箇所・ボタン・折りたたみ見出しが日本語になる', () => {
    render(
      <I18nProvider initialLanguage="ja">
        <RunFailureNotice
          code="TOOL_ARGUMENTS"
          message="エージェントがツールを不正な引数で呼び出しました（モデルがツールの必須引数「year」を渡しませんでした。ツールの引数の説明を具体的にするか、指示の中でその値を明示してください）"
          serverMessage="required argument missing: year"
          tool={{ internalId: 'sales-lookup', publishName: 'sales_lookup' }}
          nodeId="in-1"
          trace={trace.slice(0, 3)}
        />
      </I18nProvider>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('strong')?.textContent).toBe('ツールの引数の説明を具体的にするか、指示の中でその値を明示してください');
    expect(alert.textContent).toContain('エージェントがツールを不正な引数で呼び出しました（モデルがツールの必須引数「year」を渡しませんでした）');
    expect(alert.textContent).toContain('失敗箇所: ツール sales_lookup · ノード in-1');
    expect(screen.getByRole('button', { name: 'ツール「sales_lookup」のノード「in-1」を開いて直す' })).toBeTruthy();
    expect(screen.getByText('技術的な詳細')).toBeTruthy();
    expect(screen.getByText(/必須引数「year」を渡しませんでした.*（再試行 1\/1）/)).toBeTruthy();
  });

  it('error イベントが無いトレースでは末尾の tool-call を「最後に呼んだもの」として出す', () => {
    render(<RunFailureNotice code="AGENT_RUN" message="failed" trace={trace.slice(0, 2)} />);
    expect(screen.getByText('Technical details').closest('details')?.textContent).toContain('sales_lookup');
  });
});

describe('RunFailureNotice の境界', () => {
  it('trace が無ければ「失敗直前のツール呼び出し」は出さず、生の code: message だけを詳細に入れる', () => {
    render(<RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: x" />);
    const details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).not.toContain('Last tool call');
    expect(details?.textContent).toContain('AGENT_RUN: model requested unknown tool: x');
    expect(screen.getByRole('alert').textContent).not.toContain('Failed in');
  });

  it('技術的な詳細は既定で折りたたまれ、通知は role=alert の run-failure 要素', () => {
    render(<RunFailureNotice code="AGENT_RUN" message="failed" trace={trace} />);
    const details = screen.getByText('Technical details').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByRole('alert').className).toContain('run-failure');
  });

  it('mcp-server-skipped だけのトレースは、失敗箇所やツール呼び出しを出さずにスキップ行だけを詳細に出す', () => {
    const skippedOnly: readonly RunTraceEventDto[] = [
      { sequence: 1, kind: 'mcp-server-skipped', server: 'files', reason: 'disabled' },
      { sequence: 2, kind: 'mcp-server-skipped', server: 'crm', reason: 'unreachable', detail: 'ECONNREFUSED' },
    ];
    render(<RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: mcp__files__read" trace={skippedOnly} />);
    const details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).toContain("MCP server 'files' were not loaded (server disabled)");
    expect(details?.textContent).toContain("MCP server 'crm' were not loaded (unreachable)");
    expect(details?.textContent).toContain('Detail: ECONNREFUSED');
    expect(details?.textContent).not.toContain('Last tool call');
    expect(screen.getByRole('alert').textContent).not.toContain('Failed in');
  });

  it('serverMessage が無くても、ローカライズ済み文言に「MCP」があれば MCP 設定への遷移（open 無し）を出す', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice code="AGENT_RUN" message="MCPサーバー「files」のツールを読み込めませんでした" />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open MCP settings' }));
    expect(navigate).toHaveBeenCalledWith('MCP');
    expect(consumePendingOpen('MCP')).toBeUndefined();
  });

  it('props の失敗箇所は trace の error イベントより優先する', () => {
    render(<RunFailureNotice code="ETL_SCHEMA" message="mismatch" tool={{ internalId: 'other-tool', publishName: 'other_tool' }} nodeId="filter-9" trace={trace} />);
    expect(screen.getByRole('alert').textContent).toContain('Failed in tool other_tool · node filter-9');
    expect(screen.getByRole('button', { name: 'Open node "filter-9" in tool "other_tool"' })).toBeTruthy();
    expect(screen.queryByText(/sort-1/)).toBeNull();
  });

  it('trace の error が serverMessage と同文なら詳細に言語化した行を重ねない。違えば言語化して添える', () => {
    const same: readonly RunTraceEventDto[] = [{ sequence: 1, kind: 'error', code: 'AGENT_RUN', message: 'model requested unknown tool: lookup' }];
    const { unmount } = render(<RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: lookup" trace={same} />);
    let details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).not.toContain("a tool named 'lookup'");
    expect(details?.textContent?.split('model requested unknown tool: lookup')).toHaveLength(2);
    unmount();

    const different: readonly RunTraceEventDto[] = [{ sequence: 1, kind: 'error', code: 'AGENT_RUN', message: 'model requested unknown tool: lookup (retrying 1/1)' }];
    render(<RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: lookup" trace={different} />);
    details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).toContain("a tool named 'lookup' that is not connected. Check the tools attached to this agent (retrying 1/1)");
  });

  it('ノードだけ分かる失敗は「失敗箇所: ノード」として出し、ツールが不明なのでノードを開くボタンは出さない（エージェントから辿る）', () => {
    render(<RunFailureNotice code="ETL_SCHEMA" message="mismatch" serverMessage="sort: column(s) not found: total" nodeId="sort-1" />);
    expect(screen.getByRole('alert').textContent).toContain('Failed in node sort-1');
    expect(screen.queryByRole('button', { name: /Open node/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open agent settings' })).toBeTruthy();
  });

  it('出力上限の失敗は Tool 画面の「出力」区画へ、失敗ノードつきで遷移する（OpenTarget の完全一致）', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice
          code="SESSION_QUOTA_EXCEEDED"
          message="the tool output (9 bytes) exceeds the agent-output limit (8 bytes). In the Tool Builder, reduce the rows"
          serverMessage="agent-output exceeds maxBytes (9 > 8); reduce rows or use workspace-output"
          tool={{ internalId: 'sales-lookup', version: '1.2.0' }}
          nodeId="out-1"
        />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open node "out-1" in tool "sales-lookup"' }));
    expect(navigate).toHaveBeenCalledWith('Tool');
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'sales-lookup', version: '1.2.0', nodeId: 'out-1', section: 'output' });
  });

  it('エージェントが不明なエージェント側の遷移は画面遷移だけで、開く対象を預けない', async () => {
    const navigate = vi.fn();
    render(
      <NavigationProvider navigate={navigate}>
        <RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: lookup" />
      </NavigationProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open agent settings' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
    expect(consumePendingOpen('Agent')).toBeUndefined();
  });

  it('巨大な引数 JSON もそのまま描画できる（切り詰めない・落ちない）', () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({ id: index, name: `item-${index}`, nested: { deep: [index, index + 1] } }));
    const big: readonly RunTraceEventDto[] = [{ sequence: 1, kind: 'tool-call', name: 'bulk', arguments: { rows, note: 'a'.repeat(10_000) } }];
    render(<RunFailureNotice code="AGENT_RUN" message="failed" trace={big} />);
    const details = screen.getByText('Technical details').closest('details');
    expect(details?.textContent).toContain('"name":"item-499"');
    expect(details?.textContent).toContain('a'.repeat(10_000));
  });

  it('日本語UIでは MCP・モデル設定・エージェント設定のボタンも日本語になる', () => {
    render(
      <I18nProvider initialLanguage="ja">
        <RunFailureNotice code="AGENT_RUN" message="failed" serverMessage="model requested unknown tool: mcp__files__read (MCP server unreachable)" agent={{ internalId: 'a' }} />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'MCP設定を開く' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'エージェント設定を開く' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'モデル設定を開く' })).toBeNull();
  });
});
