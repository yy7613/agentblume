/**
 * ドメイン層: グラフ型（v1 実装契約 §10 / v2 §1 でドメインへ移動）— 型のみ。
 *
 * ツールを構成する ETL ノードの有向グラフ（DAG）表現。
 * 実行時の振る舞いは `engine.ts`（EtlEngine）が担う。
 */
import type { NodeId } from './ids';

/** 編集UI（Tool Builder）のキャンバス座標。実行には影響しないレイアウトメタデータ。 */
export interface GraphNodePosition {
  readonly x: number;
  readonly y: number;
}

/** グラフ上の1ノード。`type` は `NodeRegistry` に登録された EtlNode を指す。 */
export interface GraphNode {
  readonly id: NodeId;
  readonly type: string;
  /** ノード固有の設定。EtlNode.validateConfig で検証される。 */
  readonly config: unknown;
  /**
   * 編集UIでの配置。手動整列を保存→再読込で失わないために永続化する任意フィールド。
   * EtlEngine は参照しない（実行結果に影響しない）。
   */
  readonly position?: GraphNodePosition;
}

/** 有向辺（from → to）。`toInput` は to ノードの入力ポート番号（既定 0）。 */
export interface GraphEdge {
  readonly from: NodeId;
  readonly to: NodeId;
  /** to ノードの入力ポート（既定 0）。多入力ノードの入力順序決定に用いる。 */
  readonly toInput?: number;
}

/** ノードとエッジからなるツールグラフ。 */
export interface ToolGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}
