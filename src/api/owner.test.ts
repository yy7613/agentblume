/**
 * v52: 所有者（owner）の省略可と既定値のテスト。
 *
 * - `resolveOwner` 単体: 明示値は前後の空白を除いて尊重、空・省略はログイン中の主体の表示名（無ければ subject）。
 * - 代表ルート（tools・skills・agents・harness・検証資産・品質ゲート）: 省略・空文字・空白のみで保存でき、
 *   保存された `metadata.owner` が主体名になる。明示値はその値になる。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { authenticated, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { Principal } from '../domain/security/principal';
import { UnauthenticatedError } from './authentication';
import { resolveOwner, withResolvedOwner } from './owner';
import { buildServer } from './server';

const scope = { tenantId: 'tenant-owner', workspaceId: 'ws-owner' };

function requestAs(principal: Partial<Principal> | undefined): FastifyRequest {
  return (principal === undefined ? {} : { principal: { subject: 'rita', ...scope, roles: [], ...principal } }) as unknown as FastifyRequest;
}

describe('resolveOwner', () => {
  it('正常: 明示した owner は前後の空白を除いてそのまま使う', () => {
    expect(resolveOwner(requestAs({ displayName: 'Rita' }), '  Hanako  ')).toBe('Hanako');
  });
  it('正常: 省略時は主体の表示名を使う', () => {
    expect(resolveOwner(requestAs({ displayName: 'Rita Tanaka' }), undefined)).toBe('Rita Tanaka');
  });
  it('境界: 空文字・空白だけは省略と同じに扱う', () => {
    expect(resolveOwner(requestAs({ displayName: 'Rita Tanaka' }), '')).toBe('Rita Tanaka');
    expect(resolveOwner(requestAs({ displayName: 'Rita Tanaka' }), ' \t\n ')).toBe('Rita Tanaka');
  });
  it('境界: 表示名が無い（または空白だけの）主体は subject を使う', () => {
    expect(resolveOwner(requestAs({}), undefined)).toBe('rita');
    expect(resolveOwner(requestAs({ displayName: '  ' }), '')).toBe('rita');
  });
  it('例外: 省略時に主体が無ければ UnauthenticatedError（既定値へ黙って倒さない）', () => {
    expect(() => resolveOwner(requestAs(undefined), undefined)).toThrow(UnauthenticatedError);
  });
  it('正常: 明示値があれば主体を見ない（主体が無くても例外にならない）', () => {
    expect(resolveOwner(requestAs(undefined), 'Hanako')).toBe('Hanako');
  });
  it('正常: withResolvedOwner は他のフィールドを保ったまま owner だけを置き換える', () => {
    const blank: { internalId: string; owner?: string } = { internalId: 'x', owner: '' };
    const omitted: { internalId: string; owner?: string } = { internalId: 'x' };
    expect(withResolvedOwner(requestAs({ displayName: 'Rita' }), blank)).toEqual({ internalId: 'x', owner: 'Rita' });
    expect(withResolvedOwner(requestAs({ displayName: 'Rita' }), omitted)).toEqual({ internalId: 'x', owner: 'Rita' });
  });
});

const toolBody = {
  scope, internalId: 'scores', workingName: 'Scores', displayName: 'Score filter', publishName: 'filter_scores', sideEffect: 'read-only',
  graph: { nodes: [{ id: 'source', type: 'agent-input', config: { schema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, sample: { score: 1 } } }], edges: [] },
  inputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] }, outputSchema: { columns: [{ name: 'score', type: 'number', nullable: false }] },
};
const agentBody = (id: string) => ({ scope, internalId: id, workingName: id, displayName: id, publishName: id.replaceAll('-', '_'), kind: 'normal', systemPrompt: `You are ${id}.`, tools: [{ internalId: 'scores', version: '1.0.0' }] });
const criteria = [{ id: 'accuracy', label: 'Accuracy', description: 'Factual correctness', weight: 1, levels: [{ score: 0, label: 'Wrong', description: 'Incorrect' }, { score: 1, label: 'Correct', description: 'Fully correct' }] }];

/** 代表ルート: [名前, URL, 本文（owner 抜き）, 応答から保存された資産を取り出すキー]。 */
const ROUTES: readonly (readonly [string, string, () => Record<string, unknown>, string])[] = [
  ['tools', '/tools', () => ({ ...toolBody, internalId: 'owned-tool', publishName: 'owned_tool' }), 'tool'],
  ['skills', '/skills', () => ({
    scope, internalId: 'analysis', workingName: 'Analysis', displayName: 'Data analysis', publishName: 'data_analysis',
    responsibility: 'Analyze data.', activationCondition: 'Use for data questions.', inputDescription: 'A request and data.', outputDescription: 'A grounded answer.',
    instructions: 'Use filter_scores.', tools: [{ internalId: 'scores', version: '1.0.0' }],
  }), 'skill'],
  ['agents', '/agents', () => agentBody('owned-agent'), 'agent'],
  ['harnesses', '/harnesses', () => ({
    scope, internalId: 'content-review', workingName: 'Content review', displayName: 'Content review', publishName: 'content_review', pattern: 'sequential',
    slots: ['writer', 'reviewer'].map((id) => ({ id, label: id, purpose: `${id} work`, assignment: { internalId: id, version: '1.0.0' } })),
    topology: { pattern: 'sequential', orderedSlotIds: ['writer', 'reviewer'], contextMode: 'full-conversation' },
  }), 'harness'],
  ['personas', '/personas', () => ({
    scope, internalId: 'novice-user', workingName: 'p', displayName: 'Novice user', publishName: 'novice_user',
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja',
  }), 'persona'],
  ['scenarios', '/scenarios', () => ({
    scope, internalId: 'sales-check', workingName: 's', displayName: 'Sales check', publishName: 'sales_check',
    target: { agentId: 'writer', version: '1.0.0' }, persona: { personaId: 'scenario-persona', version: '1.0.0' }, goal: '先月の売上サマリを得る', maxUserTurns: 2,
    survey: [{ id: 'impressions', textJa: '感想', textEn: 'Impressions', kind: 'text' }],
  }), 'scenario'],
  ['evaluation-datasets', '/evaluation-datasets', () => ({
    scope, internalId: 'quality', workingName: 'draft', displayName: 'Quality', publishName: 'quality',
    cases: [{ id: 'case-1', kind: 'turn', input: 'Summarize sales', reference: 'Sales were 42.', tags: [], source: 'manual' }],
  }), 'dataset'],
  ['evaluator-profiles', '/evaluator-profiles', () => ({
    scope, internalId: 'default', workingName: 'draft', displayName: 'Default', publishName: 'default',
    metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }],
  }), 'profile'],
  ['judge-rubrics', '/judge-rubrics', () => ({
    scope, internalId: 'quality-rubric', workingName: 'draft', displayName: 'Quality rubric', publishName: 'quality_rubric',
    instructions: 'Judge correctness.', referencePolicy: 'required', criteria,
  }), 'rubric'],
  ['gate-policies', '/gate-policies', () => ({
    scope, internalId: 'release', workingName: 'Release', displayName: 'Release', publishName: 'release',
    rules: [{ id: 'threshold', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }],
  }), 'policy'],
];

/** 省略・空文字・空白のみ（いずれも「省略」扱い）。undefined はキーごと送らない。 */
const OMITTED: readonly (readonly [string, string | undefined])[] = [['省略', undefined], ['空文字', ''], ['空白のみ', '   ']];

function withOwner(body: Record<string, unknown>, owner: string | undefined): Record<string, unknown> {
  return owner === undefined ? body : { ...body, owner };
}

async function prepare(server: FastifyInstance): Promise<void> {
  // 参照される Tool・Agent・Persona を先に保存する（これら自体も owner 省略で保存できることの確認を兼ねる）。
  expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody })).statusCode).toBe(201);
  for (const id of ['writer', 'reviewer']) {
    expect((await server.inject({ method: 'POST', url: '/agents', payload: agentBody(id) })).statusCode).toBe(201);
  }
  const persona = { ...ROUTES[4]![2](), internalId: 'scenario-persona', publishName: 'scenario_persona' };
  expect((await server.inject({ method: 'POST', url: '/personas', payload: persona })).statusCode).toBe(201);
}

describe('owner を省略できるルート（シングルユーザー）', () => {
  let app: App;
  let server: FastifyInstance;
  beforeEach(async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    await prepare(server);
  });
  afterEach(async () => { await server.close(); app.close(); });

  describe.each(ROUTES)('POST %s', (_name, url, body, key) => {
    it.each(OMITTED)('正常: owner が%sなら Local operator で保存される', async (_label, owner) => {
      const response = await server.inject({ method: 'POST', url, payload: withOwner(body(), owner) });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()[key].metadata.owner).toBe('Local operator');
    });
    it('正常: 明示した owner は従来どおり前後の空白を除いて保存される', async () => {
      const response = await server.inject({ method: 'POST', url, payload: withOwner(body(), '  Hanako  ') });
      expect(response.statusCode, response.body).toBe(201);
      expect(response.json()[key].metadata.owner).toBe('Hanako');
    });
  });

  it('正常: 版を上げる保存で読み込んだ owner をそのまま送れば、従来どおり所有者は変わらない', async () => {
    const first = await server.inject({ method: 'POST', url: '/personas', payload: withOwner(ROUTES[4]![2](), 'Hanako') });
    const second = await server.inject({ method: 'POST', url: '/personas', payload: { ...withOwner(ROUTES[4]![2](), first.json().persona.metadata.owner), bump: 'minor' } });
    expect(second.statusCode).toBe(201);
    expect(second.json().persona.metadata).toMatchObject({ version: '1.1.0', owner: 'Hanako' });
  });

  it('正常: 下書き検証（tool-drafts/diagnose・agent-drafts/diagnose・harness-drafts/validate）も owner 省略で通る', async () => {
    const tool = await server.inject({ method: 'POST', url: '/tool-drafts/diagnose', payload: withOwner(toolBody, '') });
    expect(tool.statusCode, tool.body).toBe(200);
    const agent = await server.inject({ method: 'POST', url: '/agent-drafts/diagnose', payload: agentBody('draft-agent') });
    expect(agent.statusCode, agent.body).toBe(200);
    const harness = await server.inject({ method: 'POST', url: '/harness-drafts/validate', payload: withOwner(ROUTES[3]![2](), '  ') });
    expect(harness.statusCode, harness.body).toBe(200);
    expect(harness.json().validation).toEqual({ valid: true, issues: [] });
  });

  it('異常: owner が文字列でなければ従来どおり 400', async () => {
    const response = await server.inject({ method: 'POST', url: '/tools', payload: withOwner({ ...toolBody, internalId: 'bad' }, 42 as unknown as string) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('owner');
  });
});

describe('owner を省略できるルート（トークン認証）', () => {
  let app: App;
  let server: FastifyInstance;
  function tokenAuth(principal: Partial<Principal>): AuthenticationPort {
    return { mode: 'token', required: true, authenticate: async () => authenticated({ subject: 'rita', ...scope, roles: ['workspace-admin'], ...principal } as Principal) };
  }
  afterEach(async () => { await server.close(); app.close(); });

  it('正常: 表示名の無い主体なら subject で保存される', async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: tokenAuth({}) });
    const response = await server.inject({ method: 'POST', url: '/tools', payload: toolBody });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().tool.metadata.owner).toBe('rita');
  });
  it('正常: 表示名のある主体なら表示名で保存される', async () => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: tokenAuth({ displayName: 'Rita Tanaka' }) });
    const response = await server.inject({ method: 'POST', url: '/tools', payload: withOwner(toolBody, '') });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().tool.metadata.owner).toBe('Rita Tanaka');
  });
});
