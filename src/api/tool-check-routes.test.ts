/**
 * /tool-checks ルートのテスト。
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で検証する。
 * Tool は POST /tools で保存したものを使う（引数バインディング付きの filter を持つ）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { SuggestToolCheckCasesUseCase } from '../application/tool-check/suggest-tool-check-cases';
import { RunToolCheckUseCase } from '../application/tool-check/run-tool-check';
import { ResolveAiJudgmentsUseCase } from '../application/tool/resolve-ai-judgments';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { explicitRouteAuthorization } from './authorization';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const TOKEN = 't'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };

const inputSchema = { columns: [
  { name: 'region', type: 'string', nullable: false },
  { name: 'minimum', type: 'number', nullable: true },
] };

function toolBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: SCOPE, internalId: 'sales', workingName: 'sales', displayName: 'Sales', publishName: 'sales_search', owner: 'owner', sideEffect: 'read-only',
    inputSchema,
    graph: {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [
          { region: 'Tokyo', amount: 120 }, { region: 'Tokyo', amount: 30 }, { region: 'Osaka', amount: 80 },
        ] } },
        { id: 'filter', type: 'filter', config: { conditions: [
          { column: 'region', op: 'eq', value: 'Osaka', valueBinding: { source: 'agent-input', field: 'region' } },
          { column: 'amount', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimum' } },
        ], combine: 'and' } },
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { region: 'Osaka', minimum: 0 } } },
      ],
      edges: [{ from: 'data', to: 'filter' }],
    },
    ...overrides,
  };
}

function caseBody(overrides: Record<string, unknown> = {}) {
  return { scope: SCOPE, toolId: 'sales', name: 'Tokyo rows', arguments: { region: 'Tokyo', minimum: 0 }, expectations: { rowCount: { op: 'eq', value: 2 } }, ...overrides };
}

/** 缶詰のモデル応答で提案ユースケースを差し替えた App（test プロファイルの既定は無効＝502）。 */
function withSuggestions(app: App, scripted: ScriptedModelProvider, enabled = true): App {
  return { ...app, suggestToolCheckCases: new SuggestToolCheckCasesUseCase(app.repo, app.engine, scripted, () => enabled, undefined, async () => ({ provider: 'scripted', model: 'canned' })) };
}

function suggestionCases() {
  return [
    { category: 'normal', name: 'Tokyo rows', rationale: 'typical', arguments: { region: 'Tokyo', minimum: '0' }, expectations: { rowCount: { op: 'eq', value: 2 } } },
    { category: 'boundary', name: 'zero minimum', rationale: 'edge', arguments: { region: 'Osaka', minimum: 0 }, expectations: { rowCount: { op: 'gte', value: 1 } } },
    { category: 'abnormal', name: 'missing region', rationale: 'required', arguments: { minimum: 0 }, expectations: { outcome: 'error' } },
  ];
}

function rolesAuth(roles: readonly AuthorizationRole[]): AuthenticationPort {
  return {
    mode: 'token', required: true,
    authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}` ? authenticated({ subject: 'rita', ...SCOPE, roles }) : rejected('missing-credentials'),
  };
}

describe('tool check routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody() })).statusCode).toBe(201);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('POST /tool-checks/run', () => {
    it('200 で結果を返す（合格・スナップショット・全行数・ノード別行数・所要時間）', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: {
        scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo', minimum: 50 },
        expectations: { rowCount: { op: 'eq', value: 1 }, columns: ['region', 'amount'], cells: [{ column: 'amount', op: 'gte', value: 100, mode: 'all' }], maxDurationMs: 60000 },
      } });
      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.status).toBe('passed');
      expect(result.tool).toEqual({ internalId: 'sales', version: '1.0.0', publishName: 'sales_search' });
      expect(result.assertions).toHaveLength(5);
      expect(result.assertions.every((assertion: { passed: boolean }) => assertion.passed)).toBe(true);
      expect(result.output.rows).toEqual([{ region: 'Tokyo', amount: 120 }]);
      expect(result.rowCount).toBe(1);
      expect(result.nodes).toEqual(expect.arrayContaining([{ nodeId: 'data', rowCount: 3 }, { nodeId: 'filter', rowCount: 1 }]));
      expect(typeof result.durationMs).toBe('number');
      expect(typeof result.checkedAt).toBe('string');
    });

    it('不合格の期待は 200 で status failed と定型文の expected / actual を返す', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo' }, expectations: { rowCount: { op: 'lte', value: 1 } } } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ status: 'failed', assertions: [{ kind: 'rowCount', passed: false, expected: 'row count <= 1', actual: 'row count 2' }] });
    });

    it('引数不正は 200 で status error（code TOOL_ARGUMENTS）— 画面が「何が起きるか」を見せる', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: { region: 42 } } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ status: 'error', error: { code: 'TOOL_ARGUMENTS', message: "invalid argument 'region': expected string, received 42 (number)" }, rowCount: 0, output: { schema: { columns: [] }, rows: [] } });
    });

    it('境界: rowLimit 0 はスナップショットを空にし rowCount は全行、version 指定は固定版を実行する', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', version: '1.0.0', arguments: { region: 'Tokyo' }, rowLimit: 0 } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ tool: { version: '1.0.0' }, rowCount: 2, output: { rows: [] } });
    });

    it('400: body の形が壊れている（フィールドのパスを含む）・version 文字列が不正', async () => {
      const bad = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: { region: { nested: true } } } });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error.code).toBe('BAD_REQUEST');
      expect(bad.json().error.message).toContain('arguments.region');
      const missing = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales' } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().error.message).toContain('arguments');
      const negative = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: {}, rowLimit: -1 } });
      expect(negative.statusCode).toBe(400);
      expect(negative.json().error.message).toContain('rowLimit');
      const version = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', version: 'latest', arguments: {} } });
      expect(version.statusCode).toBe(400);
      expect(version.json().error.message).toBe('invalid version string: "latest"');
    });

    it('404 TOOL_NOT_FOUND: 存在しない Tool・存在しない版', async () => {
      const missing = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'ghost', arguments: {} } });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toEqual({ code: 'TOOL_NOT_FOUND', message: 'tool not found: ghost' });
      const version = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', version: '9.0.0', arguments: {} } });
      expect(version.statusCode).toBe(404);
      expect(version.json().error).toEqual({ code: 'TOOL_NOT_FOUND', message: 'tool not found: sales@9.0.0' });
    });
  });

  describe('POST /tool-checks/cases（保存）', () => {
    it('200: id 省略で新規作成し、生成 id・時刻つきのケースを返す（scope は返さない）', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() });
      expect(res.statusCode).toBe(200);
      const saved = res.json().case;
      expect(saved).toMatchObject({ toolId: 'sales', name: 'Tokyo rows', arguments: { region: 'Tokyo', minimum: 0 }, expectations: { rowCount: { op: 'eq', value: 2 } } });
      expect(typeof saved.id).toBe('string');
      expect(saved.createdAt).toBe(saved.updatedAt);
      expect(saved.scope).toBeUndefined();
      expect(saved.lastResult).toBeUndefined();
    });

    it('200: id 指定で上書きし、createdAt と lastResult を引き継ぐ', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() })).json().case;
      await server.inject({ method: 'POST', url: `/tool-checks/cases/${created.id}/run`, payload: { scope: SCOPE } });
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ id: created.id, name: 'renamed', toolVersion: '1.0.0' }) });
      expect(res.statusCode).toBe(200);
      const saved = res.json().case;
      expect(saved).toMatchObject({ id: created.id, name: 'renamed', toolVersion: '1.0.0', createdAt: created.createdAt, lastResult: { status: 'passed', toolVersion: '1.0.0', summary: 'passed 1/1' } });
      expect((await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).json().cases).toHaveLength(1);
    });

    it('400 BAD_REQUEST: body の形が壊れている（フィールドのパスを含む）', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ expectations: { cells: [{ column: 'a', op: 'like', value: 1, mode: 'any' }] } }) });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('BAD_REQUEST');
      expect(res.json().error.message).toContain('expectations.cells.0.op');
    });

    it('400 TOOL_CHECK_VALIDATION: 形は正しいがドメインの不変条件（名前・版・境界）を破る', async () => {
      const blank = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: '   ' }) });
      expect(blank.statusCode).toBe(400);
      expect(blank.json().error).toEqual({ code: 'TOOL_CHECK_VALIDATION', message: 'createToolCheckCase: name must be a non-empty string' });
      const version = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ toolVersion: 'v1' }) });
      expect(version.statusCode).toBe(400);
      expect(version.json().error.code).toBe('TOOL_CHECK_VALIDATION');
      const duration = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ expectations: { maxDurationMs: 600001 } }) });
      expect(duration.statusCode).toBe(400);
      expect(duration.json().error.message).toBe('createToolCheckCase: expectations.maxDurationMs must be a positive integer up to 600000');
    });

    it('404 TOOL_NOT_FOUND: 存在しない Tool のケースは保存できない', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ toolId: 'ghost' }) });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toEqual({ code: 'TOOL_NOT_FOUND', message: 'tool not found: ghost' });
    });
  });

  describe('GET /tool-checks/cases', () => {
    it('200: 新しい定義が先、toolId で絞り込める、無ければ空', async () => {
      expect((await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).json()).toEqual({ cases: [] });
      expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody({ internalId: 'inventory', publishName: 'inventory' }) })).statusCode).toBe(201);
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: 'first' }) });
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: 'second', toolId: 'inventory' }) });
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: 'third' }) });

      const all = await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE });
      expect(all.statusCode).toBe(200);
      const names = all.json().cases.map((item: { name: string; updatedAt: string }) => item.name);
      expect(names).toHaveLength(3);
      // updatedAt が同一ミリ秒に並ぶことがあるため、順序は時刻で確認する。
      const stamps = all.json().cases.map((item: { updatedAt: string }) => item.updatedAt);
      expect([...stamps].sort().reverse()).toEqual(stamps);
      const filtered = await server.inject({ method: 'GET', url: '/tool-checks/cases', query: { ...SCOPE, toolId: 'inventory' } });
      expect(filtered.json().cases.map((item: { name: string }) => item.name)).toEqual(['second']);
      expect((await server.inject({ method: 'GET', url: '/tool-checks/cases', query: { ...SCOPE, toolId: 'none' } })).json()).toEqual({ cases: [] });
    });

    it('400: toolId が空文字', async () => {
      const res = await server.inject({ method: 'GET', url: '/tool-checks/cases', query: { ...SCOPE, toolId: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('toolId');
    });
  });

  describe('DELETE /tool-checks/cases/:id', () => {
    it('204 で消え、一覧から無くなる', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() })).json().case;
      const res = await server.inject({ method: 'DELETE', url: `/tool-checks/cases/${created.id}`, query: SCOPE });
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
      expect((await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).json()).toEqual({ cases: [] });
    });

    it('404 TOOL_CHECK_NOT_FOUND: 未知の id・二度目の削除', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() })).json().case;
      const missing = await server.inject({ method: 'DELETE', url: '/tool-checks/cases/missing', query: SCOPE });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().error).toEqual({ code: 'TOOL_CHECK_NOT_FOUND', message: 'tool check case not found: missing' });
      await server.inject({ method: 'DELETE', url: `/tool-checks/cases/${created.id}`, query: SCOPE });
      expect((await server.inject({ method: 'DELETE', url: `/tool-checks/cases/${created.id}`, query: SCOPE })).statusCode).toBe(404);
    });
  });

  describe('POST /tool-checks/cases/:id/run', () => {
    it('200: 実行結果と lastResult 更新済みのケースを返し、更新は永続化される', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ expectations: { rowCount: { op: 'eq', value: 3 } } }) })).json().case;
      const res = await server.inject({ method: 'POST', url: `/tool-checks/cases/${created.id}/run`, payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      const { case: updated, result } = res.json();
      expect(result.status).toBe('failed');
      expect(updated.lastResult).toEqual({ status: 'failed', checkedAt: result.checkedAt, toolVersion: '1.0.0', summary: 'failed 1/1: row count == 3 → row count 2' });
      expect(updated.updatedAt).toBe(created.updatedAt);
      const listed = (await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).json().cases[0];
      expect(listed.lastResult).toEqual(updated.lastResult);
    });

    it('200 status error: 引数が Tool の inputSchema と合わなくなったケース', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ arguments: { region: 'Tokyo', extra: 1 } }) })).json().case;
      const res = await server.inject({ method: 'POST', url: `/tool-checks/cases/${created.id}/run`, payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ status: 'error', error: { code: 'TOOL_ARGUMENTS', message: 'unknown argument(s): extra' } });
      expect(res.json().case.lastResult).toMatchObject({ status: 'error', summary: 'error: unknown argument(s): extra' });
    });

    it('404 TOOL_CHECK_NOT_FOUND: 未知の id', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases/missing/run', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('TOOL_CHECK_NOT_FOUND');
    });

    it('400: body に scope オブジェクトが無い', async () => {
      const created = (await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() })).json().case;
      const res = await server.inject({ method: 'POST', url: `/tool-checks/cases/${created.id}/run`, payload: { scope: 'nope' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('scope');
    });
  });

  describe('POST /tool-checks/cases/run-all', () => {
    it('200: 全ケースを逐次実行し、error のケースがあっても残りの結果を返す', async () => {
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: 'ok' }) });
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ name: 'bad', arguments: {} }) });
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases/run-all', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      const results = res.json().results;
      expect(results).toHaveLength(2);
      const byName = new Map(results.map((run: { case: { name: string }; result: { status: string } }) => [run.case.name, run.result.status]));
      expect(byName.get('ok')).toBe('passed');
      expect(byName.get('bad')).toBe('error');
      expect(results.every((run: { case: { lastResult?: unknown } }) => run.case.lastResult !== undefined)).toBe(true);
    });

    it('200: toolId で絞る・ケースが無ければ空配列', async () => {
      expect((await server.inject({ method: 'POST', url: '/tool-checks/cases/run-all', payload: { scope: SCOPE } })).json()).toEqual({ results: [] });
      await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody() });
      const filtered = await server.inject({ method: 'POST', url: '/tool-checks/cases/run-all', payload: { scope: SCOPE, toolId: 'other' } });
      expect(filtered.statusCode).toBe(200);
      expect(filtered.json()).toEqual({ results: [] });
    });

    it('400: toolId が空文字', async () => {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/cases/run-all', payload: { scope: SCOPE, toolId: '' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('toolId');
    });
  });
});

describe('POST /tool-checks/suggest', () => {
  let app: App;
  let scripted: ScriptedModelProvider;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    scripted = new ScriptedModelProvider();
    server = buildServer(withSuggestions(app, scripted), { authentication: new SingleUserAuthentication(SCOPE) });
    expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody() })).statusCode).toBe(201);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('200: 提案（引数の修復・期待・モデル情報・警告）を返し、ケースは保存されない', async () => {
    scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify({ cases: suggestionCases() }) }, finishReason: 'stop' });
    const res = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', perCategory: 1, focus: 'edges' } });
    expect(res.statusCode).toBe(200);
    const { suggestions } = res.json();
    expect(suggestions.tool).toEqual({ internalId: 'sales', version: '1.0.0', publishName: 'sales_search' });
    expect(suggestions.model).toEqual({ provider: 'scripted', model: 'canned' });
    expect(suggestions.warnings).toEqual([]);
    expect(suggestions.suggestions).toHaveLength(3);
    expect(suggestions.suggestions[0]).toEqual({ category: 'normal', name: 'Tokyo rows', rationale: 'typical', arguments: { region: 'Tokyo', minimum: 0 }, expectations: { rowCount: { op: 'eq', value: 2 } }, warnings: ["argument 'minimum' was \"0\" (string); converted to number 0"] });
    expect(suggestions.suggestions[2]).toMatchObject({ category: 'abnormal', arguments: { minimum: 0 }, expectations: { outcome: 'error' } });
    expect(JSON.parse(scripted.requests[0]?.messages[1]?.content as string)).toMatchObject({ perCategory: 1, focus: 'edges', sampleRun: { rowCount: 1 } });
    expect((await server.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).json().cases).toEqual([]);
  });

  it('200: 提案した異常系ケースは /tool-checks/run でそのまま実行でき、失敗が合格になる', async () => {
    scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify({ cases: suggestionCases() }) }, finishReason: 'stop' });
    const suggested = (await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales' } })).json().suggestions.suggestions[2];
    const run = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: suggested.arguments, expectations: suggested.expectations } });
    expect(run.statusCode).toBe(200);
    expect(run.json().result).toMatchObject({ status: 'passed', assertions: [{ kind: 'outcome', passed: true, expected: 'outcome error', actual: 'outcome error (TOOL_ARGUMENTS)' }], error: { code: 'TOOL_ARGUMENTS' } });
  });

  it('境界: perCategory は 1 と 5 を受理し、0・6・小数・focus 501 文字は 400', async () => {
    for (const perCategory of [1, 5]) {
      scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify({ cases: suggestionCases() }) }, finishReason: 'stop' });
      expect((await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', perCategory } })).statusCode).toBe(200);
    }
    for (const perCategory of [0, 6, 1.5]) {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', perCategory } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('perCategory');
    }
    const focus = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', focus: 'x'.repeat(501) } });
    expect(focus.statusCode).toBe(400);
    expect(focus.json().error.message).toContain('focus');
    expect(scripted.requests).toHaveLength(2);
  });

  it('400: body の形が壊れている（toolId 空・scope 無し）・version 文字列が不正', async () => {
    expect((await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: '' } })).statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { toolId: 'sales' } })).statusCode).toBe(400);
    const version = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', version: 'latest' } });
    expect(version.statusCode).toBe(400);
    expect(version.json().error.message).toBe('invalid version string: "latest"');
  });

  it('404 TOOL_NOT_FOUND: 存在しない Tool・存在しない版（モデルは呼ばれない）', async () => {
    const missing = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'nope' } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toEqual({ code: 'TOOL_NOT_FOUND', message: 'tool not found: nope' });
    expect((await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales', version: '9.9.9' } })).statusCode).toBe(404);
    expect(scripted.requests).toHaveLength(0);
  });

  it('502 MODEL_PROVIDER: モデルが JSON でない応答・使えるケース 0 件を返す', async () => {
    scripted.enqueue({ message: { role: 'assistant', content: 'not json' }, finishReason: 'stop' });
    const garbage = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales' } });
    expect(garbage.statusCode).toBe(502);
    expect(garbage.json().error).toEqual({ code: 'MODEL_PROVIDER', message: 'tool check suggestions returned invalid JSON' });
    scripted.enqueue({ message: { role: 'assistant', content: '{"cases":[]}' }, finishReason: 'stop' });
    const empty = await server.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'sales' } });
    expect(empty.statusCode).toBe(502);
    expect(empty.json().error.message).toBe('tool check suggestions returned no usable case');
  });

  it('502 MODEL_PROVIDER: 提案が無効（test プロファイル既定）・モデルが structured-output 非対応なら未設定として返し、Tool を読まない', async () => {
    const disabled = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    const chatOnly = buildServer(withSuggestions(app, Object.assign(new ScriptedModelProvider(), { capabilities: () => ['chat'] as const })), { authentication: new SingleUserAuthentication(SCOPE) });
    try {
      for (const target of [disabled, chatOnly]) {
        const res = await target.inject({ method: 'POST', url: '/tool-checks/suggest', payload: { scope: SCOPE, toolId: 'missing-too' } });
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toEqual({ code: 'MODEL_PROVIDER', message: 'tool check suggestions are not configured' });
      }
    } finally {
      await disabled.close();
      await chatOnly.close();
    }
  });
});

describe('tool check routes: 認可', () => {
  let app: App;
  let editor: FastifyInstance;
  let viewer: FastifyInstance;
  let caseId: string;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    editor = buildServer(app, { authentication: rolesAuth(['editor']), authorization: new RoleMatrixAuthorization() });
    viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
    expect((await editor.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody() })).statusCode).toBe(201);
    const created = await editor.inject({ method: 'POST', url: '/tool-checks/cases', headers: auth, payload: caseBody() });
    expect(created.statusCode).toBe(200);
    caseId = created.json().case.id;
  });

  afterEach(async () => {
    await editor.close();
    await viewer.close();
    app.close();
  });

  it('viewer はケース一覧を読めるが、実行・保存・削除は 403（必要な権限だけを伝える）', async () => {
    expect((await viewer.inject({ method: 'GET', url: '/tool-checks/cases', headers: auth, query: SCOPE })).statusCode).toBe(200);
    const run = await viewer.inject({ method: 'POST', url: '/tool-checks/run', headers: auth, payload: { scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo' } } });
    expect(run.statusCode).toBe(403);
    expect(run.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:execute' permission" });
    expect((await viewer.inject({ method: 'POST', url: `/tool-checks/cases/${caseId}/run`, headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    expect((await viewer.inject({ method: 'POST', url: '/tool-checks/cases/run-all', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    const suggest = await viewer.inject({ method: 'POST', url: '/tool-checks/suggest', headers: auth, payload: { scope: SCOPE, toolId: 'sales' } });
    expect(suggest.statusCode).toBe(403);
    expect(suggest.json().error.message).toBe("this operation requires the 'tool:execute' permission");
    const save = await viewer.inject({ method: 'POST', url: '/tool-checks/cases', headers: auth, payload: caseBody() });
    expect(save.statusCode).toBe(403);
    expect(save.json().error.message).toBe("this operation requires the 'tool:edit' permission");
    expect((await viewer.inject({ method: 'DELETE', url: `/tool-checks/cases/${caseId}`, headers: auth, query: SCOPE })).statusCode).toBe(403);
    // 拒否された削除は起きていない。
    expect((await editor.inject({ method: 'GET', url: '/tool-checks/cases', headers: auth, query: SCOPE })).json().cases).toHaveLength(1);
  });

  it('認可表は POST /tool-checks/suggest に execute / tool を割り当てている（editor は 403 にならず、モデル未設定の 502 まで進む）', async () => {
    expect(explicitRouteAuthorization('POST', '/tool-checks/suggest')).toMatchObject({ action: 'execute', kind: 'tool' });
    expect((await editor.inject({ method: 'POST', url: '/tool-checks/suggest', headers: auth, payload: { scope: SCOPE, toolId: 'sales' } })).statusCode).toBe(502);
  });

  it('editor は実行・保存・削除ができる', async () => {
    expect((await editor.inject({ method: 'POST', url: '/tool-checks/run', headers: auth, payload: { scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo' } } })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'POST', url: `/tool-checks/cases/${caseId}/run`, headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'POST', url: '/tool-checks/cases/run-all', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(200);
    expect((await editor.inject({ method: 'DELETE', url: `/tool-checks/cases/${caseId}`, headers: auth, query: SCOPE })).statusCode).toBe(204);
  });

  it('認証されていない要求は 401', async () => {
    expect((await editor.inject({ method: 'GET', url: '/tool-checks/cases', query: SCOPE })).statusCode).toBe(401);
  });
});

/** `json-source → ai-judge(keep yes)` の Tool（判定で行が落ちるので終端と判定の両方を検証できる）。 */
function judgeToolBody(overrides: Record<string, unknown> = {}) {
  return toolBody({
    internalId: 'expenses', workingName: 'expenses', displayName: 'Expenses', publishName: 'expense_check',
    graph: {
      nodes: [
        { id: 'data', type: 'json-source', config: { rows: [{ id: 'E1', amount: 12000 }, { id: 'E2', amount: 500 }] } },
        { id: 'judge', type: 'ai-judge', config: { question: 'これは経費として妥当ですか？', action: 'keep', matchValues: ['yes'] } },
        { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { region: 'Osaka', minimum: 0 } } },
      ],
      edges: [{ from: 'data', to: 'judge' }],
    },
    ...overrides,
  });
}

/** 缶詰のモデル応答で AI 判定を解く RunToolCheckUseCase に差し替えた App（test プロファイルの既定は未設定）。 */
function withJudgments(app: App, scripted: ScriptedModelProvider): App {
  const resolver = new ResolveAiJudgmentsUseCase(app.engine, scripted, () => true, { snapshot: async () => ({ provider: 'scripted', model: 'canned' }) });
  return { ...app, runToolCheck: new RunToolCheckUseCase(app.repo, app.engine, undefined, {}, resolver) };
}

const CANNED_VERDICTS = { verdicts: [{ id: 'r1', answer: 'yes', reason: '規程の範囲内' }, { id: 'r2', answer: 'no', reason: '領収書が無い' }] };

describe('tool check routes: rows / judgments の期待', () => {
  let app: App;
  let scripted: ScriptedModelProvider;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    scripted = new ScriptedModelProvider();
    server = buildServer(withJudgments(app, scripted), { authentication: new SingleUserAuthentication(SCOPE) });
    expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody() })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/tools', payload: judgeToolBody() })).statusCode).toBe(201);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('200: rows の期待（存在・不在・セル）を受け取り、定型文の expected / actual を返す', async () => {
    const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: {
      scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo' },
      expectations: { rows: [
        { where: { column: 'region', value: 'Tokyo' }, cells: [{ column: 'amount', op: 'gte', value: 100 }] },
        { where: { column: 'region', value: 'Osaka' }, present: false },
      ] },
    } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ status: 'passed', assertions: [
      { kind: 'row', passed: true, expected: 'row[region == "Tokyo"].amount >= 100', actual: '120' },
      { kind: 'row', passed: true, expected: 'row[region == "Osaka"] absent', actual: 'absent' },
    ] });
  });

  it('200: ai-judge を持つ Tool では判定表（judgments）と判定モデル（judgedBy）を返す', async () => {
    scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify(CANNED_VERDICTS) }, finishReason: 'stop' });
    const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: {
      scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' },
      expectations: {
        rows: [{ where: { column: 'id', value: 'E2' }, present: false }],
        judgments: [
          { nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] },
          { nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no'], reasonContains: '領収書' },
        ],
      },
    } });
    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.status).toBe('passed');
    expect(result.assertions).toEqual([
      { kind: 'row', passed: true, expected: 'row[id == "E2"] absent', actual: 'absent' },
      { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E1"] in ["yes"]', actual: 'yes (規程の範囲内)' },
      { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E2"] in ["no"]', actual: 'no (領収書が無い)' },
      { kind: 'judgment', passed: true, expected: 'judgment[judge][id == "E2"] reason contains "領収書"', actual: '"領収書が無い"' },
    ]);
    expect(result.rowCount).toBe(1);
    expect(result.judgedBy).toBe('scripted/canned');
    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]).toMatchObject({ nodeId: 'judge', verdictColumn: 'aiVerdict', reasonColumn: 'aiReason', rowCount: 2 });
    expect(result.judgments[0].table.rows).toEqual([
      { id: 'E1', amount: 12000, aiVerdict: 'yes', aiReason: '規程の範囲内' },
      { id: 'E2', amount: 500, aiVerdict: 'no', aiReason: '領収書が無い' },
    ]);
  });

  it('200 failed: 判定が期待と違えば不合格（判定表は返したまま）', async () => {
    scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify(CANNED_VERDICTS) }, finishReason: 'stop' });
    const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: {
      scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' },
      expectations: { judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['yes'] }] },
    } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({
      status: 'failed',
      assertions: [{ kind: 'judgment', passed: false, expected: 'judgment[judge][id == "E2"] in ["yes"]', actual: 'no (領収書が無い)' }],
      judgments: [{ nodeId: 'judge', rowCount: 2 }],
    });
  });

  it('200: ai-judge を持たない Tool の結果には judgments / judgedBy が現れない', async () => {
    const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'sales', arguments: { region: 'Tokyo' } } });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.judgments).toBeUndefined();
    expect(res.json().result.judgedBy).toBeUndefined();
  });

  it('200: ケースにも rows / judgments を保存でき、一覧で往復する', async () => {
    const expectations = {
      rows: [{ where: { column: 'id', value: 'E1' }, present: true, cells: [{ column: 'amount', op: 'gte', value: 10000 }] }],
      judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E2' }, verdict: ['no', 'unclear'], reasonContains: '領収書' }],
    };
    const saved = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ toolId: 'expenses', expectations }) });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().case.expectations).toEqual(expectations);
    const listed = (await server.inject({ method: 'GET', url: '/tool-checks/cases', query: { ...SCOPE, toolId: 'expenses' } })).json().cases[0];
    expect(listed.expectations).toEqual(expectations);
  });

  it('400 BAD_REQUEST: rows / judgments の形が壊れている（フィールドのパスを含む）', async () => {
    const cases: readonly [unknown, string][] = [
      [{ rows: [{ present: true }] }, 'expectations.rows.0.where'],
      [{ rows: [{ where: { column: 'id', value: 'E1' }, present: 'no' }] }, 'expectations.rows.0.present'],
      [{ rows: [{ where: { column: 'id', value: 'E1' }, cells: [{ column: 'amount', op: 'like', value: 1 }] }] }, 'expectations.rows.0.cells.0.op'],
      [{ judgments: [{ where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] }, 'expectations.judgments.0.nodeId'],
      [{ judgments: [{ nodeId: '', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] }, 'expectations.judgments.0.nodeId'],
      [{ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: [] }] }, 'expectations.judgments.0.verdict'],
      [{ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'], reasonContains: '' }] }, 'expectations.judgments.0.reasonContains'],
    ];
    for (const [expectations, path] of cases) {
      const run = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' }, expectations } });
      expect(run.statusCode).toBe(400);
      expect(run.json().error.code).toBe('BAD_REQUEST');
      expect(run.json().error.message).toContain(path);
      const save = await server.inject({ method: 'POST', url: '/tool-checks/cases', payload: caseBody({ toolId: 'expenses', expectations }) });
      expect(save.statusCode).toBe(400);
      expect(save.json().error.message).toContain(path);
    }
  });

  it('400 BAD_REQUEST: 上限超え（rows 51 件・judgments 101 件・verdict 22 件）はスキーマで弾く', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => ({ where: { column: 'id', value: `E${index}` } }));
    const judgments = Array.from({ length: 101 }, (_, index) => ({ nodeId: 'judge', where: { column: 'id', value: `E${index}` }, verdict: ['yes'] }));
    const verdict = Array.from({ length: 22 }, (_, index) => `v${index}`);
    const over: readonly [Record<string, unknown>, string][] = [
      [{ rows }, 'expectations.rows'],
      [{ judgments }, 'expectations.judgments'],
      [{ judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict }] }, 'expectations.judgments.0.verdict'],
    ];
    for (const [expectations, path] of over) {
      const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' }, expectations } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain(path);
    }
    // 境界: 上限ちょうどは受理する（rows 50 件）。
    scripted.enqueue({ message: { role: 'assistant', content: JSON.stringify(CANNED_VERDICTS) }, finishReason: 'stop' });
    const atLimit = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: { scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' }, expectations: { rows: rows.slice(0, 50) } } });
    expect(atLimit.statusCode).toBe(200);
  });
});

describe('tool check routes: AI 判定のモデルが未設定（test プロファイルの既定）', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    expect((await server.inject({ method: 'POST', url: '/tools', payload: judgeToolBody() })).statusCode).toBe(201);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  it('200 status error: 判定を解けないまま実行せず、設定への導線つきの ETL_CONFIG を返す', async () => {
    const res = await server.inject({ method: 'POST', url: '/tool-checks/run', payload: {
      scope: SCOPE, toolId: 'expenses', arguments: { region: 'Tokyo' },
      expectations: { judgments: [{ nodeId: 'judge', where: { column: 'id', value: 'E1' }, verdict: ['yes'] }] },
    } });
    expect(res.statusCode).toBe(200);
    const { result } = res.json();
    expect(result.status).toBe('error');
    expect(result.error).toMatchObject({ code: 'ETL_CONFIG', nodeId: 'judge' });
    expect(result.error.message).toContain('the model is not configured');
    expect(result.judgments).toBeUndefined();
  });
});
