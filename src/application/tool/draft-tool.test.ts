import { describe, expect, it } from 'vitest';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { EtlEngine } from '../etl/engine';
import { DraftToolUseCase } from './draft-tool';

const graph: ToolGraph = {
  nodes: [
    { id: 'source', type: 'json-source', config: { rows: [{ age: 17 }, { age: 20 }] } },
    { id: 'adult', type: 'filter', config: { column: 'age', op: 'gte', value: 18 } },
  ],
  edges: [{ from: 'source', to: 'adult' }],
};

describe('DraftToolUseCase', () => {
  const useCase = new DraftToolUseCase(new EtlEngine(createDefaultRegistry()));

  it('未保存 graph のスキーマを検査する', async () => {
    const propagation = await useCase.inspect(graph);
    expect(propagation.order).toEqual(['source', 'adult']);
    expect(propagation.nodes['adult']?.schema.columns[0]?.name).toBe('age');
    expect(propagation.hasErrors).toBe(false);
  });

  it('未保存 graph を行数制限付きでプレビューする', async () => {
    const result = await useCase.preview(graph, { rowLimit: 1 });
    expect(result.output.rows).toEqual([]);
    expect(result.nodes['source']?.truncated).toBe(true);
  });

  it('option省略時は engine の既定行数を使う', async () => {
    const result = await useCase.preview(graph);
    expect(result.output.rows).toEqual([{ age: 20 }]);
  });
});
