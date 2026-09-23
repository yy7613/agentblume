import {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useRef, useState } from 'react';
import { ToolNode } from './ToolNode';
import { catalogItem } from './node-catalog';
import { columnsForWidth } from './layout';
import { useToolBuilderStore, type ToolFlowNode } from './store';
import { useI18n } from '../i18n';

const nodeTypes: NodeTypes = { tool: ToolNode };

/** ミニマップのノード色。ノード種別によらず単色にし、白背景の.tool-nodeでも見失わないようにする。 */
export const MINIMAP_NODE_COLOR = '#697aff';

/**
 * 接続先ノードの入力ポート容量（node-catalog.ts の inputArity）を超える接続、および
 * 同一ハンドルへの重複接続をドロップ前に拒否する。source系ノード（inputArity: 0）は
 * 入力を一切受け付けない。
 *
 * `excludeEdgeId` は繋ぎ替え（onReconnect）ドラッグ中の元エッジidを容量計算から除外するために使う。
 * xyflowの isValidConnection にはどのエッジを動かしているかの情報が渡らないため、
 * onReconnectStart/End で拾ったidをFlowCanvas側のstateから渡す（省略時は通常の新規接続として判定）。
 */
export function canConnect(
  nodes: readonly ToolFlowNode[],
  edges: readonly Edge[],
  candidate: Connection | Edge,
  excludeEdgeId?: string,
): boolean {
  const target = nodes.find((node) => node.id === candidate.target);
  if (target === undefined) return false;
  const arity = catalogItem(target.data.nodeType).inputArity;
  if (arity === 0) return false;
  const handle = candidate.targetHandle ?? null;
  const occupied = edges.filter((edge) =>
    edge.id !== excludeEdgeId && edge.target === candidate.target && (edge.targetHandle ?? null) === handle,
  ).length;
  return occupied === 0;
}

/**
 * 設計アシスタント（v47）が足した・変えたノードに強調クラスを付ける。
 *
 * ノードそのものには印を持たせず、描画のたびに store の強調リストから被せる
 * （強調は数秒で消える一時的な見た目で、保存されるグラフの一部ではないため）。
 * 強調が無いときは元の配列をそのまま返し、React Flow に無駄な差分を渡さない。
 */
export function highlightNodes(nodes: ToolFlowNode[], highlight: readonly string[]): ToolFlowNode[] {
  if (highlight.length === 0) return nodes;
  return nodes.map((node) => highlight.includes(node.id) ? { ...node, className: 'node-highlight' } : node);
}

/** キャンバス上の矩形（flow 座標）。 */
export interface FlowRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/**
 * flow 座標の矩形が、いまの表示（viewport）でキャンバスの内側に丸ごと収まっているか。
 * 端がはみ出すノードは、隣の区画（パレット・設定欄）の陰になってクリックできないので「見えていない」とする。
 * キャンバスの寸法が測れない（0）ときは確かめようがないので、見えていないものとして扱う（見せに行く側へ倒す）。
 */
export function isRectVisible(rect: FlowRect, viewport: Viewport, size: { readonly width: number; readonly height: number }): boolean {
  if (size.width <= 0 || size.height <= 0) return false;
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;
  return left >= 0 && top >= 0 && left + rect.width * viewport.zoom <= size.width && top + rect.height * viewport.zoom <= size.height;
}

/** revealNodes が使う React Flow の最小限の操作（テストで差し替えられるように型を絞る）。 */
export interface RevealTarget {
  getViewport(): Viewport;
  getInternalNode(id: string): { readonly internals: { readonly positionAbsolute: { readonly x: number; readonly y: number } }; readonly measured: { readonly width?: number; readonly height?: number } } | undefined;
  fitView(options?: { readonly padding?: number; readonly duration?: number; nodes?: { id: string }[] }): Promise<boolean>;
}

const FIT_OPTIONS = { padding: 0.2, duration: 200 } as const;

/**
 * 設計アシスタントが既存のキャンバスへ足したノードを見せる（v53）。
 *
 * 1. 足したノードが全部見えていれば何もしない（人が合わせた表示を崩さない）。
 * 2. 見えていなければ全体に fitView する。
 * 3. それでも見えない（ノードが多く、最小ズームで全体が収まらない）なら、足したノードへ fitView する。
 * `settled` は直前に始めた全体の fitView（ノード数の変化で走る）。重ねて動かさないよう終わるのを待つ。
 */
export async function revealNodes(
  flow: RevealTarget,
  nodeIds: readonly string[],
  size: () => { readonly width: number; readonly height: number },
  settled?: Promise<unknown>,
): Promise<'visible' | 'fit-all' | 'fit-added'> {
  await settled;
  const present = nodeIds.filter((id) => flow.getInternalNode(id) !== undefined);
  const hidden = (): boolean => present.some((id) => {
    const node = flow.getInternalNode(id);
    if (node === undefined) return false;
    const rect = { ...node.internals.positionAbsolute, width: node.measured.width ?? 0, height: node.measured.height ?? 0 };
    return !isRectVisible(rect, flow.getViewport(), size());
  });
  if (present.length === 0 || !hidden()) return 'visible';
  await flow.fitView(FIT_OPTIONS);
  if (!hidden()) return 'fit-all';
  await flow.fitView({ ...FIT_OPTIONS, nodes: present.map((id) => ({ id })) });
  return 'fit-added';
}

export function FlowCanvas() {
  const storedNodes = useToolBuilderStore((state) => state.nodes);
  const highlight = useToolBuilderStore((state) => state.designChat.highlight);
  const nodes = highlightNodes(storedNodes, highlight);
  const edges = useToolBuilderStore((state) => state.edges);
  const onNodesChange = useToolBuilderStore((state) => state.onNodesChange);
  const onEdgesChange = useToolBuilderStore((state) => state.onEdgesChange);
  const onConnect = useToolBuilderStore((state) => state.onConnect);
  const selectNode = useToolBuilderStore((state) => state.selectNode);
  const arrangeNodes = useToolBuilderStore((state) => state.arrangeNodes);
  const undoArrange = useToolBuilderStore((state) => state.undoArrange);
  const arranged = useToolBuilderStore((state) => state.arrangeUndo !== undefined);
  const layoutRevision = useToolBuilderStore((state) => state.layoutRevision);
  // 整列の列数はキャンバスの表示幅から決める（ズーム 1 で横に収まる列数。測れなければ下限の 3 列）。
  const canvasRef = useRef<HTMLElement>(null);
  const [instance, setInstance] = useState<ReactFlowInstance<ToolFlowNode, Edge>>();
  // 繋ぎ替えドラッグ中の元エッジid。isValidConnectionの容量判定から除外し、自ノードへ戻す・
  // 別ハンドルへ移す操作を「容量オーバー」として誤って弾かないようにする。
  const [reconnectingEdgeId, setReconnectingEdgeId] = useState<string>();
  const { text } = useI18n();

  // パレットから追加したノードは選択ノードの右280pxへ置かれ、可視域外へ落ちることがある。
  // ノード数が変わったらビューを再フィットして「押したのに何も起きない」を防ぐ。
  // 全体を並べ直したとき（整列・元に戻す・折り返しての読み込み）はノード数が変わらないこともあるので、
  // store の layoutRevision でも再フィットする（v51）。
  const nodeCount = nodes.length;
  // 直近の全体 fitView。足したノードを見せる処理（下）がこれの終わりを待ってから確かめる。
  const fitAll = useRef<Promise<unknown> | undefined>(undefined);
  useEffect(() => {
    if (instance === undefined) return;
    const timer = window.setTimeout(() => { fitAll.current = instance.fitView(FIT_OPTIONS); }, 0);
    return () => window.clearTimeout(timer);
  }, [instance, nodeCount, layoutRevision]);

  // 設計アシスタントが既存のキャンバスへ足したノード（v53）。全体 fitView だけでは最小ズームで収まらない・
  // ノード数が変わらない（足して消した）ときに画面外へ残るので、足したノードが見えるまで表示を合わせる。
  // 上の fitView と同じ tick のタイマーで、宣言順に後から走る（fitAll.current が先に入る）。
  const reveal = useToolBuilderStore((state) => state.designChatReveal);
  useEffect(() => {
    if (instance === undefined || reveal === undefined) return;
    const timer = window.setTimeout(() => {
      const size = () => ({ width: canvasRef.current?.clientWidth ?? 0, height: canvasRef.current?.clientHeight ?? 0 });
      void revealNodes(instance, reveal.nodeIds, size, fitAll.current);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [instance, reveal]);

  return (
    <main ref={canvasRef} className="flow-canvas" aria-label={text('ETL canvas', 'ETLキャンバス')}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onInit={(current) => setInstance(current)}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => selectNode(node.id)}
        onPaneClick={() => selectNode(undefined)}
        // 既存エッジの端点をドラッグして繋ぎ替えられるようにする。storeにreconnect専用APIが
        // 無いため、旧エッジの削除(onEdgesChange)+新エッジの追加(onConnect)を合成して置換する。
        onReconnectStart={(_, edge) => setReconnectingEdgeId(edge.id)}
        onReconnectEnd={() => setReconnectingEdgeId(undefined)}
        onReconnect={(oldEdge, newConnection) => {
          onEdgesChange([{ type: 'remove', id: oldEdge.id }]);
          onConnect(newConnection);
        }}
        isValidConnection={(candidate) => canConnect(nodes, edges, candidate, reconnectingEdgeId)}
        fitView
        deleteKeyCode={['Backspace', 'Delete']}
        // クリック選択を安定させる: 微小な手ぶれをノードのドラッグ移動や誤接続として扱わない閾値(px)。
        nodeDragThreshold={4}
        connectionDragThreshold={4}
      >
        {/* 操作列（v51）。整列は人が並べた位置も動かすので、直後に 1 段だけ「元に戻す」を出す（次の編集で消える）。 */}
        <Panel position="top-left" className="flow-canvas-actions">
          <button type="button" className="secondary" disabled={nodeCount === 0}
            title={text('Lay the nodes out in columns by processing step, wrapping to fit the canvas width', '処理の段ごとに列へ並べ、キャンバスの幅で折り返します')}
            onClick={() => arrangeNodes(columnsForWidth(canvasRef.current?.clientWidth ?? 0))}>
            {text('Arrange', '整列')}
          </button>
          {arranged && <span className="flow-canvas-arranged" role="status">
            {text('Arranged', '整列しました')}
            <button type="button" className="ghost" onClick={undoArrange}>{text('Undo', '元に戻す')}</button>
          </span>}
        </Panel>
        <Background gap={24} size={1} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={MINIMAP_NODE_COLOR} nodeStrokeColor={MINIMAP_NODE_COLOR} />
      </ReactFlow>
    </main>
  );
}
