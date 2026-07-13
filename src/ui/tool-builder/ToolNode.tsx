import { type CSSProperties } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { catalogItem, inputHandleId } from './node-catalog';
import { useToolBuilderStore, type ToolFlowNode } from './store';
import { useI18n } from '../i18n';

const STATE_LABEL = {
  confirmed: '確定', inferred: '推論', partial: '部分', unknown: '不明', mismatch: '不一致',
} as const;

/** 始点・終点の丸（コネクションハンドル）の画面上の直径(px)。ズームによらず一定に見せる基準値。 */
export const HANDLE_SCREEN_SIZE = 14;

/**
 * ハンドルはReact Flowのviewport（transform: scale(zoom)）内に描画されるため、
 * 画面上のサイズはズーム倍率に比例して変わる。基準px をズームで割ったflow座標系サイズを与えることで、
 * どのズームでも画面上は一定サイズに見えるようにする。centering用のtranslateは
 * デフォルトCSS側（%指定）に任せるため transform は上書きしない。
 */
export function constantSizeHandleStyle(zoom: number, extra?: CSSProperties): CSSProperties {
  const scale = zoom > 0 ? zoom : 1;
  const size = HANDLE_SCREEN_SIZE / scale;
  // width/height だけでなく min-width/min-height(既定5px)も上書きしないと、高ズーム時に下限で潰れて大きく見える。
  return { width: size, height: size, minWidth: size, minHeight: size, borderWidth: 1 / scale, ...extra };
}

export function ToolNode({ id, data, selected }: NodeProps<ToolFlowNode>) {
  const inference = useToolBuilderStore((state) => state.propagation?.nodes[id]);
  const zoom = useStore((state) => state.transform[2]);
  const { text } = useI18n();
  const hasError = inference?.issues.some((issue) => issue.severity === 'error') ?? false;
  const item = catalogItem(data.nodeType);
  const isSource = item.kind === 'source';
  return (
    <div className={`tool-node ${selected ? 'selected' : ''} ${hasError ? 'invalid' : ''}`}>
      {item.inputArity === 1 && (
        <Handle type="target" position={Position.Left} style={constantSizeHandleStyle(zoom)} />
      )}
      {item.inputArity === 2 && (
        <>
          <Handle id={inputHandleId(0)} type="target" position={Position.Left} style={constantSizeHandleStyle(zoom, { top: '35%' })} />
          <Handle id={inputHandleId(1)} type="target" position={Position.Left} style={constantSizeHandleStyle(zoom, { top: '70%' })} />
          <span className="input-label" style={{ top: '35%' }}>{text('left', '左')}</span>
          <span className="input-label" style={{ top: '70%' }}>{text('right', '右')}</span>
        </>
      )}
      <span className="node-kind">{isSource ? 'SOURCE' : item.kind === 'sink' ? 'OUTPUT' : item.kind === 'analyze' ? 'ANALYZE' : 'TRANSFORM'}</span>
      <strong>{data.label}</strong>
      <code>{id}</code>
      {inference !== undefined && (
        <span className={`state-badge state-${inference.state}`}>{STATE_LABEL[inference.state]}</span>
      )}
      {inference?.issues.map((issue, index) => (
        <small className={`node-issue ${issue.severity}`} key={`${issue.message}-${index}`}>{issue.message}</small>
      ))}
      {item.kind !== 'sink' && <Handle type="source" position={Position.Right} style={constantSizeHandleStyle(zoom)} />}
    </div>
  );
}
