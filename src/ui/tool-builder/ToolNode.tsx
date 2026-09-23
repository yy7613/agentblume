import { type CSSProperties } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { localizeSchemaIssueMessage } from '../api/error-messages';
import { unconnectedNodeIds } from './draft-readiness';
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
  // 流れに繋がっていないノードをキャンバス上でも示す（boolean を選ぶので再描画は変化時だけ）。
  const unconnected = useToolBuilderStore((state) => unconnectedNodeIds(state.nodes, state.edges).includes(id));
  const zoom = useStore((state) => state.transform[2]);
  const { text, language } = useI18n();
  const hasError = inference?.issues.some((issue) => issue.severity === 'error') ?? false;
  const item = catalogItem(data.nodeType);
  const isSource = item.kind === 'source';
  return (
    <div className={`tool-node ${selected ? 'selected' : ''} ${hasError ? 'invalid' : ''} ${unconnected ? 'unconnected' : ''}`}>
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
      {/* 区分と種別名はパレット・設定欄と同じ言葉で出す（v53: 以前は英語固定の data.label だった）。 */}
      <span className="node-kind">{isSource ? text('SOURCE', '入力') : item.kind === 'sink' ? text('OUTPUT', '出力') : item.kind === 'analyze' ? text('ANALYZE', '分析') : text('TRANSFORM', '変換')}</span>
      <strong>{text(item.label, item.labelJa)}</strong>
      <code>{id}</code>
      {inference !== undefined && (
        <span className={`state-badge state-${inference.state}`}>{STATE_LABEL[inference.state]}</span>
      )}
      {unconnected && <small className="node-issue warning unconnected-badge">{text('not connected', '未接続')}</small>}
      {inference?.issues.map((issue, index) => (
        <small className={`node-issue ${issue.severity}`} key={`${issue.message}-${index}`}>{localizeSchemaIssueMessage(issue.message, language)}</small>
      ))}
      {item.kind !== 'sink' && <Handle type="source" position={Position.Right} style={constantSizeHandleStyle(zoom)} />}
    </div>
  );
}
