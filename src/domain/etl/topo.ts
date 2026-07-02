/**
 * ドメイン: トポロジカルソート（v1 実装契約 §7）
 *
 * Kahn 法。`nodeIds` の入力順を尊重した安定な順序で返す。
 */
import { GraphError } from './errors';

/** 有向辺（from → to）。 */
export interface DirectedEdge {
  readonly from: string;
  readonly to: string;
}

/**
 * ノード群を依存順（from が to より前）に並べて返す。
 *
 * - 未知ノードidを参照する edge → GraphError。
 * - 閉路検出 → GraphError。
 * - 同時に選択可能なノードは `nodeIds` の入力順で確定（安定順序）。
 *
 * 入力配列は破壊的変更しない。
 */
export function topologicalSort(
  nodeIds: readonly string[],
  edges: readonly DirectedEdge[],
): string[] {
  const known = new Set(nodeIds);

  // 位置索引（安定順序のため）。同名idが複数あっても最初の位置を採用。
  const position = new Map<string, number>();
  nodeIds.forEach((id, i) => {
    if (!position.has(id)) position.set(id, i);
  });

  const indegree = new Map<string, number>();
  for (const id of nodeIds) {
    if (!indegree.has(id)) indegree.set(id, 0);
  }
  // 隣接（from → to のリスト）。
  const adjacency = new Map<string, string[]>();

  for (const edge of edges) {
    if (!known.has(edge.from)) {
      throw new GraphError(`edge references unknown node id: ${edge.from}`);
    }
    if (!known.has(edge.to)) {
      throw new GraphError(`edge references unknown node id: ${edge.to}`);
    }
    const list = adjacency.get(edge.from);
    if (list === undefined) adjacency.set(edge.from, [edge.to]);
    else list.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  // 入次数0の集合を安定順序で管理。ソート済み配列を選択キューとして使う。
  const rankOf = (id: string): number => position.get(id) ?? 0;

  const ready: string[] = [];
  for (const id of nodeIds) {
    if ((indegree.get(id) ?? 0) === 0) ready.push(id);
  }
  ready.sort((a, b) => rankOf(a) - rankOf(b));

  const result: string[] = [];
  while (ready.length > 0) {
    // ready 内で最小 rank（= nodeIds で最も先）を取り出す。
    const id = ready.shift() as string;
    result.push(id);

    const neighbors = adjacency.get(id) ?? [];
    const newlyReady: string[] = [];
    for (const to of neighbors) {
      const d = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, d);
      if (d === 0) newlyReady.push(to);
    }
    if (newlyReady.length > 0) {
      // 新たに ready になったものを安定順序で挿入。
      for (const n of newlyReady) ready.push(n);
      ready.sort((a, b) => rankOf(a) - rankOf(b));
    }
  }

  if (result.length !== known.size) {
    throw new GraphError('graph has a cycle');
  }

  return result;
}
