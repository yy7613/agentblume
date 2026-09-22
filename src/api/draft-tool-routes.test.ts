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
      // v46: 実行上限超過のエラー文に直し方（上流で絞るか AGENTCONTEXT_MAX_EXECUTION_ROWS を上げる）が付いた。
      message: 'json-source: produced 250001 rows, exceeding the execution limit of 250000 rows; narrow the data upstream, or raise AGENTCONTEXT_MAX_EXECUTION_ROWS on the server',
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

  describe('GET /runtime/capabilities', () => {
    it('test プロファイルでは分析アシスタントもツール検証の提案も業務の LLM 機能も無効（false）、judge は scripted で設定済み', async () => {
      const response = await server.inject({ method: 'GET', url: '/runtime/capabilities' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        analysisAssistant: { enabled: false }, calculateAssistant: { enabled: false }, designAssistant: { enabled: false }, toolCheckSuggestions: { enabled: false }, aiJudge: { enabled: false }, judge: { configured: true, provider: 'scripted-judge', model: 'scripted-judge' },
        journal: { extraction: { enabled: false, vision: false }, hearing: { enabled: false } },
        expense: { extraction: { enabled: false, vision: false }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } },
        receivables: { invoiceDraft: { enabled: false, vision: false } },
        contract: { extraction: { enabled: false, vision: false }, review: { llm: false } },
      });
    });

    it('提案ユースケースが利用可能なら toolCheckSuggestions.enabled が true になる（analysisAssistant とは独立）', async () => {
      const enabled = buildServer({ ...app, suggestToolCheckCases: { available: async () => true } as App['suggestToolCheckCases'] });
      try {
        expect((await enabled.inject({ method: 'GET', url: '/runtime/capabilities' })).json()).toMatchObject({ analysisAssistant: { enabled: false }, toolCheckSuggestions: { enabled: true } });
      } finally {
        await enabled.close();
      }
    });

    it('judge が未設定なら judge.configured=false で provider / model は返さない（実験画面が起票前に未設定を示す）', async () => {
      const unconfigured = buildServer({ ...app, judgeReadiness: async () => ({ configured: false }) });
      try {
        expect((await unconfigured.inject({ method: 'GET', url: '/runtime/capabilities' })).json().judge).toEqual({ configured: false });
      } finally {
        await unconfigured.close();
      }
    });

    it('judge の設定状態は毎回解決する（切替直後のリクエストから新しい設定が見える）', async () => {
      let calls = 0;
      const switching = buildServer({ ...app, judgeReadiness: async () => { calls += 1; return calls === 1 ? { configured: false } : { configured: true, provider: 'openai', model: 'gpt-4o' }; } });
      try {
        expect((await switching.inject({ method: 'GET', url: '/runtime/capabilities' })).json().judge).toEqual({ configured: false });
        expect((await switching.inject({ method: 'GET', url: '/runtime/capabilities' })).json().judge).toEqual({ configured: true, provider: 'openai', model: 'gpt-4o' });
      } finally {
        await switching.close();
      }
    });
  });

  describe('POST /tool-drafts/suggest-calculate-expression', () => {
    const SCOPE = { tenantId: 't', workspaceId: 'w' };
    const TOKEN = 'r'.repeat(40);
    const calcGraph = {
      nodes: [
        { id: 'source', type: 'json-source', config: { rows: [{ price: 100, quantity: 2 }] } },
        { id: 'calc', type: 'calculate', config: { outputColumn: 'total', expression: '[price]' } },
      ],
      edges: [{ from: 'source', to: 'calc' }],
    };
    const body = { graph: calcGraph, nodeId: 'calc', intent: '単価×数量' };
    /** 提案だけを返すフェイク（この経路が返す形を固定する。モデルの検分は応用層のテストで見る）。 */
    const stub = (proposal: unknown): App['suggestCalculateExpression'] => ({
      available: async () => true,
      execute: async () => proposal,
    } as unknown as App['suggestCalculateExpression']);

    it('正常: 200 で検分済みの提案を返す（式・出力列・プレビュー要約つき）', async () => {
      const stubbed = buildServer({ ...app, suggestCalculateExpression: stub({
        nodeId: 'calc', nodeType: 'calculate', config: { outputColumn: 'total', expression: '[price] * [quantity]' },
        rationale: ['単価と数量の積。'], warnings: [], validation: { references: ['price', 'quantity'], diagnostics: [] },
        preview: { rows: 1, evaluated: 1, failed: 0, failureCounts: {}, sample: [] }, repaired: false, promptTemplateVersion: 'calculate-expression/v2',
      }) });
      try {
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/suggest-calculate-expression', payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.json().proposal.config.expression).toBe('[price] * [quantity]');
        expect(response.json().proposal).toMatchObject({ repaired: false, preview: { evaluated: 1 } });
      } finally {
        await stubbed.close();
      }
    });

    it('異常: intent が空なら 400 BAD_REQUEST', async () => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/suggest-calculate-expression', payload: { ...body, intent: '' } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });

    it('異常: 無効（モデル未設定）なら 502 MODEL_PROVIDER（既存の error-mapping に乗る）', async () => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/suggest-calculate-expression', payload: body });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatchObject({ code: 'MODEL_PROVIDER', message: expect.stringContaining('not configured') });
    });

    it('異常: tool:edit を持たない viewer は 403（認可表は edit / tool を割り当てている）', async () => {
      const rolesAuth = (roles: readonly AuthorizationRole[]): AuthenticationPort => ({
        mode: 'token', required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', ...SCOPE, roles })
          : rejected('missing-credentials'),
      });
      const viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
      try {
        const forbidden = await viewer.inject({ method: 'POST', url: '/tool-drafts/suggest-calculate-expression', headers: { authorization: `Bearer ${TOKEN}` }, payload: body });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:edit' permission" });
      } finally {
        await viewer.close();
      }
      expect(explicitRouteAuthorization('POST', '/tool-drafts/suggest-calculate-expression')).toMatchObject({ action: 'edit', kind: 'tool' });
    });
  });

  describe('POST /tool-drafts/design-chat', () => {
    const SCOPE = { tenantId: 't', workspaceId: 'w' };
    const TOKEN = 'r'.repeat(40);
    const body = { graph, instruction: '18 歳以上だけにして' };
    /** 設計アシスタント 1 ターンの返り値を固定するフェイク（検分の中身は応用層のテストで見る）。 */
    const stub = (result: unknown): App['designToolChat'] => ({
      available: async () => true,
      execute: async () => result,
    } as unknown as App['designToolChat']);

    it('正常: 200 で説明・編集後のグラフ・変更一覧をそのまま返す（保存はしない）', async () => {
      const edited = { nodes: [...graph.nodes, { id: 'lim', type: 'limit', config: { count: 10 } }], edges: [...graph.edges, { from: 'adult', to: 'lim' }] };
      const stubbed = buildServer({ ...app, designToolChat: stub({
        message: '10 件に絞りました。',
        graph: edited,
        changes: [{ op: 'add-node', nodeId: 'lim', summary: "added limit 'lim' after 'adult' with count=10" }],
        repaired: false,
        problems: [],
        promptTemplateVersion: 'design-chat/v2',
      }) });
      try {
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          message: '10 件に絞りました。',
          changes: [{ op: 'add-node', nodeId: 'lim', summary: "added limit 'lim' after 'adult' with count=10" }],
          repaired: false,
          problems: [],
        });
        expect(response.json().graph.nodes).toHaveLength(3);
        await expect(app.repo.listVersions(SCOPE, 'draft')).resolves.toEqual([]);
      } finally {
        await stubbed.close();
      }
    });

    it('正常: 適用できなかったターンも 200（graph 無し・problems つき。アシスタントの応答であって API の失敗ではない）', async () => {
      const stubbed = buildServer({ ...app, designToolChat: stub({
        message: '列が見つかりませんでした。', changes: [], repaired: true,
        problems: ["node 'adult': filter: column not found: ages"], promptTemplateVersion: 'design-chat/v2',
      }) });
      try {
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.json()).not.toHaveProperty('graph');
        expect(response.json()).toMatchObject({ repaired: true, problems: ["node 'adult': filter: column not found: ages"] });
      } finally {
        await stubbed.close();
      }
    });

    it('正常: 会話と引数の宣言はそのままユースケースへ渡る（切り詰めは応用層の仕事）', async () => {
      let received: Record<string, unknown> | undefined;
      const capturing = {
        available: async () => true,
        execute: async (input: Record<string, unknown>) => {
          received = input;
          return { message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' };
        },
      } as unknown as App['designToolChat'];
      const stubbed = buildServer({ ...app, designToolChat: capturing });
      try {
        const transcript = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 === 0 ? 'user' : 'assistant', content: `t${index}` }));
        const inputSchema = { columns: [{ name: 'region', type: 'string', nullable: true }] };
        // body の scope は無視し、認証済み principal のスコープで実行する（既存のルートと同じ規律）。
        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, scope: { tenantId: 'other', workspaceId: 'other' }, transcript, inputSchema } });
        expect(received).toMatchObject({ scope: { tenantId: 'local', workspaceId: 'default' }, instruction: '18 歳以上だけにして', inputSchema });
        expect((received?.['transcript'] as unknown[]).length).toBe(20);
      } finally {
        await stubbed.close();
      }
    });

    it('正常: inputSchema を送らなければ渡さない（グラフの agent-input から読ませる）', async () => {
      let received: Record<string, unknown> | undefined;
      const stubbed = buildServer({ ...app, designToolChat: {
        available: async () => true,
        execute: async (input: Record<string, unknown>) => { received = input; return { message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' }; },
      } as unknown as App['designToolChat'] });
      try {
        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
        expect(received).not.toHaveProperty('inputSchema');
        expect(received?.['transcript']).toEqual([]);
      } finally {
        await stubbed.close();
      }
    });

    it.each([
      ['instruction が空', { graph, instruction: '' }],
      ['graph が無い', { instruction: '直して' }],
      ['transcript が 41 ターン', { graph, instruction: '直して', transcript: Array.from({ length: 41 }, () => ({ role: 'user', content: 'x' })) }],
      ['transcript の role が語彙外', { graph, instruction: '直して', transcript: [{ role: 'system', content: 'x' }] }],
    ])('異常: %s の body は 400 BAD_REQUEST', async (_name, payload) => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });

    it('境界: instruction は 2000 文字まで通り、2001 文字は 400', async () => {
      const stubbed = buildServer({ ...app, designToolChat: stub({ message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' }) });
      try {
        expect((await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { graph, instruction: 'あ'.repeat(2_000) } })).statusCode).toBe(200);
        expect((await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { graph, instruction: 'あ'.repeat(2_001) } })).statusCode).toBe(400);
      } finally {
        await stubbed.close();
      }
    });

    it('異常: モデル未設定なら 502 MODEL_PROVIDER（関数電卓アシスタントと同じ経路）', async () => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatchObject({ code: 'MODEL_PROVIDER', message: expect.stringContaining('not configured') });
    });

    it('異常: tool:execute を持たない viewer は 403（設計時プレビューでデータを読むため preview と同じ権限）', async () => {
      const rolesAuth = (roles: readonly AuthorizationRole[]): AuthenticationPort => ({
        mode: 'token', required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', ...SCOPE, roles })
          : rejected('missing-credentials'),
      });
      const viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
      try {
        const forbidden = await viewer.inject({ method: 'POST', url: '/tool-drafts/design-chat', headers: { authorization: `Bearer ${TOKEN}` }, payload: body });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:execute' permission" });
      } finally {
        await viewer.close();
      }
      expect(explicitRouteAuthorization('POST', '/tool-drafts/design-chat')).toMatchObject({ action: 'execute', kind: 'tool' });
    });

    it('正常: いまの Tool Calling 契約と畳んだ会話はそのままユースケースへ渡る（v49 §3.2）', async () => {
      let received: Record<string, unknown> | undefined;
      const stubbed = buildServer({ ...app, designToolChat: {
        available: async () => true,
        execute: async (input: Record<string, unknown>) => { received = input; return { message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' }; },
      } as unknown as App['designToolChat'] });
      try {
        const agentTool = { name: 'population_top', description: '都道府県別の総人口を返す。' };
        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, agentTool, transcriptSummary: '- 全国は除く' } });
        expect(received).toMatchObject({ agentTool, transcriptSummary: '- 全国は除く' });

        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
        expect(received).not.toHaveProperty('agentTool');
        expect(received).not.toHaveProperty('transcriptSummary');
      } finally {
        await stubbed.close();
      }
    });

    it('正常: 更新後の契約と消費はそのまま応答に載る（画面がメタデータとメーターへ反映する）', async () => {
      const stubbed = buildServer({ ...app, designToolChat: stub({
        message: '説明文を更新しました。',
        agentTool: { name: 'population_top', description: '新しい説明' },
        changes: [{ op: 'set-agent-tool', nodeId: 'agent-tool', summary: 'set the tool description for the agent (新しい説明)' }],
        repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2',
        usage: { promptTokens: 6_812, completionTokens: 240, contextWindow: 200_192 },
      }) });
      try {
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          agentTool: { name: 'population_top', description: '新しい説明' },
          usage: { promptTokens: 6_812, completionTokens: 240, contextWindow: 200_192 },
          changes: [{ op: 'set-agent-tool', nodeId: 'agent-tool' }],
        });
      } finally {
        await stubbed.close();
      }
    });

    it.each([
      ['transcriptSummary が 4,001 字', { transcriptSummary: 'あ'.repeat(4_001) }],
      ['agentTool.description が 4,001 字', { agentTool: { description: 'あ'.repeat(4_001) } }],
      ['agentTool.name が 65 字', { agentTool: { name: 'x'.repeat(65) } }],
    ])('異常: %s の body は 400 BAD_REQUEST', async (_name, extra) => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, ...extra } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });

    it('境界: 要求の agentTool は空文字を含んでも 200（いまのメタデータをそのまま渡すだけで、検証の対象ではない）', async () => {
      let received: Record<string, unknown> | undefined;
      const stubbed = buildServer({ ...app, designToolChat: {
        available: async () => true,
        execute: async (input: Record<string, unknown>) => { received = input; return { message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' }; },
      } as unknown as App['designToolChat'] });
      try {
        // 説明文の 1〜4,000 字・名前の形は、**モデルの set-agent-tool 操作**に掛ける検査（応用層）。
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, agentTool: { name: 'population_top', description: '' } } });
        expect(response.statusCode).toBe(200);
        expect(received?.['agentTool']).toEqual({ name: 'population_top', description: '' });
        expect((await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, agentTool: { name: '', description: '' } } })).statusCode).toBe(200);
      } finally {
        await stubbed.close();
      }
    });

    it('境界: transcriptSummary は 4,000 字まで通る', async () => {
      const stubbed = buildServer({ ...app, designToolChat: stub({ message: 'ok', changes: [], repaired: false, problems: [], promptTemplateVersion: 'design-chat/v2' }) });
      try {
        const response = await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat', payload: { ...body, transcriptSummary: 'あ'.repeat(4_000) } });
        expect(response.statusCode).toBe(200);
      } finally {
        await stubbed.close();
      }
    });

    it('正常: designAssistant の有効判定は毎回ユースケースへ問い合わせる', async () => {
      const enabled = buildServer({ ...app, designToolChat: { available: async () => true } as App['designToolChat'] });
      try {
        expect((await enabled.inject({ method: 'GET', url: '/runtime/capabilities' })).json()).toMatchObject({ designAssistant: { enabled: true }, calculateAssistant: { enabled: false } });
      } finally {
        await enabled.close();
      }
    });
  });

  describe('POST /tool-drafts/design-chat/compact', () => {
    const TOKEN = 'r'.repeat(40);
    const turns = [{ user: '年次に絞って', assistant: '年次だけにしました。', changes: ["added filter 'yearly' after 'period'"] }];
    const body = { turns, language: 'ja' };
    /** 圧縮 1 回の返り値を固定するフェイク（要約の中身は応用層のテストで見る）。 */
    const stub = (result: unknown, capture?: (input: Record<string, unknown>) => void): App['designToolChat'] => ({
      available: async () => true,
      compact: async (input: Record<string, unknown>) => { capture?.(input); return result; },
    } as unknown as App['designToolChat']);

    it('正常: 200 で要約と消費を返し、本文はそのままユースケースへ渡る（保存はしない）', async () => {
      let received: Record<string, unknown> | undefined;
      const stubbed = buildServer({ ...app, designToolChat: stub(
        { summary: '- 年次だけにする', usage: { promptTokens: 1_200, completionTokens: 180, contextWindow: 200_192 } },
        (input) => { received = input; },
      ) });
      try {
        const response = await stubbed.inject({
          method: 'POST', url: '/tool-drafts/design-chat/compact',
          // body の scope は無視し、認証済み principal のスコープで実行する（既存のルートと同じ規律）。
          payload: { ...body, scope: { tenantId: 'other', workspaceId: 'other' }, previousSummary: '- 人口のツールを作る' },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ summary: '- 年次だけにする', usage: { promptTokens: 1_200, completionTokens: 180, contextWindow: 200_192 } });
        expect(received).toMatchObject({ scope: { tenantId: 'local', workspaceId: 'default' }, turns, language: 'ja', previousSummary: '- 人口のツールを作る' });
      } finally {
        await stubbed.close();
      }
    });

    it('正常: previousSummary を送らなければ渡さない（1 回目の圧縮）', async () => {
      let received: Record<string, unknown> | undefined;
      const stubbed = buildServer({ ...app, designToolChat: stub({ summary: '- 覚え書き' }, (input) => { received = input; }) });
      try {
        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', payload: body });
        expect(received).not.toHaveProperty('previousSummary');
        // 変更の無いターンは changes を省いて送れる（画面が空配列を作らなくてよい）。
        await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', payload: { ...body, turns: [{ user: 'a' }] } });
        expect(received?.['turns']).toEqual([{ user: 'a', changes: [] }]);
      } finally {
        await stubbed.close();
      }
    });

    it.each([
      ['turns が 41 件', { turns: Array.from({ length: 41 }, () => ({ user: 'x', changes: [] })), language: 'ja' }],
      ['turns が空', { turns: [], language: 'ja' }],
      ['turns が無い', { language: 'ja' }],
      ['user が空', { turns: [{ user: '', changes: [] }], language: 'ja' }],
      ['language が語彙外', { turns, language: 'fr' }],
      ['language が無い', { turns }],
      ['previousSummary が 4,001 字', { turns, language: 'ja', previousSummary: 'あ'.repeat(4_001) }],
    ])('異常: %s の body は 400 BAD_REQUEST', async (_name, payload) => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });

    it('境界: turns は 40 件まで通る', async () => {
      const stubbed = buildServer({ ...app, designToolChat: stub({ summary: '- 覚え書き' }) });
      try {
        const forty = { turns: Array.from({ length: 40 }, () => ({ user: 'x', changes: [] })), language: 'ja' };
        expect((await stubbed.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', payload: forty })).statusCode).toBe(200);
      } finally {
        await stubbed.close();
      }
    });

    it('異常: モデル未設定なら 502 MODEL_PROVIDER（1 ターンと同じ経路）', async () => {
      const response = await server.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', payload: body });
      expect(response.statusCode).toBe(502);
      expect(response.json().error).toMatchObject({ code: 'MODEL_PROVIDER', message: expect.stringContaining('not configured') });
    });

    it('異常: tool:execute を持たない viewer は 403（材料は設計中のツールの会話そのもの）', async () => {
      const rolesAuth = (roles: readonly AuthorizationRole[]): AuthenticationPort => ({
        mode: 'token', required: true,
        authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
          ? authenticated({ subject: 'rita', tenantId: 't', workspaceId: 'w', roles })
          : rejected('missing-credentials'),
      });
      const viewer = buildServer(app, { authentication: rolesAuth(['viewer']), authorization: new RoleMatrixAuthorization() });
      try {
        const forbidden = await viewer.inject({ method: 'POST', url: '/tool-drafts/design-chat/compact', headers: { authorization: `Bearer ${TOKEN}` }, payload: body });
        expect(forbidden.statusCode).toBe(403);
        expect(forbidden.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:execute' permission" });
      } finally {
        await viewer.close();
      }
      expect(explicitRouteAuthorization('POST', '/tool-drafts/design-chat/compact')).toMatchObject({ action: 'execute', kind: 'tool' });
    });
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
