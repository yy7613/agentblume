import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import type { App } from '../composition/root';
import { createApp } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { explicitRouteAuthorization } from './authorization';
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

  it('POST /tool-drafts/preview は全行で計算し、返す行数だけ rowLimit で絞る（各ノードに rowCount、fullOutput は返さない）', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/tool-drafts/preview',
      payload: { graph, rowLimit: 1 },
    });
    expect(response.statusCode).toBe(200);
    const { result } = response.json();
    expect(result.nodes.source).toMatchObject({ truncated: true, rowCount: 2 });
    expect(result.nodes.source.table.rows).toHaveLength(1);
    // filter は 2 行全部から計算するので 20 を残す（修正前は切り詰めた 1 行 [17] から計算し、空だった）。
    expect(result.nodes.adult).toMatchObject({ truncated: false, rowCount: 1 });
    expect(result.output.rows).toEqual([{ age: 20 }]);
    // 終端の全行（最大 25 万行）はブラウザへ送らない。
    expect(result).not.toHaveProperty('fullOutput');
  });

  describe('POST /tool-drafts/preview の rowLimit 境界', () => {
    it.each([1, 10000])('rowLimit=%s は 200', async (rowLimit) => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { graph, rowLimit } });
      expect(response.statusCode).toBe(200);
      expect(response.json().result.nodes.source.rowCount).toBe(2);
    });

    it.each([0, -1, 1.5, 10001])('rowLimit=%s は 400 BAD_REQUEST（API は 1〜10000 の整数だけ受ける）', async (rowLimit) => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { graph, rowLimit } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('rowLimit') });
    });
  });

  it('実行上限（250,000 行）を超えるノードは 422 ETL_SCHEMA で止まる（切り捨てて 200 にしない）', async () => {
    const huge = { nodes: [{ id: 'source', type: 'json-source', config: { rows: Array.from({ length: 250_001 }, () => ({ v: 1 })) } }], edges: [] };
    const response = await server.inject({ method: 'POST', url: '/tool-drafts/preview', payload: { graph: huge } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      code: 'ETL_SCHEMA',
      message: 'json-source: produced 250001 rows, exceeding the execution limit of 250000 rows',
    });
  });

  it('POST /tool-drafts/diagnose は未保存Toolを保存せずに診断し、版は 0.0.0 で報告する', async () => {
    const draft = { scope: { tenantId: 't', workspaceId: 'w' }, internalId: 'draft', workingName: 'Draft', displayName: 'Adults', publishName: 'list_adults', owner: 'owner', sideEffect: 'read-only', graph };
    const response = await server.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload: draft });
    expect(response.statusCode).toBe(200);
    const { diagnostics } = response.json();
    expect(diagnostics).toMatchObject({ internalId: 'draft', version: '0.0.0', source: 'direct', functionName: 'list_adults', status: 'ok' });
    expect(diagnostics.checks).toEqual(expect.arrayContaining([
      { id: 'state', status: 'ok' }, { id: 'function-definition', status: 'ok' }, { id: 'agent-input', status: 'ok' }, { id: 'graph', status: 'ok' }, { id: 'execution', status: 'ok' },
    ]));
    // 参照解決（resolved）は保存済み Tool にしか無い。保存もされない。
    expect(diagnostics.checks.some((check: { id: string }) => check.id === 'resolved')).toBe(false);
    await expect(app.repo.listVersions({ tenantId: 't', workspaceId: 'w' }, 'draft')).resolves.toEqual([]);

    // 壊れた draft は段階別に報告され、graph 検査の nodeId は根本原因のノードを指す。
    const broken = { ...draft, publishName: 'bad name', state: 'archived', graph: { ...graph, nodes: [graph.nodes[0], { id: 'adult', type: 'filter', config: { column: 'missing', op: 'eq', value: 1 } }] } };
    const failing = (await server.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload: broken })).json().diagnostics;
    expect(failing.status).toBe('error');
    expect(failing.functionName).toBeUndefined();
    expect(failing.checks).toEqual(expect.arrayContaining([
      { id: 'state', status: 'error', detail: 'tool is archived, so it should not be attached to an agent' },
      { id: 'function-definition', status: 'error', detail: 'tool name is not a valid function name: bad name' },
    ]));
    expect(failing.checks.find((check: { id: string }) => check.id === 'graph')).toMatchObject({ status: 'error', nodeId: 'adult' });

    const invalid = await server.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload: { graph } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('BAD_REQUEST');
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

  describe('POST /tool-drafts/diagnose 境界・異常系', () => {
    const SCOPE = { tenantId: 't', workspaceId: 'w' };
    const TOKEN = 'r'.repeat(40);
    const draft = { scope: SCOPE, internalId: 'draft', workingName: 'Draft', displayName: 'Adults', publishName: 'list_adults', owner: 'owner', sideEffect: 'read-only', graph };
    /** 指定ロールだけを持つ主体として認証する最小の port（authorization.test.ts と同じ形）。 */
    function rolesAuth(roles: readonly AuthorizationRole[]): AuthenticationPort {
      return {
        mode: 'token', required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', ...SCOPE, roles })
          : rejected('missing-credentials'),
      };
    }
    const diagnoseDraft = (payload: Record<string, unknown>) => server.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload });
    const checkOf = (diagnostics: { checks: { id: string }[] }, id: string) => diagnostics.checks.find((check) => check.id === id);

    it('zod で弾く不正 body は 400 BAD_REQUEST でフィールドのパスを示す（空 publishName・65 文字の agentTool.name・不正 sideEffect）', async () => {
      const emptyName = await diagnoseDraft({ ...draft, publishName: '' });
      expect(emptyName.statusCode).toBe(400);
      expect(emptyName.json().error).toMatchObject({ code: 'BAD_REQUEST' });
      expect(emptyName.json().error.message).toContain('publishName');
      const longAgentToolName = await diagnoseDraft({ ...draft, agentTool: { name: 'a'.repeat(65), description: 'd' } });
      expect(longAgentToolName.statusCode).toBe(400);
      expect(longAgentToolName.json().error.message).toContain('agentTool.name');
      const badSideEffect = await diagnoseDraft({ ...draft, sideEffect: 'bogus' });
      expect(badSideEffect.statusCode).toBe(400);
      expect(badSideEffect.json().error.message).toContain('sideEffect');
    });

    it('zod は通るが createTool が拒否する agentTool.name（空白入り）は 400 TOOL_VALIDATION', async () => {
      const res = await diagnoseDraft({ ...draft, agentTool: { name: 'bad name', description: 'd' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('TOOL_VALIDATION');
    });

    it('構造違反のグラフは 422 ではなく 200 の graph error として返す（ノード特定なし・ドライランなし）', async () => {
      const dangling = await diagnoseDraft({ ...draft, graph: { ...graph, edges: [{ from: 'source', to: 'nowhere' }] } });
      expect(dangling.statusCode).toBe(200);
      const { diagnostics } = dangling.json();
      expect(diagnostics.status).toBe('error');
      expect(checkOf(diagnostics, 'graph')).toMatchObject({ status: 'error' });
      expect(checkOf(diagnostics, 'graph')).not.toHaveProperty('nodeId');
      expect(checkOf(diagnostics, 'execution')).toBeUndefined();
      const empty = await diagnoseDraft({ ...draft, graph: { nodes: [], edges: [] } });
      expect(empty.statusCode).toBe(200);
      expect(checkOf(empty.json().diagnostics, 'graph')).toMatchObject({ status: 'error' });
    });

    it('非 read-only の副作用は side-effect の warning、read-only なら項目自体を出さない。bump は無視する', async () => {
      const writer = await diagnoseDraft({ ...draft, sideEffect: 'write', bump: 'major' });
      expect(writer.statusCode).toBe(200);
      expect(writer.json().diagnostics).toMatchObject({ version: '0.0.0', status: 'warning' });
      expect(checkOf(writer.json().diagnostics, 'side-effect')).toEqual({ id: 'side-effect', status: 'warning', detail: "side effect 'write' pauses the run for approval before this tool executes" });
      const reader = await diagnoseDraft(draft);
      expect(checkOf(reader.json().diagnostics, 'side-effect')).toBeUndefined();
    });

    it('agent-input 契約と outputSchema の不整合も HTTP 経由で実行時と同じ英文になる', async () => {
      const res = await diagnoseDraft({
        ...draft,
        inputSchema: { columns: [{ name: 'minimumAge', type: 'number', nullable: false }] },
        outputSchema: { columns: [{ name: 'only', type: 'string', nullable: false }] },
      });
      expect(res.statusCode).toBe(200);
      const { diagnostics } = res.json();
      expect(checkOf(diagnostics, 'agent-input')).toEqual({ id: 'agent-input', status: 'error', detail: 'tool declares inputSchema but has no agent-input node' });
      expect(checkOf(diagnostics, 'output-schema')).toMatchObject({ status: 'error' });
    });

    it('認証なしは 401、tool:execute を持たない viewer は 403、editor は 200', async () => {
      const viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
      const editor = buildServer(app, { authentication: rolesAuth(['editor']), authorization: new RoleMatrixAuthorization() });
      try {
        const unauthenticated = await viewer.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload: draft });
        expect(unauthenticated.statusCode).toBe(401);
        expect(unauthenticated.json().error.code).toBe('UNAUTHENTICATED');
        const forbidden = await viewer.inject({ method: 'POST', url: '/tool-drafts/diagnose', headers: { authorization: `Bearer ${TOKEN}` }, payload: draft });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:execute' permission" });
        const allowed = await editor.inject({ method: 'POST', url: '/tool-drafts/diagnose', headers: { authorization: `Bearer ${TOKEN}` }, payload: draft });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().diagnostics.status).toBe('ok');
      } finally {
        await viewer.close();
        await editor.close();
      }
    });

    it('認可表は POST /tool-drafts/diagnose に execute / tool を割り当てている', () => {
      expect(explicitRouteAuthorization('POST', '/tool-drafts/diagnose')).toMatchObject({ action: 'execute', kind: 'tool' });
    });
  });
});
