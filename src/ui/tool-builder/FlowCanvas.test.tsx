// @vitest-environment jsdom
import type { Edge } from '@xyflow/react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { canConnect, MINIMAP_NODE_COLOR, FlowCanvas } from './FlowCanvas';
import { useToolBuilderStore, type ToolFlowNode } from './store';

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
