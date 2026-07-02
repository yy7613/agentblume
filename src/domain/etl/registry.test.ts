import { describe, expect, it } from 'vitest';
import type { Schema, Table } from '../data/types';
import { GraphError } from './errors';
import type { EtlNode, SchemaInference } from './node';
import { NodeRegistry } from './registry';

/** テスト用のダミーノードを生成する。 */
function makeDummy(type: string): EtlNode {
  return {
    type,
    kind: 'transform',
    inputArity: 1,
    validateConfig: (config: unknown) => config,
    inferSchema: (inputs: readonly Schema[]): SchemaInference => ({
      schema: inputs[0] ?? { columns: [] },
      state: 'confirmed',
      issues: [],
    }),
    execute: (inputs: readonly Table[]): Table =>
      inputs[0] ?? { schema: { columns: [] }, rows: [] },
  };
}

describe('NodeRegistry', () => {
  it('registers and gets a node by type', () => {
    const reg = new NodeRegistry();
    const dummy = makeDummy('dummy');
    reg.register(dummy);
    expect(reg.get('dummy')).toBe(dummy);
  });

  it('has() reflects registration', () => {
    const reg = new NodeRegistry();
    expect(reg.has('dummy')).toBe(false);
    reg.register(makeDummy('dummy'));
    expect(reg.has('dummy')).toBe(true);
  });

  it('types() returns registered types in registration order', () => {
    const reg = new NodeRegistry();
    reg.register(makeDummy('a'));
    reg.register(makeDummy('b'));
    reg.register(makeDummy('c'));
    expect(reg.types()).toEqual(['a', 'b', 'c']);
  });

  it('duplicate register throws GraphError', () => {
    const reg = new NodeRegistry();
    reg.register(makeDummy('dummy'));
    expect(() => reg.register(makeDummy('dummy'))).toThrowError(GraphError);
  });

  it('get on unknown type throws GraphError', () => {
    const reg = new NodeRegistry();
    expect(() => reg.get('missing')).toThrowError(GraphError);
  });

  it('empty registry: types() is [] and has() is false', () => {
    const reg = new NodeRegistry();
    expect(reg.types()).toEqual([]);
    expect(reg.has('anything')).toBe(false);
  });
});
