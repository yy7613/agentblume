import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ToolNode } from './ToolNode';
import { useToolBuilderStore } from './store';

const nodeTypes: NodeTypes = { tool: ToolNode };

export function FlowCanvas() {
  const nodes = useToolBuilderStore((state) => state.nodes);
  const edges = useToolBuilderStore((state) => state.edges);
  const onNodesChange = useToolBuilderStore((state) => state.onNodesChange);
  const onEdgesChange = useToolBuilderStore((state) => state.onEdgesChange);
  const onConnect = useToolBuilderStore((state) => state.onConnect);
  const selectNode = useToolBuilderStore((state) => state.selectNode);
  return (
    <main className="flow-canvas" aria-label="ETL canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, node) => selectNode(node.id)}
        onPaneClick={() => selectNode(undefined)}
        fitView
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={24} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </main>
  );
}
