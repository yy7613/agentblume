/**
 * アプリ層: グラフ型（v1 実装契約 §10）— 型のみ。
 *
 * ツールを構成する ETL ノードの有向グラフ（DAG）表現。
 * 実行時の振る舞いは `engine.ts`（EtlEngine）が担う。
 */

/** グラフ上の1ノード。`type` は `NodeRegistry` に登録された EtlNode を指す。 */
export interface GraphNode {
  readonly id: string;
  readonly type: string;
  /** ノード固有の設定。EtlNode.validateConfig で検証される。 */
  readonly config: unknown;
}

/** 有向辺（from → to）。`toInput` は to ノードの入力ポート番号（既定 0）。 */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  /** to ノードの入力ポート（既定 0）。多入力ノードの入力順序決定に用いる。 */
  readonly toInput?: number;
}

/** ノードとエッジからなるツールグラフ。 */
export interface ToolGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}
