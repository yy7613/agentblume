import { describe, expect, it } from 'vitest';
import { GraphError } from './errors';
import { topologicalSort, type DirectedEdge } from './topo';

describe('topologicalSort', () => {
  it('linear chain a->b->c', () => {
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ];
    expect(topologicalSort(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c']);
  });

  it('respects nodeIds order for ready nodes (stable)', () => {
    // edges provided in a "reversed" input order; result must still be stable by nodeIds.
    const edges: DirectedEdge[] = [
      { from: 'b', to: 'c' },
      { from: 'a', to: 'c' },
    ];
    expect(topologicalSort(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c']);
  });

  it('branch: a->b, a->c (b before c by input order)', () => {
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
    ];
    expect(topologicalSort(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c']);
  });

  it('branch respects nodeIds order even when listed c before b', () => {
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'c' },
      { from: 'a', to: 'b' },
    ];
    expect(topologicalSort(['a', 'b', 'c'], edges)).toEqual(['a', 'b', 'c']);
  });

  it('merge: a->c, b->c', () => {
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'c' },
      { from: 'b', to: 'c' },
    ];
    const result = topologicalSort(['a', 'b', 'c'], edges);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('isolated nodes are kept in input order', () => {
    const edges: DirectedEdge[] = [{ from: 'a', to: 'b' }];
    // 'x' and 'y' are isolated.
    expect(topologicalSort(['x', 'a', 'y', 'b'], edges)).toEqual(['x', 'a', 'y', 'b']);
  });

  it('no edges -> input order preserved', () => {
    expect(topologicalSort(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('empty graph -> empty result', () => {
    expect(topologicalSort([], [])).toEqual([]);
  });

  it('throws GraphError for a cycle a->b->a', () => {
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(() => topologicalSort(['a', 'b'], edges)).toThrowError(GraphError);
  });

  it('throws GraphError for a self-loop', () => {
    expect(() => topologicalSort(['a'], [{ from: 'a', to: 'a' }])).toThrowError(GraphError);
  });

  it('throws GraphError when edge.from is unknown', () => {
    expect(() =>
      topologicalSort(['a', 'b'], [{ from: 'zzz', to: 'b' }]),
    ).toThrowError(GraphError);
  });

  it('throws GraphError when edge.to is unknown', () => {
    expect(() =>
      topologicalSort(['a', 'b'], [{ from: 'a', to: 'zzz' }]),
    ).toThrowError(GraphError);
  });

  it('produces a valid topological order for a complex DAG', () => {
    // a->b, a->c, b->d, c->d, d->e
    const edges: DirectedEdge[] = [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'c', to: 'd' },
      { from: 'd', to: 'e' },
    ];
    const order = topologicalSort(['a', 'b', 'c', 'd', 'e'], edges);
    const pos = (id: string): number => order.indexOf(id);
    for (const e of edges) {
      expect(pos(e.from)).toBeLessThan(pos(e.to));
    }
    expect(order).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('does not mutate input arrays', () => {
    const nodeIds = ['a', 'b'];
    const edges: DirectedEdge[] = [{ from: 'a', to: 'b' }];
    const nodeSnap = [...nodeIds];
    const edgeSnap = JSON.stringify(edges);
    topologicalSort(nodeIds, edges);
    expect(nodeIds).toEqual(nodeSnap);
    expect(JSON.stringify(edges)).toBe(edgeSnap);
  });
});
