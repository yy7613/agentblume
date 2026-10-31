import { describe, expect, it, vi } from 'vitest';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import type { Tool } from '../../domain/tool/tool';
import { createTool } from '../../domain/tool/tool';
import { SemVer } from '../../domain/tool/semver';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { validateToolArguments } from './tool-schema';
import { graphWithArguments } from '../tool/tool-execution';
import { exactNumericIdentifier, normalizeIdentifierArguments, withFileSourceSnapshots } from './tool-argument-normalization';

const scope = { tenantId: 't', workspaceId: 'w' };
const engine = new EtlEngine(createDefaultRegistry());
function makeTool(values = ['13000','27000'], transform?: GraphNode): Tool {
  const schema = { columns: [{ name: 'entity', type: 'string' as const, nullable: true }] };
  const graph: ToolGraph = { nodes: [
    { id: 'src', type: 'json-source', config: { rows: values.map((entity, index) => ({ entity, value: index + 1 })) } },
    ...(transform ? [transform] : []),
    { id: 'f', type: 'filter', config: { column: 'entity', op: 'in', values: values.slice(0,1), valueBinding: { source: 'agent-input', field: 'entity' } } },
    { id: 'args', type: 'agent-input', config: { schema, sample: {} } },
  ], edges: transform ? [{ from: 'src', to: transform.id }, { from: transform.id, to: 'f' }] : [{ from: 'src', to: 'f' }] };
  return createTool({ metadata: { internalId: 't', workingName: 'w', displayName: 'T', publishName: 'lookup', owner: 'o', tenant: scope, version: SemVer.parse('1.0.0'), state: 'draft' }, sideEffect: 'read-only', inputSchema: schema, graph });
}
describe('numeric identifiers in complete observed file domains', () => {
  it('quotes an exact unique string identifier and keeps the original arguments', async () => {
    const tool = makeTool(), args = { entity: 13000 };
    const result = await normalizeIdentifierArguments({ tool, arguments: args, engine });
    expect(result.arguments).toEqual({ entity: '13000' });
    expect(result.normalizations).toEqual([{ field: 'entity', reason: 'exact-domain-string' }]);
    expect(args).toEqual({ entity: 13000 });
    const graph = withFileSourceSnapshots(graphWithArguments(tool, validateToolArguments(tool.inputSchema, result.arguments)), result.sourceSnapshots);
    expect(engine.preview(graph).fullOutput.rows).toEqual([{ entity: '13000', value: 1 }]);
  });
  it.each([['01000','1000'], ['01000'], ['1000','1e3'], ['1000',' 1000 ']])('never pads or resolves ambiguous numeric projections: %j', (...values) => {
    expect(exactNumericIdentifier(1000, values)).toBeUndefined();
  });
  it('rejects unsafe integers, fractions and non-finite values', () => {
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, NaN, Infinity]) expect(exactNumericIdentifier(value, [String(value)])).toBeUndefined();
  });
  it('does not use a truncated domain or change a correctly typed identifier', async () => {
    const large = makeTool(Array.from({ length: 61 }, (_, index) => String(10000+index)));
    expect((await normalizeIdentifierArguments({ tool: large, arguments: { entity: 10001 }, engine })).normalizations).toEqual([]);
    expect((await normalizeIdentifierArguments({ tool: makeTool(['01000','1000']), arguments: { entity: '01000' }, engine })).arguments).toEqual({ entity: '01000' });
  });
  it('allows transformations that preserve identifiers but rejects mutations and unknown paths', async () => {
    const preserved = makeTool(undefined, { id: 'c', type: 'calculate', config: { outputColumn: 'twice', expression: '[value]*2' } });
    expect((await normalizeIdentifierArguments({ tool: preserved, arguments: { entity: 13000 }, engine })).normalizations).toHaveLength(1);
    for (const transform of [{ id: 'c', type: 'calculate', config: { outputColumn: 'entity', expression: '13000' } }, { id: 'c', type: 'replace', config: {} }, { id: 'c', type: 'parse-period', config: { column: 'entity', granularityColumn: 'entity' } }]) {
      expect((await normalizeIdentifierArguments({ tool: makeTool(undefined, transform), arguments: { entity: 13000 }, engine })).normalizations).toEqual([]);
    }
  });
  it('never resolves database sources or non-read-only tools for normalization', async () => {
    const resolveFileSource = vi.fn(async () => undefined), base = makeTool();
    const database = { ...base, graph: { ...base.graph, nodes: base.graph.nodes.map(node => node.id === 'src' ? { ...node, type: 'database-source' } : node) } };
    for (const tool of [database, { ...base, sideEffect: 'session-write' as const }]) expect((await normalizeIdentifierArguments({ tool, arguments: { entity: 13000 }, engine, resolveFileSource })).normalizations).toEqual([]);
    expect(resolveFileSource).not.toHaveBeenCalled();
  });
  it('executes the same freshly read file snapshot even if the file changes after normalization', async () => {
    const repository = new InMemoryDataSourceRepository();
    const source = { id: 'ids', tenant: scope, name: 'ids', kind: 'file' as const, format: 'json' as const, contentType: 'application/json' as const, sizeBytes: 20, createdAt: '', updatedAt: '' };
    await repository.save(source, JSON.stringify([{ entity: '13000', value: 1 }]));
    const resolver = new ResolveDataSourceGraphUseCase(repository), read = vi.spyOn(repository, 'readFile');
    const base = makeTool(), tool = { ...base, graph: { ...base.graph, nodes: base.graph.nodes.map(node => node.id === 'src' ? { ...node, config: { dataSourceId: 'ids' } } : node) } };
    const result = await normalizeIdentifierArguments({ tool, arguments: { entity: 13000 }, engine, resolveFileSource: node => resolver.fileSource(scope, node) });
    await repository.save(source, JSON.stringify([{ entity: '13000', value: 99 }, { entity: '013000', value: 100 }]));
    const graph = withFileSourceSnapshots(graphWithArguments(tool, validateToolArguments(tool.inputSchema, result.arguments)), result.sourceSnapshots);
    expect(engine.preview(await resolver.execute(scope, graph)).fullOutput.rows).toEqual([{ entity: '13000', value: 1 }]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(tool.graph.nodes[0]?.config).toEqual({ dataSourceId: 'ids' });
  });
});
