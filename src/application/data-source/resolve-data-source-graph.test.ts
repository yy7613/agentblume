import { describe, expect, it } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { ToolGraph } from '../../domain/etl/graph';
import { ResolveDataSourceGraphUseCase } from './resolve-data-source-graph';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('ResolveDataSourceGraphUseCase', () => {
  it('CSV/JSONのopaque dataSourceIdを実行直前にだけインライン値へ展開する', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'csv-1', tenant: scope, name: 'Rows', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 8, createdAt: '', updatedAt: '' }, 'id,name\n1,A');
    await repository.save({ id: 'json-1', tenant: scope, name: 'JSON rows', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 10, createdAt: '', updatedAt: '' }, '[{"id":2}]');
    const resolver = new ResolveDataSourceGraphUseCase(repository);
    const csvGraph: ToolGraph = { nodes: [{ id: 'source', type: 'csv-source', config: { dataSourceId: 'csv-1' } }], edges: [] };
    const jsonGraph: ToolGraph = { nodes: [{ id: 'source', type: 'json-source', config: { dataSourceId: 'json-1' } }], edges: [] };
    await expect(resolver.execute(scope, csvGraph)).resolves.toEqual({ nodes: [{ id: 'source', type: 'csv-source', config: { text: 'id,name\n1,A' } }], edges: [] });
    await expect(resolver.execute(scope, jsonGraph)).resolves.toEqual({ nodes: [{ id: 'source', type: 'json-source', config: { rows: [{ id: 2 }] } }], edges: [] });
    expect(csvGraph.nodes[0]?.config).toEqual({ dataSourceId: 'csv-1' });
  });

  it('形式不一致・存在しないsource・JSON配列でないpayloadをfail closedにする', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'json-object', tenant: scope, name: 'Object', kind: 'file', format: 'json', contentType: 'application/json', sizeBytes: 2, createdAt: '', updatedAt: '' }, '{}');
    const resolver = new ResolveDataSourceGraphUseCase(repository);
    await expect(resolver.execute(scope, { nodes: [{ id: 'csv', type: 'csv-source', config: { dataSourceId: 'json-object' } }], edges: [] })).rejects.toThrow('not CSV');
    await expect(resolver.execute(scope, { nodes: [{ id: 'json', type: 'json-source', config: { dataSourceId: 'json-object' } }], edges: [] })).rejects.toThrow('array of objects');
    await expect(resolver.execute(scope, { nodes: [{ id: 'none', type: 'json-source', config: { dataSourceId: 'missing' } }], edges: [] })).rejects.toThrow('unavailable');
  });

  it('DB sourceはallowlist済みtableを固定上限で読み、json-sourceとして実行へ渡す', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'db-1', tenant: scope, name: 'Reporting', kind: 'database', connectionId: 'reporting', driver: 'postgresql', createdAt: '', updatedAt: '' });
    const readTable = async (connectionId: string, table: string, limit: number) => {
      expect({ connectionId, table, limit }).toEqual({ connectionId: 'reporting', table: 'public.sales_daily', limit: 25 });
      return [{ id: 1, amount: 42 }];
    };
    const resolver = new ResolveDataSourceGraphUseCase(repository, { readTable });
    await expect(resolver.execute(scope, { nodes: [{ id: 'db', type: 'database-source', config: { dataSourceId: 'db-1', table: 'public.sales_daily', limit: 25 } }], edges: [] })).resolves.toEqual({ nodes: [{ id: 'db', type: 'json-source', config: { rows: [{ id: 1, amount: 42 }] } }], edges: [] });
    await expect(resolver.execute(scope, { nodes: [{ id: 'db', type: 'database-source', config: { dataSourceId: 'db-1', table: '' } }], edges: [] })).rejects.toThrow('requires a table');
  });

  it('DB reader未構成・reader拒否をTool実行へ漏らさずfail closedにする', async () => {
    const repository = new InMemoryDataSourceRepository();
    await repository.save({ id: 'db-1', tenant: scope, name: 'Reporting', kind: 'database', connectionId: 'reporting', driver: 'postgresql', createdAt: '', updatedAt: '' });
    const graph: ToolGraph = { nodes: [{ id: 'db', type: 'database-source', config: { dataSourceId: 'db-1', table: 'public.sales_daily' } }], edges: [] };
    await expect(new ResolveDataSourceGraphUseCase(repository).execute(scope, graph)).rejects.toThrow('not configured');
    await expect(new ResolveDataSourceGraphUseCase(repository, { readTable: async () => { throw new Error('connection detail'); } }).execute(scope, graph)).rejects.toThrow("cannot read allowed table");
  });
});
