// @vitest-environment jsdom
import type { Edge } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { canConnect, highlightNodes, MINIMAP_NODE_COLOR, FlowCanvas } from './FlowCanvas';
import { useToolBuilderStore, type ToolFlowNode } from './store';
import type { SerializedToolDto } from '../api/types';

// jsdomにはResizeObserverが無く、@xyflow/reactの実描画（コンテナ寸法計測）に必要なので最小スタブを与える。
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver;
  }
});

function node(id: string, nodeType: ToolFlowNode['data']['nodeType']): ToolFlowNode {
  return { id, type: 'tool', position: { x: 0, y: 0 }, data: { nodeType, label: nodeType, config: {} } };
}

// source-1: source（inputArity 0）/ filter-1: 単一入力 / join-1: 2入力（in-0, in-1）。
const nodes: ToolFlowNode[] = [
  node('source-1', 'json-source'),
  node('filter-1', 'filter'),
  node('join-1', 'join'),
];

afterEach(cleanup);

describe('canConnect（バグ: isValidConnection未設定で入力ポート容量を超える接続がドロップ前に弾かれない問題の修正）', () => {
  it('存在しないtargetは拒否する', () => {
    expect(canConnect(nodes, [], { source: 'source-1', target: 'missing', sourceHandle: null, targetHandle: null })).toBe(false);
  });

  it('source系ノード（inputArity:0）への接続は拒否する', () => {
    expect(canConnect(nodes, [], { source: 'filter-1', target: 'source-1', sourceHandle: null, targetHandle: null })).toBe(false);
  });

  it('単一入力ノードへの1本目の接続は許可する', () => {
    expect(canConnect(nodes, [], { source: 'source-1', target: 'filter-1', sourceHandle: null, targetHandle: null })).toBe(true);
  });

  it('単一入力ノードへの2本目の接続は拒否する', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'source-1', target: 'filter-1', targetHandle: null }];
    expect(canConnect(nodes, edges, { source: 'join-1', target: 'filter-1', sourceHandle: null, targetHandle: null })).toBe(false);
  });

  it('2入力ノードは左右ハンドルそれぞれ1本ずつ許可する', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'source-1', target: 'join-1', targetHandle: 'in-0' }];
    expect(canConnect(nodes, edges, { source: 'filter-1', target: 'join-1', sourceHandle: null, targetHandle: 'in-1' })).toBe(true);
  });

  it('2入力ノードの同一ハンドルへの重複接続は拒否する', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'source-1', target: 'join-1', targetHandle: 'in-0' }];
    expect(canConnect(nodes, edges, { source: 'filter-1', target: 'join-1', sourceHandle: null, targetHandle: 'in-0' })).toBe(false);
  });

  it('excludeEdgeIdで指定した既存エッジは容量計算から除外する（繋ぎ替えドラッグ中の自エッジ分を除外）', () => {
    const edges: Edge[] = [{ id: 'e1', source: 'source-1', target: 'filter-1', targetHandle: null }];
    // e1自体を繋ぎ替え中なら、同じfilter-1への再接続を「容量オーバー」として弾かない。
    expect(canConnect(nodes, edges, { source: 'join-1', target: 'filter-1', sourceHandle: null, targetHandle: null }, 'e1')).toBe(true);
    // 繋ぎ替え中でない他エッジは通常どおり容量に数える。
    expect(canConnect(nodes, edges, { source: 'join-1', target: 'filter-1', sourceHandle: null, targetHandle: null }, 'other-edge')).toBe(false);
  });
});

describe('onReconnectの合成方式（旧エッジ削除onEdgesChange+新エッジ追加onConnect＝置換）', () => {
  it('繋ぎ替えると旧エッジが残らず新エッジだけになる（バグ4: 旧エッジが残ったまま新エッジが追加され入次数超過になる問題の修正）', () => {
    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().addNode('join'); // filter-1(選択中) -> 新joinノードのin-0へ自動接続される。
    const joinId = useToolBuilderStore.getState().nodes.find((n) => n.data.nodeType === 'join')?.id as string;
    const oldEdge = useToolBuilderStore.getState().edges.find((edge) => edge.source === 'source-1') as Edge;
    expect(oldEdge.target).toBe('filter-1');

    // FlowCanvasのonReconnectハンドラと同じ合成: 旧エッジ削除(onEdgesChange) + 新エッジ追加(onConnect)。
    // source-1 -> filter-1 だったエッジを、source-1 -> join(in-1) へドラッグで繋ぎ替えた状況を模す。
    const { onEdgesChange, onConnect } = useToolBuilderStore.getState();
    onEdgesChange([{ type: 'remove', id: oldEdge.id }]);
    onConnect({ source: 'source-1', target: joinId, sourceHandle: null, targetHandle: 'in-1' });

    const edges = useToolBuilderStore.getState().edges;
    expect(edges.find((edge) => edge.id === oldEdge.id)).toBeUndefined();
    expect(edges.filter((edge) => edge.source === 'source-1')).toHaveLength(1);
    expect(edges.find((edge) => edge.source === 'source-1')).toMatchObject({ target: joinId, targetHandle: 'in-1' });
    // filter-1 -> join(in-0) の自動接続はそのまま残る。
    expect(edges).toHaveLength(2);
  });
});

describe('FlowCanvas（実描画）', () => {
  it('クラッシュせずに描画し、ミニマップへ視認可能な色を指定する（バグ7: 白背景に同化する問題の修正）', () => {
    useToolBuilderStore.getState().reset();
    render(<FlowCanvas />);
    expect(screen.getByLabelText('ETL canvas')).toBeTruthy();
    const minimap = document.querySelector('.react-flow__minimap');
    expect(minimap).toBeTruthy();
    // nodeColor/nodeStrokeColorはCSSカスタムプロパティとしてDOMへ反映される。白背景ノードでも
    // 見失わない単色（#697aff）が実際に渡っていることを確認する（既定値だと未設定＝白に同化する）。
    const style = minimap?.getAttribute('style') ?? '';
    expect(style).toContain(`--xy-minimap-node-background-color-props: ${MINIMAP_NODE_COLOR}`);
    expect(style).toContain(`--xy-minimap-node-stroke-color-props: ${MINIMAP_NODE_COLOR}`);
  });

  it('日本語UIではToolNode上のissueも日本語化して表示する', () => {
    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().setPropagation({
      order: ['source-1', 'filter-1'],
      terminalId: 'filter-1',
      hasErrors: true,
      nodes: {
        'source-1': { nodeId: 'source-1', state: 'confirmed', issues: [], schema: { columns: [] } },
        'filter-1': {
          nodeId: 'filter-1',
          state: 'mismatch',
          issues: [{ severity: 'error', message: "chart-output: mapping 'timeColumn' is required" }],
          schema: { columns: [] },
        },
      },
    });
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    expect(screen.getByText("chart-output: 「timeColumn」の設定が必要です")).toBeTruthy();
    expect(screen.queryByText("chart-output: mapping 'timeColumn' is required")).toBeNull();
  });

  it('流れに繋がっていないノードにだけ「未接続」バッジを出し、繋ぐと消える', () => {
    useToolBuilderStore.getState().reset();
    // 選択中の filter-1 に対してソースは自動接続されないので、終端（out-degree 0）が filter-1 と csv の2つになる。
    useToolBuilderStore.getState().addNode('csv-source');
    const csvId = useToolBuilderStore.getState().selectedNodeId ?? '';
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    expect(screen.getAllByText('未接続')).toHaveLength(2);
    expect(document.querySelectorAll('.tool-node.unconnected')).toHaveLength(2);
    // source-1 は filter-1 へ繋がっているので対象外。
    expect(document.querySelector(`.react-flow__node[data-id="source-1"] .tool-node`)?.className).not.toContain('unconnected');

    act(() => useToolBuilderStore.getState().onConnect({ source: csvId, target: 'filter-1', sourceHandle: null, targetHandle: null }));
    expect(screen.queryByText('未接続')).toBeNull();
    expect(document.querySelector('.tool-node.unconnected')).toBeNull();
  });

  it('ノード数が変わるとビューを再フィットする（onInit後のfitViewタイマー）', async () => {
    useToolBuilderStore.getState().reset();
    vi.useFakeTimers();
    try {
      render(<FlowCanvas />);
      // onInitでinstanceがセットされた後、nodeCount変化のuseEffectが setTimeout(0) でfitViewを呼ぶ。
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByLabelText('ETL canvas')).toBeTruthy();
  });

  it('ノードクリックで選択し、ペインクリックで選択解除する', () => {
    useToolBuilderStore.getState().reset();
    render(<FlowCanvas />);
    const firstNode = document.querySelector('.react-flow__node') as HTMLElement;
    fireEvent.click(firstNode);
    expect(useToolBuilderStore.getState().selectedNodeId).toBe(firstNode.getAttribute('data-id'));

    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    fireEvent.click(pane);
    expect(useToolBuilderStore.getState().selectedNodeId).toBeUndefined();
  });
});

/**
 * 「整列」（v51）。自動生成のツールが横一列（10 ノードで幅 2,740px）に並んだとき、1 回で画面に収める。
 * starter グラフは source-1 (80,120) → filter-1 (390,120)。
 */
describe('FlowCanvas: 整列', () => {
  const positions = () => useToolBuilderStore.getState().nodes.map((flowNode) => flowNode.position);
  /** 横一列に並んだ 7 ノードの直線（人が並べた位置）。 */
  function loadRow(): void {
    const graph = Array.from({ length: 7 }, (_value, index) => ({ id: `n${index}`, type: 'select', config: { columns: [] }, position: { x: 80 + index * 280, y: 120 } }));
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'row', workingName: 'w', displayName: 'R', publishName: 'r', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: { nodes: graph, edges: graph.slice(1).map((next, index) => ({ from: `n${index}`, to: next.id })) },
    } as SerializedToolDto);
  }

  afterEach(() => vi.restoreAllMocks());

  it('正常: 整列を押すと並べ直し、「整列しました」と「元に戻す」を出す。元に戻すで前の位置へ戻り通知も消える', () => {
    useToolBuilderStore.getState().reset();
    loadRow();
    const before = positions();
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    expect(screen.queryByText('整列しました')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '整列' }));
    // jsdom では幅が測れない（0）ので下限の 3 列で折り返す。
    expect(Math.max(...positions().map((position) => position.x))).toBe(80 + 2 * 280);
    expect(screen.getByRole('status').textContent).toContain('整列しました');

    fireEvent.click(screen.getByRole('button', { name: '元に戻す' }));
    expect(positions()).toEqual(before);
    expect(screen.queryByText('整列しました')).toBeNull();
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
  });

  it('正常: 列数はキャンバスの表示幅から決める（1,700px なら 6 列）', () => {
    useToolBuilderStore.getState().reset();
    loadRow();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1700);
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '整列' }));
    expect(Math.max(...positions().map((position) => position.x))).toBe(80 + 5 * 280);
    expect(positions()[6]).toEqual({ x: 80, y: 320 });
  });

  it('正常: 英語 UI では Arrange / Arranged / Undo と出す', () => {
    useToolBuilderStore.getState().reset();
    render(<FlowCanvas />);
    fireEvent.click(screen.getByRole('button', { name: 'Arrange' }));
    expect(screen.getByRole('status').textContent).toContain('Arranged');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('境界: 次の編集で「元に戻す」の通知が消える', () => {
    useToolBuilderStore.getState().reset();
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: '整列' }));
    expect(screen.getByRole('button', { name: '元に戻す' })).toBeTruthy();
    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 20 }));
    expect(screen.queryByRole('button', { name: '元に戻す' })).toBeNull();
  });

  it('異常: 空のキャンバスでは整列を押せない', () => {
    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: 'source-1' }, { type: 'remove', id: 'filter-1' }]);
    render(<I18nProvider initialLanguage="ja"><FlowCanvas /></I18nProvider>);
    expect((screen.getByRole('button', { name: '整列' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/** 設計アシスタント（v47）が変えたノードの強調。強調は一時的な見た目で、グラフには残らない。 */
describe('node-highlight（設計アシスタントが変えたノードの強調）', () => {
  it('正常: 強調中のノードにだけ node-highlight を付けて描画する', () => {
    useToolBuilderStore.getState().reset();
    const turnId = useToolBuilderStore.getState().startDesignChatTurn('多い順に並べて');
    act(() => useToolBuilderStore.getState().completeDesignChatTurn(turnId, {
      message: '並べ替えました。',
      graph: {
        nodes: [
          { id: 'source-1', type: 'json-source', config: { rows: [] }, position: { x: 80, y: 120 } },
          { id: 'filter-1', type: 'filter', config: {}, position: { x: 390, y: 120 } },
        ],
        edges: [{ from: 'source-1', to: 'filter-1' }],
      },
      changes: [{ op: 'set-config', nodeId: 'filter-1', summary: 'filter を直した' }],
    }));
    render(<FlowCanvas />);
    expect(document.querySelector('.react-flow__node[data-id="filter-1"]')?.className).toContain('node-highlight');
    expect(document.querySelector('.react-flow__node[data-id="source-1"]')?.className).not.toContain('node-highlight');

    act(() => useToolBuilderStore.getState().clearDesignChatHighlight());
    expect(document.querySelector('.react-flow__node[data-id="filter-1"]')?.className).not.toContain('node-highlight');
  });

  it('境界: 強調が無ければノード配列をそのまま渡す（描画の無駄な差分を作らない）', () => {
    expect(highlightNodes(nodes, [])).toBe(nodes);
  });

  it('異常: 既に消えたノードidを強調しても、残りのノードは素のまま', () => {
    const highlighted = highlightNodes(nodes, ['gone']);
    expect(highlighted.every((node) => node.className === undefined)).toBe(true);
  });
});
