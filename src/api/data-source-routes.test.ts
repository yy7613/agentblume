import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
describe('data source routes', () => {
  let app: App; let server: FastifyInstance;
  beforeEach(() => {
    vi.stubEnv('AGENTCONTEXT_DB_CONNECTIONS', JSON.stringify({ sales: { driver: 'postgresql', host: 'localhost', database: 'sales', username: 'reader', passwordEnv: 'SALES_PASSWORD' } }));
    app = createApp({ profile: 'test' }); server = buildServer(app);
  });
  afterEach(async () => { await server.close(); app.close(); vi.unstubAllEnvs(); });

  it('CSV/JSONの保存・一覧・削除とDB接続IDの登録を提供し、payload/secretを返さない', async () => {
    const file = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'customers.json', format: 'json', content: '[{"customer":"A"}]' } });
    expect(file.statusCode).toBe(201); expect(file.json().source).toMatchObject({ kind: 'file', name: 'customers.json' });
    expect(JSON.stringify(file.json())).not.toContain('"A"');
    const connection = await server.inject({ method: 'GET', url: '/data-sources/connections' });
    expect(connection.json()).toEqual({ connections: [{ id: 'sales', driver: 'postgresql' }] });
    const database = await server.inject({ method: 'POST', url: '/data-sources/databases', payload: { scope, name: 'Sales', connectionId: 'sales', defaultSchema: 'reporting' } });
    expect(database.statusCode).toBe(201); expect(database.json().source).toMatchObject({ kind: 'database', connectionId: 'sales', defaultSchema: 'reporting' });
    const list = await server.inject({ method: 'GET', url: '/data-sources?tenantId=tenant&workspaceId=workspace' });
    expect(list.json().sources).toHaveLength(2);
    const test = await server.inject({ method: 'POST', url: '/data-sources/connections/sales/test', payload: { scope } });
    expect(test.json().connection).toMatchObject({ id: 'sales', available: false });
    const remove = await server.inject({ method: 'DELETE', url: `/data-sources/${file.json().source.id}?tenantId=tenant&workspaceId=workspace` });
    expect(remove.statusCode).toBe(204);
  });

  it('不正JSONと未構成connectionIdを400にする', async () => {
    const json = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'bad.json', format: 'json', content: '{' } });
    expect(json.statusCode).toBe(400); expect(json.json().error.code).toBe('DATA_SOURCE_VALIDATION');
    const database = await server.inject({ method: 'POST', url: '/data-sources/databases', payload: { scope, name: 'Unknown', connectionId: 'unknown' } });
    expect(database.statusCode).toBe(400); expect(database.json().error.code).toBe('DATA_SOURCE_VALIDATION');
  });

  it('登録CSVをdataSourceIdでTool draft・保存済みToolへ安全に接続する', async () => {
    const uploaded = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'rows.csv', format: 'csv', content: 'id,name\n1,A\n2,B' } });
    const sourceId = uploaded.json().source.id as string;
    const graph = { nodes: [{ id: 'source', type: 'csv-source', config: { dataSourceId: sourceId } }], edges: [] };
    const draft = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { scope, graph } });
    expect(draft.statusCode).toBe(200); expect(draft.json().result.output.rows).toEqual([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
    const saved = await server.inject({ method: 'POST', url: '/tools', payload: { scope, internalId: 'source-tool', workingName: 'Source tool', displayName: 'Source Tool', publishName: 'source_tool', owner: 'owner', sideEffect: 'read-only', graph } });
    expect(saved.statusCode).toBe(201); expect(saved.json().tool.graph.nodes[0].config).toEqual({ dataSourceId: sourceId });
    const preview = await server.inject({ method: 'POST', url: '/tools/source-tool/preview', payload: { scope } });
    expect(preview.statusCode).toBe(200); expect(preview.json().result.output.rows).toHaveLength(2);
  });
});
