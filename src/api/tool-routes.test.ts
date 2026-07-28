/**
 * /tools ルートのテスト（v4 実装契約 §7）
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` のみで
 * 検証する（実 HTTP ポートは開かない）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp } from '../composition/root';
import type { App } from '../composition/root';
import type { ToolGraph } from '../domain/etl/graph';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const OTHER_SCOPE = { tenantId: 'tenant-b', workspaceId: 'ws-9' };

/** json-source（3行）→ select のシンプルなグラフ。 */
function makeGraph(columns: string[]): ToolGraph {
  return {
    nodes: [
      {
        id: 'src',
        type: 'json-source',
        config: {
          rows: [
            { id: 1, name: 'Alice', age: 30 },
            { id: 2, name: 'Bob', age: 17 },
            { id: 3, name: 'Carol', age: 25 },
          ],
        },
      },
      { id: 'sel', type: 'select', config: { columns } },
    ],
    edges: [{ from: 'src', to: 'sel' }],
  };
}

/** POST /tools の妥当な body（部分上書き可）。 */
function saveBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    scope: SCOPE,
    internalId: 'users-tool',
    workingName: 'users-working',
    displayName: 'Users',
    publishName: 'users',
    owner: 'test@example.com',
    sideEffect: 'read-only',
    graph: makeGraph(['id', 'name', 'age']),
    ...overrides,
  };
}

describe('tool routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    // スコープはPrincipal由来。テストのSCOPEを持つ単一ユーザーとして認証させる。
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  /** POST /tools して JSON を返すヘルパ。 */
  async function postTool(body: Record<string, unknown>) {
    return server.inject({ method: 'POST', url: '/tools', payload: body });
  }

  describe('POST /tools', () => {
    it('201 で SerializedTool を返し、初回は version 1.0.0', async () => {
      const res = await postTool(saveBody());
      expect(res.statusCode).toBe(201);
      const { tool } = res.json();
      expect(tool.metadata.version).toBe('1.0.0');
      expect(tool.metadata.internalId).toBe('users-tool');
      expect(tool.metadata.state).toBe('draft');
      expect(tool.metadata.tenant).toEqual(SCOPE);
      expect(tool.sideEffect).toBe('read-only');
      expect(tool.graph.nodes).toHaveLength(2);
    });

    it('再 POST で 1.0.1（既定 patch bump）、bump=major 指定で 2.0.0', async () => {
      await postTool(saveBody());
      const second = await postTool(saveBody());
      expect(second.statusCode).toBe(201);
      expect(second.json().tool.metadata.version).toBe('1.0.1');

      const third = await postTool(saveBody({ bump: 'major' }));
      expect(third.statusCode).toBe(201);
      expect(third.json().tool.metadata.version).toBe('2.0.0');
    });

    it('inputSchema / outputSchema / state を渡すと保存結果へ反映される', async () => {
      const schema = { columns: [{ name: 'id', type: 'number', nullable: false }] };
      const res = await postTool(
        saveBody({ inputSchema: schema, outputSchema: schema, state: 'published' }),
      );
      expect(res.statusCode).toBe(201);
      const { tool } = res.json();
      expect(tool.inputSchema).toEqual(schema);
      expect(tool.outputSchema).toEqual(schema);
      expect(tool.metadata.state).toBe('published');
    });

    it('不正 body（scope 欠落）→ 400 BAD_REQUEST', async () => {
      const body = saveBody();
      delete body['scope'];
      const res = await postTool(body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });

    it('グラフに存在しない列の select → 400 TOOL_VALIDATION', async () => {
      const res = await postTool(saveBody({ graph: makeGraph(['id', 'no-such-column']) }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TOOL_VALIDATION');
      expect(res.json().error.message).toContain('no-such-column');
    });

    it('ノード座標(position)を保存し、GETで往復できる', async () => {
      const base = makeGraph(['id', 'name']);
      const graph: ToolGraph = {
        ...base,
        nodes: base.nodes.map((node, index) => ({ ...node, position: { x: 100 + index * 300, y: 240 } })),
      };
      const saved = await postTool(saveBody({ graph }));
      expect(saved.statusCode).toBe(201);
      expect(saved.json().tool.graph.nodes.map((n: { position?: unknown }) => n.position)).toEqual([
        { x: 100, y: 240 }, { x: 400, y: 240 },
      ]);

      const got = await server.inject({ method: 'GET', url: '/tools/users-tool', query: { ...SCOPE } });
      expect(got.statusCode).toBe(200);
      expect(got.json().tool.graph.nodes.map((n: { position?: unknown }) => n.position)).toEqual([
        { x: 100, y: 240 }, { x: 400, y: 240 },
      ]);
    });

    it('position無しのグラフはpositionを持たないまま保存される（後方互換）', async () => {
      const res = await postTool(saveBody());
      expect(res.statusCode).toBe(201);
      expect(res.json().tool.graph.nodes.every((n: object) => !('position' in n))).toBe(true);
    });

    it('nodes 201件 / edges 401件 → 400 BAD_REQUEST（グラフ上限）', async () => {
      const nodes = Array.from({ length: 201 }, (_, index) => ({ id: `n${index}`, type: 'json-source', config: { rows: [] } }));
      const tooManyNodes = await postTool(saveBody({ graph: { nodes, edges: [] } }));
      expect(tooManyNodes.statusCode).toBe(400);
      expect(tooManyNodes.json().error.code).toBe('BAD_REQUEST');

      const edges = Array.from({ length: 401 }, () => ({ from: 'src', to: 'sel' }));
      const tooManyEdges = await postTool(saveBody({ graph: { ...makeGraph(['id']), edges } }));
      expect(tooManyEdges.statusCode).toBe(400);
      expect(tooManyEdges.json().error.code).toBe('BAD_REQUEST');
    });

    it('未知ノード type → 422 ETL_GRAPH', async () => {
      const graph: ToolGraph = {
        nodes: [{ id: 'x', type: 'no-such-node', config: {} }],
        edges: [],
      };
      const res = await postTool(saveBody({ graph }));
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('ETL_GRAPH');
    });
  });

  describe('GET /tools/:internalId', () => {
    beforeEach(async () => {
      await postTool(saveBody()); // 1.0.0（select 3列）
      await postTool(saveBody({ graph: makeGraph(['id', 'name']) })); // 1.0.1（select 2列）
    });

    it('version 無指定で latest（1.0.1）を返す', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/users-tool',
        query: { ...SCOPE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tool.metadata.version).toBe('1.0.1');
    });

    it('version 指定でそのバージョンを返す', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/users-tool',
        query: { ...SCOPE, version: '1.0.0' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tool.metadata.version).toBe('1.0.0');
    });

    it('未存在 → 404 TOOL_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/no-such-tool',
        query: { ...SCOPE },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TOOL_NOT_FOUND');
    });

    it('不正 version 文字列 → 400 BAD_REQUEST', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/users-tool',
        query: { ...SCOPE, version: 'not-semver' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });

    it('query に scope が無くても Principal のスコープで解決する', async () => {
      // scope はもうクライアントが決めるものではないので、送らなくても成立する。
      await postTool(saveBody());
      const res = await server.inject({ method: 'GET', url: '/tools/users-tool' });
      expect(res.statusCode).toBe(200);
      expect(res.json().tool.metadata.tenant).toEqual(SCOPE);
    });

    it('query の tenantId が空文字なら 400 BAD_REQUEST（形は従来どおり検証する）', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/users-tool',
        query: { tenantId: '', workspaceId: SCOPE.workspaceId },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('GET /tools/:internalId/versions', () => {
    it('昇順の文字列配列を返す', async () => {
      await postTool(saveBody());
      await postTool(saveBody());
      await postTool(saveBody());
      const res = await server.inject({
        method: 'GET',
        url: '/tools/users-tool/versions',
        query: { ...SCOPE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ versions: ['1.0.0', '1.0.1', '1.0.2'] });
    });

    it('未存在 → 200 { versions: [] }', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/tools/no-such-tool/versions',
        query: { ...SCOPE },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ versions: [] });
    });
  });

  describe('POST /tools/:internalId/infer-schema', () => {
    it('propagation（order / nodes / hasErrors）を含む 200', async () => {
      await postTool(saveBody());
      const res = await server.inject({
        method: 'POST',
        url: '/tools/users-tool/infer-schema',
        payload: { scope: SCOPE },
      });
      expect(res.statusCode).toBe(200);
      const { tool, propagation } = res.json();
      expect(tool.metadata.version).toBe('1.0.0');
      expect(propagation.order).toEqual(['src', 'sel']);
      expect(propagation.hasErrors).toBe(false);
      expect(propagation.nodes['sel'].schema.columns.map((c: { name: string }) => c.name)).toEqual(
        ['id', 'name', 'age'],
      );
      expect(propagation.nodes['src'].state).toBe('inferred');
    });

    it('未存在 → 404 TOOL_NOT_FOUND', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tools/no-such-tool/infer-schema',
        payload: { scope: SCOPE },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TOOL_NOT_FOUND');
    });
  });

  describe('POST /tools/:internalId/preview', () => {
    beforeEach(async () => {
      await postTool(saveBody()); // 1.0.0: select id,name,age
      await postTool(saveBody({ graph: makeGraph(['id', 'name']) })); // 1.0.1: select id,name
    });

    it('latest のプレビュー結果（result.output.rows）を返す', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tools/users-tool/preview',
        payload: { scope: SCOPE },
      });
      expect(res.statusCode).toBe(200);
      const { tool, result } = res.json();
      expect(tool.metadata.version).toBe('1.0.1');
      expect(result.terminalId).toBe('sel');
      expect(result.output.rows).toEqual([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
        { id: 3, name: 'Carol' },
      ]);
    });

    it('rowLimit=1 で行が切り詰められ truncated=true', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tools/users-tool/preview',
        payload: { scope: SCOPE, rowLimit: 1 },
      });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.output.rows).toEqual([{ id: 1, name: 'Alice' }]);
      // 3行のソースが rowLimit=1 で切り詰められる（下流は切詰め済み入力を処理）。
      expect(result.nodes['src'].truncated).toBe(true);
      expect(result.nodes['src'].table.rows).toHaveLength(1);
    });

    it('version=1.0.0 固定で旧グラフ（3列）の結果を返す', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tools/users-tool/preview',
        payload: { scope: SCOPE, version: '1.0.0' },
      });
      expect(res.statusCode).toBe(200);
      const { tool, result } = res.json();
      expect(tool.metadata.version).toBe('1.0.0');
      expect(result.output.rows[0]).toEqual({ id: 1, name: 'Alice', age: 30 });
    });

    it('rowLimit が範囲外（0）→ 400 BAD_REQUEST', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/tools/users-tool/preview',
        payload: { scope: SCOPE, rowLimit: 0 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('DELETE /tools/:internalId', () => {
    it('保存済みToolを論理削除できる（listからは除外、GETはfindLatestのため404、pinned versionはfindVersionで残る）', async () => {
      const saved = await postTool(saveBody());
      expect(saved.statusCode).toBe(201);

      const deleted = await server.inject({ method: 'DELETE', url: '/tools/users-tool', query: SCOPE });
      expect(deleted.statusCode).toBe(204);

      const listed = await server.inject({ method: 'GET', url: '/tools', query: SCOPE });
      expect(listed.json().tools).toEqual([]);

      const getLatest = await server.inject({ method: 'GET', url: '/tools/users-tool', query: SCOPE });
      expect(getLatest.statusCode).toBe(404);
      expect(getLatest.json().error).toMatchObject({ code: 'TOOL_NOT_FOUND' });

      const getPinned = await server.inject({ method: 'GET', url: '/tools/users-tool', query: { ...SCOPE, version: '1.0.0' } });
      expect(getPinned.statusCode).toBe(200);
      expect(getPinned.json().tool.metadata.version).toBe('1.0.0');

      const again = await server.inject({ method: 'DELETE', url: '/tools/users-tool', query: SCOPE });
      expect(again.statusCode).toBe(404);
    });

    it('未存在のToolを削除すると404を返す', async () => {
      const res = await server.inject({ method: 'DELETE', url: '/tools/no-such-tool', query: SCOPE });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatchObject({ code: 'TOOL_NOT_FOUND' });
    });
  });

  /**
   * テナント境界は**Principalが決める**。以前はここをクライアントが body/query で自己申告していたため、
   * `tenantId` を書き換えるだけで他テナントのデータへ届いた。
   *
   * 2種類を分けて確かめる。
   * 1. なりすまし: 自分のトークンで別テナントを名乗っても、見えるのは自分のデータだけ。
   * 2. 分離: 別テナントのPrincipalからは、同じリポジトリを見ても 404 / 空になる。
   */
  describe('テナント分離', () => {
    /** 同じ app（＝同じリポジトリ）を別テナントのPrincipalで見るサーバー。 */
    let otherTenantServer: FastifyInstance;

    beforeEach(async () => {
      await postTool(saveBody());
      otherTenantServer = buildServer(app, { authentication: new SingleUserAuthentication(OTHER_SCOPE) });
    });

    afterEach(async () => { await otherTenantServer.close(); });

    it('別テナントを名乗っても自分のデータしか見えない（申告scopeは無視される）', async () => {
      const res = await server.inject({ method: 'GET', url: '/tools/users-tool', query: { ...OTHER_SCOPE } });
      expect(res.statusCode).toBe(200);
      expect(res.json().tool.metadata.tenant).toEqual(SCOPE);
    });

    it('なりすましのDELETEは自テナントにしか効かない', async () => {
      // OTHER_SCOPE を名乗った削除でも、消えるのは自分のTool。相手のデータは無傷でなければならない。
      await otherTenantServer.inject({ method: 'POST', url: '/tools', payload: saveBody({ scope: SCOPE }) });
      const deleted = await server.inject({ method: 'DELETE', url: '/tools/users-tool', query: { ...OTHER_SCOPE } });
      expect(deleted.statusCode).toBe(204);

      const victim = await otherTenantServer.inject({ method: 'GET', url: '/tools/users-tool', query: { ...SCOPE } });
      expect(victim.statusCode).toBe(200);
      expect(victim.json().tool.metadata.tenant).toEqual(OTHER_SCOPE);
    });

    it('別テナントのPrincipalからの GET は 404', async () => {
      // 相手のscopeを正しく送っても、Principalが違えば見えない。
      const res = await otherTenantServer.inject({ method: 'GET', url: '/tools/users-tool', query: { ...SCOPE } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TOOL_NOT_FOUND');
    });

    it('別テナントのPrincipalからの preview は 404、versions は空配列', async () => {
      const preview = await otherTenantServer.inject({
        method: 'POST',
        url: '/tools/users-tool/preview',
        payload: { scope: SCOPE },
      });
      expect(preview.statusCode).toBe(404);

      const versions = await otherTenantServer.inject({
        method: 'GET',
        url: '/tools/users-tool/versions',
        query: { ...SCOPE },
      });
      expect(versions.json()).toEqual({ versions: [] });
    });
  });
});
