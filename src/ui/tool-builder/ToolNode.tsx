import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useToolBuilderStore, type ToolFlowNode } from './store';

const STATE_LABEL = {
  confirmed: '確定', inferred: '推論', partial: '部分', unknown: '不明', mismatch: '不一致',
} as const;

export function ToolNode({ id, data, selected }: NodeProps<ToolFlowNode>) {
  const inference = useToolBuilderStore((state) => state.propagation?.nodes[id]);
  const hasError = inference?.issues.some((issue) => issue.severity === 'error') ?? false;
  const isSource = data.nodeType.endsWith('-source') || data.nodeType === 'agent-input';
  return (
    <div className={`tool-node ${selected ? 'selected' : ''} ${hasError ? 'invalid' : ''}`}>
      {!isSource && <Handle type="target" position={Position.Left} />}
      <span className="node-kind">{isSource ? 'SOURCE' : 'TRANSFORM'}</span>
      <strong>{data.label}</strong>
      <code>{id}</code>
      {inference !== undefined && (
        <span className={`state-badge state-${inference.state}`}>{STATE_LABEL[inference.state]}</span>
      )}
      {inference?.issues.map((issue, index) => (
        <small className={`node-issue ${issue.severity}`} key={`${issue.message}-${index}`}>{issue.message}</small>
      ))}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
