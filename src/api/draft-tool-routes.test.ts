import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../composition/root';
import { createApp } from '../composition/root';
import { buildServer } from './server';

const graph = {
  nodes: [
    { id: 'source', type: 'json-source', config: { rows: [{ age: 17 }, { age: 20 }] } },
    { id: 'adult', type: 'filter', config: { column: 'age', op: 'gte', value: 18 } },
  ],
  edges: [{ from: 'source', to: 'adult' }],
};

describe('draft tool routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('POST /tool-drafts/infer-schema は保存せず伝播結果を返す', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/tool-drafts/infer-schema',
      payload: { graph },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().propagation).toMatchObject({
      order: ['source', 'adult'],
      hasErrors: false,
    });
    await expect(app.repo.listVersions({ tenantId: 't', workspaceId: 'w' }, 'draft')).resolves.toEqual([]);
  });

  it('schema mismatch は issue と hasErrors=true で返す', async () => {
    const invalid = {
      ...graph,
      nodes: [graph.nodes[0], { id: 'adult', type: 'filter', config: { column: 'missing', op: 'eq', value: 1 } }],
    };
    const response = await server.inject({ method: 'POST', url: '/tool-drafts/infer-schema', payload: { graph: invalid } });
    expect(response.statusCode).toBe(200);
    expect(response.json().propagation.hasErrors).toBe(true);
    expect(response.json().propagation.nodes.adult.issues[0].column).toBe('missing');
  });

  it('POST /tool-drafts/preview は rowLimit を適用する', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/tool-drafts/preview',
      payload: { graph, rowLimit: 1 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.nodes.source.truncated).toBe(true);
    expect(response.json().result.nodes.source.table.rows).toHaveLength(1);
  });

  it('不正 body は 400 BAD_REQUEST', async () => {
    const response = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { graph, rowLimit: 0 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('不正 graph は既存 mapping で 422 ETL_GRAPH', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/tool-drafts/infer-schema',
      payload: { graph: { nodes: [], edges: [] } },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('ETL_GRAPH');
  });
});
