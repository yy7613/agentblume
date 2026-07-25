import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useState } from 'react';
import { ToolNode } from './ToolNode';
import { catalogItem } from './node-catalog';
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

export function FlowCanvas() {
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  const onNodesChange = useToolBuilderStore((state) => state.onNodesChange);
  const onEdgesChange = useToolBuilderStore((state) => state.onEdgesChange);
  const onConnect = useToolBuilderStore((state) => state.onConnect);
  const selectNode = useToolBuilderStore((state) => state.selectNode);
  const [instance, setInstance] = useState<ReactFlowInstance<ToolFlowNode, Edge>>();
  // 繋ぎ替えドラッグ中の元エッジid。isValidConnectionの容量判定から除外し、自ノードへ戻す・
  // 別ハンドルへ移す操作を「容量オーバー」として誤って弾かないようにする。
  const [reconnectingEdgeId, setReconnectingEdgeId] = useState<string>();
  const { text } = useI18n();

  // パレットから追加したノードは選択ノードの右280pxへ置かれ、可視域外へ落ちることがある。
  // ノード数が変わったらビューを再フィットして「押したのに何も起きない」を防ぐ。
  const nodeCount = nodes.length;
  useEffect(() => {
    if (instance === undefined) return;
    const timer = window.setTimeout(() => { void instance.fitView({ padding: 0.2, duration: 200 }); }, 0);
    return () => window.clearTimeout(timer);
  }, [instance, nodeCount]);

  return (
    <main className="flow-canvas" aria-label={text('ETL canvas', 'ETLキャンバス')}>
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
        <Background gap={24} size={1} />
        <Controls />
        <MiniMap pannable zoomable nodeColor={MINIMAP_NODE_COLOR} nodeStrokeColor={MINIMAP_NODE_COLOR} />
      </ReactFlow>
    </main>
  );
}
