/**
 * /expense の「入力と規程」ルート（追加読取・運賃マスタ・規程のヒアリング。docs/21 §20.9.4）のテスト。
 *
 * createApp + buildServer で配線し `fastify.inject()` で検証する。守りたいのは UI（`src/ui/api/expense-input-api.ts`）が期待する形
 * （`{ table, saved } / { table } / { result } / { hearing } / { hearings } / { changes, basePolicyUpdatedAt, stale }`）と、
 * 失敗の本文の「直す場所」（`row` / `missing` / `currentUpdatedAt` / `issues`）、認可（read / edit）。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { fixtureEmployees, fixtureFareTable, hearingFixture } from '../adapters/storage/expense-v9.fixtures';
import type { ModelCompletion } from '../application/model/model-provider';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { EXPENSE_INPUT_ROUTE_RULES } from './expense-input-authorization';
import { expenseHearingSummary } from './expense-input-routes';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const TOKEN = 'f'.repeat(40);
const DOCUMENT = '株式会社サンプル商事 旅費・経費規程\n第5条 接待の飲食は1人あたり8,000円までとする。\n';

const stop = (content: string): ModelCompletion => ({ message: { role: 'assistant', content }, finishReason: 'stop' });
const proposal = (overrides: Record<string, unknown> = {}): ModelCompletion => stop(JSON.stringify({
  categories: [{ id: 'meal.entertainment', limits: { perPerson: 8000 } }], claimRules: null, preApprovalRules: [], approvalRoutes: [], severityOverrides: null,
  rationales: [{ path: 'categories.meal.entertainment.limits.perPerson', quote: '接待の飲食は1人あたり8,000円までとする。', note: null }], questions: null, ...overrides,
}));
const { routes, stationAliases } = fixtureFareTable();
const draft = { categoryId: 'meal.entertainment', facts: { transactionDate: '2026-09-10', issueDate: '2026-09-10', amount: 38000 }, source: { type: 'image' }, extraction: { method: 'llm', warnings: [], documentKind: 'receipt' } };

function injector(server: FastifyInstance) {
  return (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => server.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
}
type Inject = ReturnType<typeof injector>;

describe('expense input routes（test プロファイル = モデルなし）', () => {
  let app: App;
  let server: FastifyInstance;
  let inject: Inject;

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    inject = injector(server);
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('運賃マスタ', () => {
    it('正常: 未保存は { table, saved: false }、PUT で保存すると { table } で以後 saved: true', async () => {
      expect((await inject('GET', `/expense/fares?${scopeQuery}`)).json()).toMatchObject({ saved: false, table: { routes: [], stationAliases: [] } });
      const saved = await inject('PUT', '/expense/fares', { scope: SCOPE, routes, stationAliases });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().table.routes).toEqual(routes);
      expect((await inject('GET', `/expense/fares?${scopeQuery}`)).json()).toMatchObject({ saved: true, table: { routes } });
    });

    it('異常: 形の誤りは 400、ドメインの違反（駅が 1 つ・日付の空文字以外の誤り）は 400 EXPENSE_DOMAIN', async () => {
      expect((await inject('PUT', '/expense/fares', { scope: SCOPE, routes: [{ ...routes[0], fare: '300' }], stationAliases: [] })).statusCode).toBe(400);
      const invalid = await inject('PUT', '/expense/fares', { scope: SCOPE, routes: [{ ...routes[0], stations: ['中野'], validFrom: '', validTo: null }], stationAliases: [] });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error.code).toBe('EXPENSE_DOMAIN');
    });

    it('正常: CSV 出力は { content, fileName }、取込は { table }。行の誤りは 400 EXPENSE_CSV_IMPORT と行番号', async () => {
      await inject('PUT', '/expense/fares', { scope: SCOPE, routes, stationAliases });
      const exported = (await inject('GET', `/expense/fares/export?${scopeQuery}`)).json();
      expect(exported.fileName).toBe('expense-fares.csv');
      const imported = await inject('POST', '/expense/fares/import', { scope: SCOPE, content: exported.content });
      expect(imported.json().table).toMatchObject({ routes, stationAliases });
      const broken = await inject('POST', '/expense/fares/import', { scope: SCOPE, content: 'stations,fare\n中野 > 新宿,abc\n' });
      expect(broken.statusCode).toBe(400);
      expect(broken.json().error).toMatchObject({ code: 'EXPENSE_CSV_IMPORT', row: 2 });
    });

    it('正常: lookup は { result }（候補・最大運賃・定期のヒント）。異常: 駅が 1 つは 400 EXPENSE_DOMAIN、日付の形は 400', async () => {
      await inject('PUT', '/expense/fares', { scope: SCOPE, routes, stationAliases });
      for (const employee of fixtureEmployees(SCOPE)) await app.expenseEmployeeRepo.save(employee);
      const res = await inject('POST', '/expense/fares/lookup', { scope: SCOPE, stations: ['新宿', '霞が関'], date: '2026-09-10', trips: 2, fareType: 'ic', employeeId: 'emp-taro' });
      expect(res.statusCode).toBe(200);
      expect(res.json().result).toMatchObject({ fareType: 'ic', maxFare: 200, routeCount: 4, commuterHint: { kind: 'full' } });
      expect((await inject('POST', '/expense/fares/lookup', { scope: SCOPE, stations: ['新宿'] })).json().error.code).toBe('EXPENSE_DOMAIN');
      expect((await inject('POST', '/expense/fares/lookup', { scope: SCOPE, stations: ['新宿', '渋谷'], date: '2026/09/10' })).statusCode).toBe(400);
    });
  });

  describe('追加読取とヒアリング（モデルなし）', () => {
    it('例外: 追加読取は 409 EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE（missing: model）。形の誤りは 400', async () => {
      const res = await inject('POST', '/expense/receipts/extract-detail', { scope: SCOPE, images: [PNG], draft });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', missing: 'model' });
      expect((await inject('POST', '/expense/receipts/extract-detail', { scope: SCOPE, images: [], draft })).statusCode).toBe(400);
      expect((await inject('POST', '/expense/receipts/extract-detail', { scope: SCOPE, images: [PNG], draft: { ...draft, facts: { amount: 'x' } } })).json().error.code).toBe('EXPENSE_DOMAIN');
    });

    it('例外: ヒアリングの開始は 409 EXPENSE_HEARING_UNAVAILABLE。文書モードの空の本文はその前に 400', async () => {
      expect((await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'questions' })).json().error).toMatchObject({ code: 'EXPENSE_HEARING_UNAVAILABLE', missing: 'model' });
      expect((await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'document', documentText: ' ' })).json().error.code).toBe('EXPENSE_DOMAIN');
      expect((await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'chat' })).statusCode).toBe(400);
    });

    it('正常: 一覧は原文を含めない要約、詳細はテナント抜き、取消は { hearing }。無いヒアリングは 404、提案の無い差分は 409', async () => {
      await app.expensePolicyHearingRepo.save(hearingFixture('h-open', { tenant: SCOPE }));
      const [, proposed] = [hearingFixture('h-open', { tenant: SCOPE }), hearingFixture('h-proposed', {
        tenant: SCOPE, mode: 'document', status: 'proposed', turns: [], source: { documentText: DOCUMENT, fileName: 'policy.md' },
        proposal: { candidate: { severityOverrides: { 'payee-missing': 'return' } }, rationales: [], dropped: [{ path: 'x', reason: 'y' }], warnings: [] },
      })];
      await app.expensePolicyHearingRepo.save(proposed!);
      const list = (await inject('GET', `/expense/policy-hearings?${scopeQuery}`)).json().hearings;
      expect(list).toHaveLength(2);
      expect(JSON.stringify(list)).not.toContain('接待の飲食');
      expect(list.find((entry: { id: string }) => entry.id === 'h-proposed')).toEqual(expenseHearingSummary(proposed!));
      expect(expenseHearingSummary(proposed!)).toMatchObject({ fileName: 'policy.md', proposedItemCount: 1, droppedCount: 1, turnCount: 0 });
      expect((await inject('GET', `/expense/policy-hearings?${scopeQuery}&status=open`)).json().hearings.map((entry: { id: string }) => entry.id)).toEqual(['h-open']);
      expect((await inject('GET', `/expense/policy-hearings?${scopeQuery}&status=nope`)).statusCode).toBe(400);

      const detail = (await inject('GET', `/expense/policy-hearings/h-open?${scopeQuery}`)).json().hearing;
      expect(detail).toMatchObject({ id: 'h-open', status: 'open' });
      expect(detail).not.toHaveProperty('tenant');
      expect((await inject('GET', `/expense/policy-hearings/h-open/diff?${scopeQuery}`)).json().error.code).toBe('EXPENSE_TRANSITION');
      expect((await inject('GET', `/expense/policy-hearings/h-proposed/diff?${scopeQuery}`)).json()).toMatchObject({ changes: [{ id: 'severity:payee-missing' }], basePolicyUpdatedAt: '2026-09-14T00:00:00.000Z', stale: true });
      expect((await inject('POST', '/expense/policy-hearings/h-open/cancel', { scope: SCOPE })).json().hearing.status).toBe('cancelled');

      for (const [method, url, body] of [
        ['GET', `/expense/policy-hearings/none?${scopeQuery}`, undefined],
        ['GET', `/expense/policy-hearings/none/diff?${scopeQuery}`, undefined],
        ['POST', '/expense/policy-hearings/none/answers', { scope: SCOPE, answers: [{ questionId: 'q1', value: 1 }] }],
        ['POST', '/expense/policy-hearings/none/accept', { scope: SCOPE, changeIds: ['x'], basePolicyUpdatedAt: 'x' }],
        ['POST', '/expense/policy-hearings/none/cancel', { scope: SCOPE }],
      ] as const) {
        const res = await inject(method, url, body);
        expect(res.statusCode, url).toBe(404);
        expect(res.json().error.code).toBe('EXPENSE_HEARING_NOT_FOUND');
      }
      expect((await inject('POST', '/expense/policy-hearings/h-proposed/accept', { scope: SCOPE, changeIds: [], basePolicyUpdatedAt: 'x' })).statusCode).toBe(400);
      expect((await inject('POST', '/expense/policy-hearings/h-proposed/answers', { scope: SCOPE, answers: [] })).statusCode).toBe(400);
    });
  });
});

describe('expense input routes（台本のモデル）', () => {
  let app: App;
  let server: FastifyInstance;
  let model: ScriptedModelProvider;
  let inject: Inject;

  beforeEach(() => {
    model = new ScriptedModelProvider();
    vi.stubEnv('LM_STUDIO_MODEL', 'scripted');
    app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: model, logger: () => { /* 保存先ログは出さない */ } });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
    inject = injector(server);
  });

  afterEach(async () => {
    await server.close();
    app.close();
    vi.unstubAllEnvs();
  });

  it('正常: 文書モードで案を作り、差分を選んで保存する。差分の後に規程が保存されていたら 409 EXPENSE_POLICY_CONFLICT（現在の版つき）', async () => {
    model.enqueue(proposal({ severityOverrides: { 'payee-missing': 'return' } }));
    const started = await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'document', documentText: DOCUMENT, fileName: 'policy.md' });
    expect(started.statusCode).toBe(200);
    const hearing = started.json().hearing;
    expect(hearing).toMatchObject({ status: 'proposed', mode: 'document', source: { fileName: 'policy.md' } });
    expect(hearing).not.toHaveProperty('tenant');

    const diff = (await inject('GET', `/expense/policy-hearings/${hearing.id}/diff?${scopeQuery}`)).json();
    expect(diff.changes.map((change: { id: string }) => change.id)).toEqual(['category:meal.entertainment:limits.perPerson', 'severity:payee-missing']);

    const conflict = await inject('POST', `/expense/policy-hearings/${hearing.id}/accept`, { scope: SCOPE, changeIds: ['severity:payee-missing'], basePolicyUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({ code: 'EXPENSE_POLICY_CONFLICT', currentUpdatedAt: diff.basePolicyUpdatedAt });

    const accepted = await inject('POST', `/expense/policy-hearings/${hearing.id}/accept`, { scope: SCOPE, changeIds: ['category:meal.entertainment:limits.perPerson'], basePolicyUpdatedAt: diff.basePolicyUpdatedAt });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().hearing).toMatchObject({ status: 'accepted', acceptedChangeIds: ['category:meal.entertainment:limits.perPerson'] });
    const saved = (await inject('GET', `/expense/policy?${scopeQuery}`)).json();
    expect(saved.saved).toBe(true);
    expect(saved.policy.categories.find((category: { id: string }) => category.id === 'meal.entertainment').limits.perPerson).toBe(8000);
    expect(saved.policy.severityOverrides).toEqual({});
  });

  it('正常: 質問モードは質問 → 回答 → 案。異常: 形の壊れた応答が修復でも直らなければ 502 EXPENSE_HEARING_SCHEMA（issues つき）', async () => {
    model.enqueue(proposal({ categories: [], rationales: [], questions: [{ id: 'q1', text: '提出期限は？', kind: 'number', options: null, topic: 'submission-deadline' }] }));
    const hearing = (await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'questions' })).json().hearing;
    expect(hearing).toMatchObject({ status: 'open', turns: [{ questions: [{ id: 'q1' }] }] });
    model.enqueue(proposal({ categories: [], rationales: [], claimRules: { submissionDeadlineDays: 45 } }));
    const answered = await inject('POST', `/expense/policy-hearings/${hearing.id}/answers`, { scope: SCOPE, answers: [{ questionId: 'q1', value: 45 }] });
    expect(answered.json().hearing).toMatchObject({ status: 'proposed', proposal: { candidate: { claimRules: { submissionDeadlineDays: 45 } } } });

    model.enqueue(stop('broken'), stop('still broken'));
    const broken = await inject('POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'questions' });
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error.code).toBe('EXPENSE_HEARING_SCHEMA');
    expect(broken.json().error.issues[0]).toContain('JSON');
  });

  it('正常: 追加読取は { result: { draft, disagreements, warnings } }（保存しない）', async () => {
    model.enqueue(stop(JSON.stringify({
      registrationNumberText: null, payeeNameText: null, transactionDateText: null, issueDateText: '2026/9/10',
      attendees: { countText: '4名', names: [] }, purposeClues: ['お品代'], route: { from: null, to: null, via: [], fareType: null }, notes: [],
    })));
    const res = await inject('POST', '/expense/receipts/extract-detail', { scope: SCOPE, images: [PNG], draft });
    expect(res.statusCode).toBe(200);
    expect(res.json().result).toMatchObject({ disagreements: [], draft: { facts: { attendees: { count: 4 } }, extraction: { flags: ['transaction-date-substituted', 'attendees-read'], detail: { promptVersion: 'expense-detail/v1' } } } });
    expect(await app.listExpenseClaims.execute(SCOPE)).toEqual([]);
  });
});

describe('expense input routes の認可', () => {
  let app: App;

  const serverFor = (roles: readonly AuthorizationRole[]): FastifyInstance => {
    const authentication: AuthenticationPort = {
      mode: 'token', required: true,
      authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}` ? authenticated({ subject: 'rita', ...SCOPE, roles }) : rejected('missing-credentials'),
    };
    return buildServer(app, { authentication, authorization: new RoleMatrixAuthorization() });
  };
  const headers = { authorization: `Bearer ${TOKEN}` };

  beforeEach(() => { app = createApp({ profile: 'test' }); });
  afterEach(() => { app.close(); });

  it('参照（運賃・照合・一覧・差分）は Viewer でも通り、保存・取込・ヒアリングの開始・回答・保存・取消・追加読取は Editor 以上', async () => {
    const viewer = serverFor(['viewer']);
    const editor = serverFor(['editor']);
    try {
      expect((await viewer.inject({ method: 'GET', url: `/expense/fares?${scopeQuery}`, headers })).statusCode).toBe(200);
      expect((await viewer.inject({ method: 'POST', url: '/expense/fares/lookup', headers, payload: { scope: SCOPE, stations: ['A', 'B'] } })).statusCode).toBe(200);
      expect((await viewer.inject({ method: 'GET', url: `/expense/policy-hearings?${scopeQuery}`, headers })).statusCode).toBe(200);
      for (const [method, url, payload] of [
        ['PUT', '/expense/fares', { scope: SCOPE, routes: [], stationAliases: [] }],
        ['POST', '/expense/fares/import', { scope: SCOPE, content: 'stations,fare\n' }],
        ['POST', '/expense/policy-hearings', { scope: SCOPE, mode: 'questions' }],
        ['POST', '/expense/policy-hearings/x/answers', { scope: SCOPE, answers: [{ questionId: 'q', value: 1 }] }],
        ['POST', '/expense/policy-hearings/x/accept', { scope: SCOPE, changeIds: ['a'], basePolicyUpdatedAt: 'b' }],
        ['POST', '/expense/policy-hearings/x/cancel', { scope: SCOPE }],
        ['POST', '/expense/receipts/extract-detail', { scope: SCOPE, images: [PNG], draft }],
      ] as const) {
        expect((await viewer.inject({ method, url, headers, payload })).statusCode, `${method} ${url}`).toBe(403);
        expect((await editor.inject({ method, url, headers, payload })).statusCode, `${method} ${url}`).not.toBe(403);
      }
    } finally {
      await viewer.close();
      await editor.close();
    }
  });

  it('監査は以後の判定の基準が変わる操作だけ（運賃マスタの保存・取込、ヒアリングの案の保存）', () => {
    expect(EXPENSE_INPUT_ROUTE_RULES.filter((entry) => entry.audit).map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      'PUT /expense/fares', 'POST /expense/fares/import', 'POST /expense/policy-hearings/:id/accept',
    ]);
    expect(EXPENSE_INPUT_ROUTE_RULES.every((entry) => entry.kind === 'workspace' && entry.action !== 'approve')).toBe(true);
  });
});
