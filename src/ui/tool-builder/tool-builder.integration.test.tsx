// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto, SerializedToolDto } from '../api/types';
import { draftKey, readDraft } from '../hooks/useDraftPersistence';
import { NavigationProvider, consumePendingOpen, useOpenInScreen } from '../navigation';
import { ToolBuilder, focusToolTarget, terminalNodeId } from './ToolBuilder';
import { useToolBuilderStore } from './store';
import { scope } from '../scope';

vi.mock('./FlowCanvas', () => ({ FlowCanvas: () => <div aria-label="ETL canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <aside aria-label="Node palette" /> }));

const valid: PropagationResultDto = {
  order: ['source-1', 'filter-1'], terminalId: 'filter-1', hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
  },
};
const sample: PreviewResultDto = {
  terminalId: 'filter-1', output: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] },
  nodes: { 'filter-1': { nodeId: 'filter-1', truncated: false, rowCount: 1, table: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] } } },
};

beforeEach(() => { localStorage.clear(); useToolBuilderStore.getState().reset(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); consumePendingOpen('Tool'); });

const savedSummary = { internalId: 'customer-filter', displayName: 'Customer filter', publishName: 'adult_customers', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' };
const savedTool = {
  metadata: { internalId: 'customer-filter', workingName: 'w', displayName: 'Customer filter', publishName: 'adult_customers', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 'local', workspaceId: 'default' } },
  sideEffect: 'read-only',
  graph: { nodes: [{ id: 'source-1', type: 'json-source', config: { rows: [{ age: 30 }] } }, { id: 'filter-1', type: 'filter', config: { column: 'age', op: 'gte', value: 18 } }], edges: [{ from: 'source-1', to: 'filter-1' }] },
} as SerializedToolDto;

/** 診断結果などから「ツールを開く」を依頼する側（別画面の代役）。 */
function Opener({ internalId, nodeId, section }: { readonly internalId: string; readonly nodeId?: string; readonly section?: string }) {
  const open = useOpenInScreen();
  return <button type="button" onClick={() => open('Tool', { internalId, version: '1.0.0', ...(nodeId === undefined ? {} : { nodeId }), ...(section === undefined ? {} : { section }) })}>open {internalId}</button>;
}

function fillRequiredMetadata(): void {
  const { setMetadata } = useToolBuilderStore.getState();
  setMetadata('internalId', 'customer-filter');
  setMetadata('workingName', 'Customer filter draft');
  setMetadata('displayName', 'Customer filter');
  setMetadata('publishName', 'adult_customers');
  setMetadata('owner', 'owner@example.com');
}

describe('ToolBuilder preview integration', () => {
  it('Agent context領域でAgent Inputの引数スキーマを編集できる', () => {
    const client = { inferDraft: vi.fn(), previewDraft: vi.fn(), listTools: vi.fn().mockResolvedValue([]) } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    act(() => useToolBuilderStore.getState().addNode('agent-input'));
    expect(screen.getByRole('table', { name: 'Agent arguments' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Argument name 1'), { target: { value: 'minimumAge' } });
    fireEvent.change(screen.getByLabelText('Argument type minimumAge'), { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add argument' }));
    const input = useToolBuilderStore.getState().nodes.find((node) => node.data.nodeType === 'agent-input');
    expect((input?.data.config['schema'] as { columns: { name: string; type: string }[] }).columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'minimumAge', type: 'number' }), expect.objectContaining({ name: 'argument2', type: 'string' })]));
  });

  it('パレット追加ノードはstarterのIDと衝突せず、座標付きでdraft APIへ渡る', async () => {
    const inferDraft = vi.fn().mockResolvedValue(valid);
    const client = {
      inferDraft, previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]),
    } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
    // starterは source-1 / filter-1。同じ型を追加してもIDが重複しない（React keyの衝突でノードが消えない）。
    act(() => useToolBuilderStore.getState().addNode('filter'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    const sent = inferDraft.mock.calls.at(-1)?.[0] as { nodes: { id: string; position?: { x: number; y: number } }[] };
    expect(sent.nodes.map((node) => node.id)).toEqual(['source-1', 'filter-1', 'filter-2']);
    expect(sent.nodes.every((node) => node.position !== undefined)).toBe(true);
  });

  it('debounce infer→previewでsampleを描画し、次のissueではpreviewを抑止する', async () => {
    const invalid: PropagationResultDto = {
      ...valid, hasErrors: true,
      nodes: { ...valid.nodes, 'filter-1': { ...valid.nodes['filter-1']!, state: 'mismatch', issues: [{ severity: 'error', message: 'age is missing', column: 'age' }] } },
    };
    const client = {
      inferDraft: vi.fn().mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid),
      previewDraft: vi.fn().mockResolvedValue(sample),
      listTools: vi.fn().mockResolvedValue([]),
    } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'New tool' }));

    expect(screen.queryByLabelText('Agent chat')).toBeNull();
    expect(screen.getByLabelText('Agent-facing name')).toBeTruthy();
    expect(screen.getByLabelText('Agent-facing description')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Agent-facing name'), { target: { value: 'find_adults' } });
    fireEvent.change(screen.getByLabelText('Agent-facing description'), { target: { value: 'Find adult customers by minimum age.' } });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'find_adults', agentDescription: 'Find adult customers by minimum age.' });

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy();
    expect(client.previewDraft).toHaveBeenCalledOnce();

    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'missing', op: 'eq', value: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getAllByText('age is missing').length).toBeGreaterThan(0);
    expect(client.previewDraft).toHaveBeenCalledOnce();
  });

  it('一覧のツール削除は確認ダイアログを経てから実行する', async () => {
    const deleteTool = vi.fn().mockResolvedValue(undefined);
    const client = {
      inferDraft: vi.fn(), previewDraft: vi.fn(), deleteTool,
      listTools: vi.fn().mockResolvedValue([{ internalId: 'customer-filter', displayName: 'Customer filter', publishName: 'adult_customers', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' }]),
    } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // 一覧のlistTools解決を待つ。

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Delete tool' });
    expect(dialog.textContent).toContain('Customer filter');
    expect(dialog.textContent).toContain('adult_customers');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(deleteTool).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(deleteTool).toHaveBeenCalledWith('customer-filter', { tenantId: 'local', workspaceId: 'default' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('2ソース→joinのグラフをtoInput付きでdraft APIへ流し、join結果の行を描画する', async () => {
    const joinColumns = [
      { name: 'id', type: 'number', nullable: false },
      { name: 'name', type: 'string', nullable: false },
      { name: 'score', type: 'number', nullable: false },
    ] as const;
    const joinPropagation: PropagationResultDto = {
      order: ['left-1', 'right-1', 'join-1'], terminalId: 'join-1', hasErrors: false,
      nodes: {
        'left-1': { nodeId: 'left-1', state: 'inferred', issues: [], schema: { columns: [joinColumns[0], joinColumns[1]] } },
        'right-1': { nodeId: 'right-1', state: 'inferred', issues: [], schema: { columns: [joinColumns[0], joinColumns[2]] } },
        'join-1': { nodeId: 'join-1', state: 'confirmed', issues: [], schema: { columns: [...joinColumns] } },
      },
    };
    const joinPreview: PreviewResultDto = {
      terminalId: 'join-1',
      output: { schema: { columns: [...joinColumns] }, rows: [{ id: 1, name: 'Alice', score: 90 }] },
      nodes: { 'join-1': { nodeId: 'join-1', truncated: false, rowCount: 1, table: { schema: { columns: [...joinColumns] }, rows: [{ id: 1, name: 'Alice', score: 90 }] } } },
    };
    const inferDraft = vi.fn().mockResolvedValue(joinPropagation);
    const previewDraft = vi.fn().mockResolvedValue(joinPreview);
    const toolDto = {
      metadata: { internalId: 'joined', workingName: 'w', displayName: 'Joined', publishName: 'joined', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'left-1', type: 'json-source', config: { rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] } },
          { id: 'right-1', type: 'json-source', config: { rows: [{ id: 1, score: 90 }] } },
          { id: 'join-1', type: 'join', config: { mode: 'inner', keys: [{ left: 'id', right: 'id' }], rightSuffix: '_right' } },
        ],
        edges: [{ from: 'left-1', to: 'join-1', toInput: 0 }, { from: 'right-1', to: 'join-1', toInput: 1 }],
      },
    } as SerializedToolDto;
    const client = {
      inferDraft, previewDraft,
      listTools: vi.fn().mockResolvedValue([{ internalId: 'joined', displayName: 'Joined', publishName: 'joined', latestVersion: '1.0.0', state: 'draft', sideEffect: 'read-only' }]),
      getTool: vi.fn().mockResolvedValue(toolDto),
      listVersions: vi.fn().mockResolvedValue(['1.0.0']),
    } as unknown as ToolApiClient;

    render(<ToolBuilder client={client} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // 一覧のlistTools解決を待つ。
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // OpenのgetTool/listVersions解決とeditorへの遷移を待つ。
    act(() => useToolBuilderStore.getState().selectNode('join-1'));

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    // joinノードと2本のtoInput付きedgeがそのままinfer-schema/previewへ渡る。
    const sentGraph = inferDraft.mock.calls[0]?.[0] as { nodes: { type: string }[]; edges: unknown[] };
    expect(sentGraph.nodes.map((node) => node.type)).toEqual(['json-source', 'json-source', 'join']);
    expect(sentGraph.edges).toEqual([
      { from: 'left-1', to: 'join-1', toInput: 0 },
      { from: 'right-1', to: 'join-1', toInput: 1 },
    ]);
    // 送るスコープはToolのメタデータではなく、UI共通の（＝サーバーが返した自分の）スコープ。
    expect(previewDraft).toHaveBeenCalledWith(sentGraph, 100, expect.any(AbortSignal), scope);

    // join結果の期待行が描画される。
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '90' })).toBeTruthy();
  });

  describe('他画面からの「ツールを開く」', () => {
    const openableClient = () => ({
      inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample),
      listTools: vi.fn().mockResolvedValue([savedSummary]), getTool: vi.fn().mockResolvedValue(savedTool), listVersions: vi.fn().mockResolvedValue(['1.0.0']),
    }) as unknown as ToolApiClient;

    it('表示中に依頼が来ると一覧を経ずにそのToolを開く', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" /><ToolBuilder client={client} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('button', { name: 'New tool' })).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(client.getTool).toHaveBeenCalledWith('customer-filter', scope);
      expect(useToolBuilderStore.getState()).toMatchObject({ currentVersion: '1.0.0', versions: ['1.0.0'] });
      expect(useToolBuilderStore.getState().metadata.internalId).toBe('customer-filter');
      // editor へ遷移している。
      expect(screen.getByLabelText('ETL canvas')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'New tool' })).toBeNull();
    });

    it('nodeId 付きの依頼は開いたうえでそのノードを選択する（設定パネルが開く）', async () => {
      const client = openableClient();
      render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" nodeId="source-1" /><ToolBuilder client={client} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('source-1');
      // 選択ノードの設定（JSON rows）が NodeInspector に出る。
      expect(screen.getByLabelText('JSON rows')).toBeTruthy();
    });

    it('section=agent-context ならエージェント向けツール名の入力欄へフォーカスし、output なら終端ノードを選ぶ', async () => {
      const client = openableClient();
      const { unmount } = render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" section="agent-context" /><ToolBuilder client={client} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(document.activeElement).toBe(screen.getByLabelText('Agent-facing name'));
      unmount();

      render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" section="output" /><ToolBuilder client={openableClient()} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // 読み込み直後（検証結果なし）でも out-degree 0 のノードを終端として選ぶ。
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');
    });

    it('読み込みが終わるまでは一覧のままで、終わってから開いて nodeId と section の両方の場所へ移る', async () => {
      let resolveTool: (tool: SerializedToolDto) => void = () => {};
      const client = openableClient();
      (client.getTool as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<SerializedToolDto>((resolve) => { resolveTool = resolve; }));
      render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" nodeId="source-1" section="agent-context" /><ToolBuilder client={client} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      // getTool が解決するまでは一覧のまま（Open は読み込み中で無効）で、選択も触らない。
      expect(screen.getByRole('button', { name: 'New tool' })).toBeTruthy();
      expect((screen.getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');

      await act(async () => { resolveTool(savedTool); await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByLabelText('ETL canvas')).toBeTruthy();
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('source-1');
      expect(document.activeElement).toBe(screen.getByLabelText('Agent-facing name'));
    });

    it('読み込みに失敗したら一覧にエラーを出し、失敗した依頼の場所指定を次に開いた編集画面へ持ち越さない', async () => {
      const client = openableClient();
      (client.getTool as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tool gone'));
      render(<NavigationProvider navigate={vi.fn()}><Opener internalId="customer-filter" nodeId="source-1" section="agent-context" /><ToolBuilder client={client} /></NavigationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('tool gone')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'New tool' })).toBeTruthy();

      // starter グラフにも source-1 はあるが、失敗した依頼で選択やフォーカスを動かさない。
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');
      expect(document.activeElement).not.toBe(screen.getByLabelText('Agent-facing name'));
    });

    it('mount 前に預けられた依頼は mount 時に受け取る（診断結果からの遷移）', async () => {
      const navigate = vi.fn();
      const { unmount } = render(<NavigationProvider navigate={navigate}><Opener internalId="customer-filter" /></NavigationProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'open customer-filter' }));
      expect(navigate).toHaveBeenCalledWith('Tool');
      unmount();

      const client = openableClient();
      render(<ToolBuilder client={client} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(client.getTool).toHaveBeenCalledWith('customer-filter', scope);
      expect(screen.getByLabelText('ETL canvas')).toBeTruthy();
    });
  });

  describe('呼び出し診断（Tool下書きのプリフライト）', () => {
    it('結果をプレビューの上に描き、ノードを名指しし、閉じられる', async () => {
      const diagnoseToolDraft = vi.fn().mockResolvedValue({
        internalId: 'customer-filter', version: 'draft', source: 'direct', functionName: 'adult_customers', status: 'error',
        checks: [
          { id: 'function-definition', status: 'ok' },
          { id: 'graph', status: 'error', nodeId: 'filter-1', detail: 'graph has a cycle' },
        ],
      });
      const client = { inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]), diagnoseToolDraft } as unknown as ToolApiClient;
      render(<ToolBuilder client={client} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      act(() => fillRequiredMetadata());

      fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(diagnoseToolDraft).toHaveBeenCalledOnce();
      expect(screen.getByText('Blocked')).toBeTruthy();
      expect(screen.getByText('Graph validation')).toBeTruthy();
      // 原因は「次の一手」つきの文言が主文（英語UIは原文を保つ）。
      expect(screen.getByText('graph has a cycle')).toBeTruthy();
      // ノードチップと、tool-editor では出さない「ツールを開く」。
      expect(screen.getByText('node:')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /^Open tool/ })).toBeNull();
      // 送った DTO は保存と同じ形（メタデータ + グラフ）。
      expect(diagnoseToolDraft.mock.calls[0]?.[0]).toMatchObject({ internalId: 'customer-filter', publishName: 'adult_customers', graph: { nodes: expect.any(Array), edges: expect.any(Array) } });

      // ノード行の「開いて直す」で、そのノードをキャンバス上で選択する（設定パネルが開く）。
      act(() => useToolBuilderStore.getState().selectNode('source-1'));
      fireEvent.click(screen.getByRole('button', { name: 'Open node "filter-1"' }));
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');
      expect(screen.getByLabelText('Column')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
      expect(screen.queryByText('Blocked')).toBeNull();
    });

    it('function 定義の問題は「エージェント向けコンテキストへ移動」でツール名の入力欄へフォーカスする', async () => {
      const diagnoseToolDraft = vi.fn().mockResolvedValue({
        internalId: 'customer-filter', version: '0.0.0', source: 'direct', functionName: 'adult customers', status: 'error',
        checks: [{ id: 'function-definition', status: 'error', detail: "function name 'adult customers' is invalid" }],
      });
      const client = { inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]), diagnoseToolDraft } as unknown as ToolApiClient;
      render(<ToolBuilder client={client} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      act(() => fillRequiredMetadata());
      fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'Go to Agent context' }));
      expect(document.activeElement).toBe(screen.getByLabelText('Agent-facing name'));
    });

    it('失敗は理由つきで示し、閉じると消える', async () => {
      const client = { inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]), diagnoseToolDraft: vi.fn().mockRejectedValue(new Error('server unreachable')) } as unknown as ToolApiClient;
      render(<ToolBuilder client={client} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      act(() => fillRequiredMetadata());
      fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByRole('alert').textContent).toContain('Diagnostics failed: server unreachable');
      fireEvent.click(screen.getByRole('button', { name: 'Close diagnostics' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();
    });

    it('結果はノードを編集しても残り、出力スキーマの行は終端ノードを選ぶ', async () => {
      const diagnoseToolDraft = vi.fn().mockResolvedValue({
        internalId: 'customer-filter', version: 'draft', source: 'direct', functionName: 'adult_customers', status: 'warning',
        checks: [{ id: 'output-schema', status: 'warning', detail: 'declared output schema does not match' }],
      });
      const client = { inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]), diagnoseToolDraft } as unknown as ToolApiClient;
      render(<ToolBuilder client={client} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      act(() => fillRequiredMetadata());
      fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(screen.getByText('Needs attention')).toBeTruthy();

      act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gt', value: 20 }));
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(screen.getByText('Needs attention')).toBeTruthy();

      act(() => useToolBuilderStore.getState().selectNode('source-1'));
      fireEvent.click(screen.getByRole('button', { name: 'Select the output node' }));
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');
    });
  });

  describe('focusToolTarget / terminalNodeId', () => {
    it('グラフに無い nodeId では選択を変えず、落ちない', () => {
      useToolBuilderStore.getState().selectNode('source-1');
      expect(() => focusToolTarget({ nodeId: 'ghost' })).not.toThrow();
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('source-1');
      expect(() => focusToolTarget({})).not.toThrow();
      expect(() => focusToolTarget({ section: 'unknown-section' })).not.toThrow();
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('source-1');
    });

    it('section=output は検証結果の terminalId を使い、無ければ out-degree 0 の出力系ノードを（浮いた変換ノードより）優先する', () => {
      // filter-1 → agent-output と、繋がっていない select。
      useToolBuilderStore.getState().addNode('agent-output');
      const sink = useToolBuilderStore.getState().selectedNodeId ?? '';
      useToolBuilderStore.getState().selectNode(undefined);
      useToolBuilderStore.getState().addNode('select');
      const dangling = useToolBuilderStore.getState().selectedNodeId ?? '';
      expect(useToolBuilderStore.getState().edges.some((edge) => edge.target === dangling)).toBe(false);

      focusToolTarget({ section: 'output' });
      expect(useToolBuilderStore.getState().selectedNodeId).toBe(sink);
      // terminalId がグラフに無い検証結果は無視して同じ候補を選ぶ。
      useToolBuilderStore.getState().setPropagation({ ...valid, terminalId: 'ghost' });
      useToolBuilderStore.getState().selectNode(undefined);
      focusToolTarget({ section: 'output' });
      expect(useToolBuilderStore.getState().selectedNodeId).toBe(sink);
      // 検証結果の terminalId があればそれを選ぶ。
      useToolBuilderStore.getState().setPropagation({ ...valid, terminalId: 'source-1' });
      focusToolTarget({ section: 'output' });
      expect(useToolBuilderStore.getState().selectedNodeId).toBe('source-1');
    });

    it('terminalNodeId は agent-input を終端候補にせず、出力系が無ければ out-degree 0 の先頭ノード、無ければ undefined', () => {
      const { nodes, edges } = useToolBuilderStore.getState();
      expect(terminalNodeId(nodes, edges, undefined)).toBe('filter-1');
      useToolBuilderStore.getState().addNode('agent-input');
      const args = useToolBuilderStore.getState().selectedNodeId ?? '';
      expect(terminalNodeId(useToolBuilderStore.getState().nodes, useToolBuilderStore.getState().edges, undefined)).toBe('filter-1');
      const onlyArgs = useToolBuilderStore.getState().nodes.filter((node) => node.id === args);
      expect(terminalNodeId(onlyArgs, [], undefined)).toBeUndefined();
      expect(terminalNodeId([], [], undefined)).toBeUndefined();
    });

    it('section=agent-context は入力欄が描画されていなくても落ちない', () => {
      expect(document.getElementById('agent-tool-context-name')).toBeNull();
      expect(() => focusToolTarget({ section: 'agent-context' })).not.toThrow();
    });
  });

  describe('下書きの自動保存と復元', () => {
    const newToolKey = draftKey('tool-builder', { tenantId: 'local', workspaceId: 'default' });
    const idleClient = () => ({ inferDraft: vi.fn().mockResolvedValue(valid), previewDraft: vi.fn().mockResolvedValue(sample), listTools: vi.fn().mockResolvedValue([]) }) as unknown as ToolApiClient;

    it('グラフとメタデータを退避し、画面を離れても失わない', async () => {
      const { unmount } = render(<ToolBuilder client={idleClient()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft tool' } });
      act(() => useToolBuilderStore.getState().addNode('filter'));
      unmount();

      const saved = readDraft<{ metadata: { displayName: string }; nodes: readonly unknown[] }>(newToolKey);
      expect(saved?.value.metadata.displayName).toBe('Draft tool');
      expect(saved?.value.nodes).toHaveLength(3);
    });

    it('復元バナーからグラフを戻せる', async () => {
      const { unmount } = render(<ToolBuilder client={idleClient()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Draft tool' } });
      act(() => useToolBuilderStore.getState().addNode('filter'));
      unmount();

      act(() => useToolBuilderStore.getState().reset());
      render(<ToolBuilder client={idleClient()} />);
      fireEvent.click(screen.getByRole('button', { name: 'New tool' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

      expect(useToolBuilderStore.getState().metadata.displayName).toBe('Draft tool');
      expect(useToolBuilderStore.getState().nodes).toHaveLength(3);
      expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
    });
  });
});
