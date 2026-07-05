import { Handle, Position, type NodeProps } from '@xyflow/react';
import { catalogItem, inputHandleId } from './node-catalog';
import { useToolBuilderStore, type ToolFlowNode } from './store';
import { useI18n } from '../i18n';

const STATE_LABEL = {
  confirmed: '確定', inferred: '推論', partial: '部分', unknown: '不明', mismatch: '不一致',
} as const;

export function ToolNode({ id, data, selected }: NodeProps<ToolFlowNode>) {
  const inference = useToolBuilderStore((state) => state.propagation?.nodes[id]);
  const { text } = useI18n();
  const hasError = inference?.issues.some((issue) => issue.severity === 'error') ?? false;
  const item = catalogItem(data.nodeType);
  const isSource = item.kind === 'source';
  return (
    <div className={`tool-node ${selected ? 'selected' : ''} ${hasError ? 'invalid' : ''}`}>
      {item.inputArity === 1 && <Handle type="target" position={Position.Left} />}
      {item.inputArity === 2 && (
        <>
          <Handle id={inputHandleId(0)} type="target" position={Position.Left} style={{ top: '35%' }} />
          <Handle id={inputHandleId(1)} type="target" position={Position.Left} style={{ top: '70%' }} />
          <span className="input-label" style={{ top: '35%' }}>{text('left', '左')}</span>
          <span className="input-label" style={{ top: '70%' }}>{text('right', '右')}</span>
        </>
      )}
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
