import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'local', workspaceId: 'default' };

describe('sample data routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app);
  });
  afterEach(async () => { await server.close(); app.close(); });

  it('データソース・ツール・スキル・エージェント・Wikiを一括で投入し、投入内容を返す', async () => {
    const response = await server.inject({ method: 'POST', url: '/sample-data', payload: { scope } });

    expect(response.statusCode).toBe(200);
    const { sample } = response.json();
    expect(sample.dataSources).toEqual(['sample-products.csv', 'sample-customers.json', 'sample-monthly-sales.csv']);
    expect(sample.tools).toEqual(['sample-product-catalog']);
    expect(sample.skills).toEqual(['sample-product-analysis']);
    expect(sample.agents).toEqual(['sample-product-assistant']);
    expect(sample.wikis).toEqual(['sample-product-ops']);
    // 3ファイル + Tool + Skill + Wikiスペース + Wikiページ + Agent = 8件。
    expect(sample.created).toBe(8);

    // 実際にAPI経由でも見えるところまで確認する（UIが直後に一覧を読むため）。
    const agents = await server.inject({ method: 'GET', url: '/agents', query: scope });
    expect(agents.json().agents).toMatchObject([{ internalId: 'sample-product-assistant' }]);
    const sources = await server.inject({ method: 'GET', url: '/data-sources', query: scope });
    expect(sources.json().sources.map((source: { name: string }) => source.name)).toEqual(expect.arrayContaining(sample.dataSources));
  });

  it('2回目は何も作らず同じ一覧と created: 0 を返す（冪等・新versionを作らない）', async () => {
    const first = (await server.inject({ method: 'POST', url: '/sample-data', payload: { scope } })).json().sample;
    const second = (await server.inject({ method: 'POST', url: '/sample-data', payload: { scope } })).json().sample;

    expect(second).toEqual({ ...first, created: 0 });
    const agents = await server.inject({ method: 'GET', url: '/agents', query: scope });
    expect(agents.json().agents).toHaveLength(1);
    expect(agents.json().agents[0].latestVersion).toBe('1.0.0');
    const tools = await server.inject({ method: 'GET', url: '/tools', query: scope });
    expect(tools.json().tools).toHaveLength(1);
    expect(tools.json().tools[0].latestVersion).toBe('1.0.0');
  });

  it('scope 無しのbodyでも Principal のスコープへ投入する', async () => {
    // 投入先はPrincipalが決めるので、bodyのscopeは省略できる。
    expect((await server.inject({ method: 'POST', url: '/sample-data', payload: {} })).statusCode).toBe(200);
    const agents = await server.inject({ method: 'GET', url: '/agents', query: scope });
    expect(agents.json().agents).toMatchObject([{ internalId: 'sample-product-assistant' }]);
  });

  it('空文字のscopeは400にする（形の検証は従来どおり）', async () => {
    expect((await server.inject({ method: 'POST', url: '/sample-data', payload: { scope: { tenantId: '', workspaceId: 'default' } } })).statusCode).toBe(400);
  });

  it('workspaceごとに独立して投入できる（境界はPrincipalが決める）', async () => {
    await server.inject({ method: 'POST', url: '/sample-data', payload: { scope } });
    const other = { tenantId: 'local', workspaceId: 'other' };
    const otherServer = buildServer(app, { authentication: new SingleUserAuthentication(other) });
    const response = await otherServer.inject({ method: 'POST', url: '/sample-data', payload: {} });

    expect(response.json().sample.created).toBe(8);
    const agents = await otherServer.inject({ method: 'GET', url: '/agents' });
    expect(agents.json().agents).toMatchObject([{ internalId: 'sample-product-assistant' }]);
    // 元のworkspaceは1件のまま（投入が混ざらない）。
    expect((await server.inject({ method: 'GET', url: '/agents', query: scope })).json().agents).toHaveLength(1);
    await otherServer.close();
  });
});
