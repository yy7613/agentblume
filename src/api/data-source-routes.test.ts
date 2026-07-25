import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';
import type { SearchProviderCatalog } from '../application/search/search-provider';

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
    expect(json.statusCode).toBe(400); expect(json.json().error.code).toBe('INVALID_FILE_CONTENT');
    const database = await server.inject({ method: 'POST', url: '/data-sources/databases', payload: { scope, name: 'Unknown', connectionId: 'unknown' } });
    expect(database.statusCode).toBe(400); expect(database.json().error.code).toBe('DATA_SOURCE_VALIDATION');
  });

  it('壊れたCSVと壊れたJSONを400 INVALID_FILE_CONTENTにする', async () => {
    const binaryContent = `id,name\n1,A${String.fromCharCode(0)}B`;
    const binary = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'binary.csv', format: 'csv', content: binaryContent } });
    expect(binary.statusCode).toBe(400); expect(binary.json().error.code).toBe('INVALID_FILE_CONTENT');
    expect(binary.json().error.message).toMatch(/csv content could not be parsed/);
    const noHeader = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'no-header.csv', format: 'csv', content: '\n1,2,3' } });
    expect(noHeader.statusCode).toBe(400); expect(noHeader.json().error.code).toBe('INVALID_FILE_CONTENT');
    const badJson = await server.inject({ method: 'POST', url: '/data-sources/files', payload: { scope, name: 'bad2.json', format: 'json', content: 'not-json' } });
    expect(badJson.statusCode).toBe(400); expect(badJson.json().error.code).toBe('INVALID_FILE_CONTENT');
    expect(badJson.json().error.message).toMatch(/json content could not be parsed/);
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

  it('設定済み検索providerだけを公開し、明示取得キャッシュをWeb検索sourceへ解決する', async () => {
    await server.close(); app.close();
    const providers: SearchProviderCatalog = {
      list: () => [{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }],
      search: async (request) => [{ title: request.query, url: 'https://example.test', snippet: 'cached', score: 0.8, provider: request.provider, retrievedAt: '2026-07-12T00:00:00.000Z' }],
    };
    app = createApp({ profile: 'test', searchProviderCatalog: providers }); server = buildServer(app);
    expect((await server.inject({ method: 'GET', url: '/search-providers' })).json()).toEqual({ providers: [{ id: 'tavily', label: 'Tavily Search', supportsDomainFilter: true }] });
    const fetched = await server.inject({ method: 'POST', url: '/web-searches', payload: { scope, provider: 'tavily', query: 'LLMOps', maxResults: 3 } });
    expect(fetched.statusCode).toBe(201);
    const cacheKey = fetched.json().search.cacheKey as string;
    const graph = { nodes: [{ id: 'search', type: 'web-search-source', config: { provider: 'tavily', query: 'LLMOps', maxResults: 3, cacheKey } }], edges: [] };
    const draft = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { scope, graph } });
    expect(draft.statusCode).toBe(200); expect(draft.json().result.output.rows).toMatchObject([{ title: 'LLMOps', provider: 'tavily' }]);
    const changedGraph = {
      ...graph,
      nodes: [{ ...graph.nodes[0]!, config: { ...graph.nodes[0]!.config, query: 'different' } }],
    };
    const changed = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { scope, graph: changedGraph } });
    expect(changed.statusCode).toBe(400); expect(changed.json().error.code).toBe('DATA_SOURCE_VALIDATION');
  });
});
