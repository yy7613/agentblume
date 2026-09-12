import { describe, expect, it } from 'vitest';
import { SchemaError } from '../../domain/etl/errors';
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

  it('未保存 graph を表示行数制限付きでプレビューする（計算は全行で行う）', async () => {
    const result = await useCase.preview(graph, { rowLimit: 1 });
    // source(2 行) のスナップショットは 1 行に絞られるが、filter は 2 行全部から計算して 20 を残す
    // （修正前は切り詰めた 1 行 [17] から計算し、出力が空になっていた）。
    expect(result.nodes['source']).toMatchObject({ truncated: true, rowCount: 2 });
    expect(result.nodes['source']?.table.rows).toEqual([{ age: 17 }]);
    expect(result.nodes['adult']).toMatchObject({ truncated: false, rowCount: 1 });
    expect(result.output.rows).toEqual([{ age: 20 }]);
    expect(result.fullOutput.rows).toEqual([{ age: 20 }]);
  });

  it('実行上限（250,000 行）を超える source は nodeId 付きの SchemaError で止まる', async () => {
    const huge: ToolGraph = {
      nodes: [{ id: 'source', type: 'json-source', config: { rows: Array.from({ length: 250_001 }, () => ({ v: 1 })) } }],
      edges: [],
    };
    const rejection: unknown = await useCase.preview(huge).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(SchemaError);
    expect(rejection).toMatchObject({
      nodeId: 'source',
      message: 'json-source: produced 250001 rows, exceeding the execution limit of 250000 rows',
    });
  });

  it('option省略時は engine の既定行数を使う', async () => {
    const result = await useCase.preview(graph);
    expect(result.output.rows).toEqual([{ age: 20 }]);
  });
});
