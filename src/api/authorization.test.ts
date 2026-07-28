/**
 * 認可フックと監査ログのテスト（HTTP境界での振る舞い）。
 *
 * 守りたいのは4つ。
 * 1. **表の網羅性**: 登録された全ルートが `ROUTE_RULES` に載っている（足し忘れが赤くなる）。
 * 2. **ロールごとの許可/拒否**: §3.2 の表がHTTPの結果として現れる。
 * 3. **単一ユーザーモードは全部通る**（既存のローカル利用を壊さない）。
 * 4. **監査**: 拒否・破壊的操作・実行が残り、秘密は残らず、参照はOperator限定。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { InMemoryAuditLogRepository } from '../adapters/storage/in-memory-audit-log-repository';
import { RoleMatrixAuthorization } from '../adapters/security/role-matrix-authorization';
import { authenticated, rejected, type AuthenticationPort } from '../application/security/authentication';
import { createApp, type App } from '../composition/root';
import type { AuthorizationRole } from '../domain/security/authorization';
import { buildServer } from './server';
import { AUTHORIZATION_EXEMPT_PATHS, defaultRouteAuthorization, explicitRouteAuthorization, ROUTE_RULES, routeAuthorizationFor } from './authorization';

const TOKEN = 'r'.repeat(40);
const SCOPE = { tenantId: 'acme', workspaceId: 'ops' };

/**
 * 指定したロールだけを持つ主体として認証する最小の `AuthenticationPort`。
 * トークンの内容は問わない（ここで試したいのは認可であって認証ではない）。
 */
function rolesAuth(roles: readonly AuthorizationRole[], subject = 'rita'): AuthenticationPort {
  return {
    mode: 'token',
    required: true,
    authenticate: async (request) => request.header('authorization') === `Bearer ${TOKEN}`
      ? authenticated({ subject, ...SCOPE, roles })
      : rejected('missing-credentials'),
  };
}

const auth = { authorization: `Bearer ${TOKEN}` };

function toolBody(internalId: string) {
  return {
    scope: SCOPE, internalId,
    workingName: `${internalId}-working`, displayName: internalId, publishName: internalId,
    owner: 'test@example.com', sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'src', type: 'json-source', config: { rows: [{ id: 1 }] } },
        { id: 'sel', type: 'select', config: { columns: ['id'] } },
      ],
      edges: [{ from: 'src', to: 'sel' }],
    },
  };
}

/**
 * 監査の書き込みは `onResponse`（応答を返し終えたあと）で走る。
 * `inject` は応答の終了で解決するので、台帳を読む前に1ティック譲る。
 * これは「監査が本処理を遅らせない」ことの裏返しでもある。
 */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

let app: App;
let audit: InMemoryAuditLogRepository;

beforeEach(() => {
  // 書き込み（フックの sink）と参照（`GET /operations/audit`）で**同じ台帳**を使う。
  audit = new InMemoryAuditLogRepository();
  app = createApp({ profile: 'test', auditLogRepository: audit });
});
afterEach(() => { app.close(); });

function serverFor(roles: readonly AuthorizationRole[]): FastifyInstance {
  return buildServer(app, {
    authentication: rolesAuth(roles),
    authorization: new RoleMatrixAuthorization(),
    audit: { sink: audit, fallbackScope: SCOPE },
  });
}

describe('ルート → 権限の対応表', () => {
  it('登録された全ルートが表に載っている（既定へ落ちたものは無い）', () => {
    const server = buildServer(app);
    expect(server.unmappedAuthorizationRoutes).toEqual([]);
    // 表が空振りしていないことも見る（全ルートが exempt になっていたら上の検査は無意味）。
    expect(server.authorizedRoutes.length).toBeGreaterThan(100);
  });

  it('表に重複した行が無い', () => {
    const keys = ROUTE_RULES.map((entry) => `${entry.method} ${entry.url}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('表に無いルートは既定（読みは read・書きは edit・削除は delete）へ落ちる', () => {
    expect(explicitRouteAuthorization('GET', '/does-not-exist')).toBeUndefined();
    expect(routeAuthorizationFor('GET', '/does-not-exist')).toEqual({ action: 'read', kind: 'workspace' });
    expect(defaultRouteAuthorization('POST')).toEqual({ action: 'edit', kind: 'workspace' });
    expect(defaultRouteAuthorization('DELETE')).toEqual({ action: 'delete', kind: 'workspace', audit: true });
  });

  it('/auth/session は認可の対象外（403の理由を確認する手段を残す）', () => {
    expect(AUTHORIZATION_EXEMPT_PATHS.has('/auth/session')).toBe(true);
  });
});

describe('ロールごとの許可と拒否', () => {
  it('viewer は読めるが書けない', async () => {
    const server = serverFor(['viewer']);
    expect((await server.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode).toBe(200);
    const created = await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('viewer-tool') });
    expect(created.statusCode).toBe(403);
    expect(created.json().error).toEqual({ code: 'FORBIDDEN', message: "this operation requires the 'tool:create' permission" });
  });

  it('editor は作成・実行できるが、削除・承認・運用はできない', async () => {
    const server = serverFor(['editor']);
    expect((await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('editor-tool') })).statusCode).toBe(201);
    const deleted = await server.inject({ method: 'DELETE', url: '/tools/editor-tool', headers: auth });
    expect(deleted.statusCode).toBe(403);
    expect(deleted.json().error.message).toBe("this operation requires the 'tool:delete' permission");
    // ツール承認（実行前承認）は approve。runId が存在しなくても認可で先に止まる。
    expect((await server.inject({ method: 'POST', url: '/runs/none/resume', headers: auth, payload: { scope: SCOPE, decision: 'approve' } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/operations/status', headers: auth })).statusCode).toBe(403);
    expect((await server.inject({ method: 'POST', url: '/operations/retention/apply', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(403);
    expect((await server.inject({ method: 'GET', url: '/operations/audit', headers: auth })).statusCode).toBe(403);
    // 削除は本当に起きていない。
    expect((await server.inject({ method: 'GET', url: '/tools/editor-tool', headers: auth })).statusCode).toBe(200);
  });

  it('publisher は承認できるが運用操作はできない', async () => {
    const server = serverFor(['publisher']);
    // 認可は通り、存在しない昇格申請として 404 まで到達する（403で止まらない）。
    const decided = await server.inject({ method: 'POST', url: '/promotion-requests/none/approve', headers: auth, payload: { scope: SCOPE } });
    expect(decided.statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: '/operations/backups', headers: auth })).statusCode).toBe(403);
    expect((await server.inject({ method: 'DELETE', url: '/tools/anything', headers: auth })).statusCode).toBe(403);
  });

  it('operator は運用と監査ログを読めるが、公開も削除もできない', async () => {
    const server = serverFor(['operator']);
    expect((await server.inject({ method: 'GET', url: '/operations/status', headers: auth })).statusCode).toBe(200);
    expect((await server.inject({ method: 'GET', url: '/operations/audit', headers: auth })).statusCode).toBe(200);
    expect((await server.inject({ method: 'DELETE', url: '/tools/anything', headers: auth })).statusCode).toBe(403);
    // 公開（deployment）は Publisher / Admin だけ。MCP公開の入口で確かめる。
    expect((await server.inject({ method: 'DELETE', url: '/mcp-servers/anything', headers: auth })).statusCode).toBe(403);
  });

  it('workspace-admin は削除できる', async () => {
    const server = serverFor(['workspace-admin']);
    expect((await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('admin-tool') })).statusCode).toBe(201);
    expect((await server.inject({ method: 'DELETE', url: '/tools/admin-tool', headers: auth })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/tools/admin-tool', headers: auth })).statusCode).toBe(404);
  });

  it('Harnessの応答は「入力」なら execute、「承認」なら approve を要求する', async () => {
    const editor = serverFor(['editor']);
    // 追加入力は対話の続きなので editor で通る（存在しないRunとして404まで到達する）。
    const input = await editor.inject({ method: 'POST', url: '/harness-runs/none/responses', headers: auth, payload: { scope: SCOPE, response: { kind: 'input', message: 'go on' } } });
    expect(input.statusCode).toBe(404);
    // 計画承認は実行前承認そのものなので Publisher 以上。
    const approval = await editor.inject({ method: 'POST', url: '/harness-runs/none/responses', headers: auth, payload: { scope: SCOPE, response: { kind: 'approval', decision: 'approve' } } });
    expect(approval.statusCode).toBe(403);
    expect(approval.json().error.message).toBe("this operation requires the 'harness:approve' permission");

    const publisher = serverFor(['publisher']);
    const allowed = await publisher.inject({ method: 'POST', url: '/harness-runs/none/responses', headers: auth, payload: { scope: SCOPE, response: { kind: 'approval', decision: 'approve' } } });
    expect(allowed.statusCode).toBe(404);
  });

  it('ハンドラ内の追加判定で拒否したときも監査へ残る', async () => {
    const editor = serverFor(['editor']);
    await editor.inject({ method: 'POST', url: '/harness-runs/run-42/responses', headers: auth, payload: { scope: SCOPE, response: { kind: 'approval', decision: 'approve' } } });
    await settle();
    const entries = await audit.list(SCOPE, { outcome: 'denied' });
    expect(entries).toMatchObject([{ subject: 'rita', action: 'approve', resource: { kind: 'harness', id: 'run-42' } }]);
  });

  it('ロールを持たない主体は読み取りすら通らない（フェイルセーフ）', async () => {
    const server = serverFor([]);
    expect((await server.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode).toBe(403);
    // ただし「自分が誰か」は確認できる（権限が無い理由を画面で読めるようにするため）。
    expect((await server.inject({ method: 'GET', url: '/auth/session', headers: auth })).statusCode).toBe(200);
  });

  it('403 のメッセージに保持しているロールや主体名は出さない', async () => {
    const server = serverFor(['viewer']);
    const body = (await server.inject({ method: 'DELETE', url: '/tools/x', headers: auth })).json();
    expect(JSON.stringify(body)).not.toContain('viewer');
    expect(JSON.stringify(body)).not.toContain('rita');
  });

  it('認可プロバイダーが落ちていたら拒否する（素通しにしない）', async () => {
    const server = buildServer(app, {
      authentication: rolesAuth(['workspace-admin']),
      authorization: { authorize: async () => { throw new Error('policy engine unavailable'); } },
    });
    const response = await server.inject({ method: 'GET', url: '/tools', headers: auth });
    expect(response.statusCode).toBe(403);
    // 内部の障害内容は漏らさない。
    expect(response.json().error.message).not.toContain('policy engine');
  });
});

describe('単一ユーザーモード', () => {
  it('全ロールを持つので、削除も承認も運用操作も通る', async () => {
    const server = buildServer(app, { authentication: new SingleUserAuthentication() });
    expect((await server.inject({ method: 'POST', url: '/tools', payload: toolBody('local-tool') })).statusCode).toBe(201);
    expect((await server.inject({ method: 'GET', url: '/operations/status' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'DELETE', url: '/tools/local-tool' })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/operations/audit' })).statusCode).toBe(200);
  });

  it('authorization を渡さない配線でも判定は入る（素通しにならない）', async () => {
    const server = buildServer(app, { authentication: rolesAuth(['viewer']) });
    expect((await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('x') })).statusCode).toBe(403);
  });
});

describe('監査ログ', () => {
  it('認可の拒否を1件だけ残す（理由つき・成功時は残さない）', async () => {
    const server = serverFor(['viewer']);
    await server.inject({ method: 'DELETE', url: '/tools/secret-tool', headers: auth });
    await settle();
    const entries = await audit.list(SCOPE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      subject: 'rita', tenantId: 'acme', workspaceId: 'ops',
      action: 'delete', resource: { kind: 'tool', id: 'secret-tool' }, outcome: 'denied',
    });
    expect(entries[0]?.detail).toMatchObject({ method: 'DELETE', route: '/tools/:internalId', reason: "this operation requires the 'tool:delete' permission" });
  });

  it('破壊的操作の結果を実行者つきで残す', async () => {
    const server = serverFor(['workspace-admin']);
    await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('doomed') });
    await server.inject({ method: 'DELETE', url: '/tools/doomed', headers: auth });
    await settle();
    const entries = await audit.list(SCOPE, { action: 'delete' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ subject: 'rita', action: 'delete', resource: { kind: 'tool', id: 'doomed' }, outcome: 'succeeded' });
    expect(entries[0]?.detail).toMatchObject({ status: 204 });
    // 参照・作成は残さない（台帳が実行ログの写しにならないように）。
    expect(await audit.list(SCOPE, { action: 'read' })).toHaveLength(0);
    expect(await audit.list(SCOPE, { action: 'create' })).toHaveLength(0);
  });

  it('Agent実行は「誰が・何を・どの版で」を残す', async () => {
    const server = serverFor(['editor']);
    await server.inject({ method: 'POST', url: '/runs', headers: auth, payload: { scope: SCOPE, agent: { internalId: 'assistant', version: '1.0.0' }, message: 'hi', mode: 'preview' } });
    await settle();
    const entries = await audit.list(SCOPE, { action: 'execute' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ subject: 'rita', resource: { kind: 'agent' } });
    // 実行対象はボディにしか無いので detail へ入る。存在しないAgentなので結果は failed。
    expect(entries[0]?.detail).toMatchObject({ agentId: 'assistant', agentVersion: '1.0.0', mode: 'preview' });
    expect(entries[0]?.outcome).toBe('failed');
  });

  it('運用操作（保持期限の適用）を残す', async () => {
    const server = serverFor(['operator']);
    expect((await server.inject({ method: 'POST', url: '/operations/retention/apply', headers: auth, payload: { scope: SCOPE } })).statusCode).toBe(200);
    await settle();
    expect(await audit.list(SCOPE, { action: 'operate' })).toMatchObject([{ subject: 'rita', outcome: 'succeeded', resource: { kind: 'workspace' } }]);
  });

  it('失敗した破壊的操作は failed として残る', async () => {
    const server = serverFor(['workspace-admin']);
    await server.inject({ method: 'DELETE', url: '/mcp-servers/missing', headers: auth });
    await settle();
    const entries = await audit.list(SCOPE, { resourceKind: 'mcp-server' });
    expect(entries[0]).toMatchObject({ action: 'delete', outcome: 'failed' });
  });

  it('認証に失敗した試行を残す（誰かは分からないが弾いた事実は残す）', async () => {
    const server = serverFor(['operator']);
    expect((await server.inject({ method: 'GET', url: '/tools' })).statusCode).toBe(401);
    await settle();
    const entries = await audit.list(SCOPE, { subject: '(unauthenticated)' });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: 'denied', detail: { status: 401, reason: 'authentication failed' } });
  });

  it('秘密値は台帳へ入らない', async () => {
    const server = serverFor(['operator']);
    await server.inject({
      method: 'PUT', url: '/model-settings', headers: auth,
      payload: { scope: SCOPE, slots: { chat: { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-super-secret-value' } } },
    });
    await settle();
    const entries = await audit.list(SCOPE);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain('sk-super-secret-value');
    expect(JSON.stringify(entries)).not.toContain('apiKey');
  });

  it('監査が配線されていなくてもリクエストは通る（監査は本処理を止めない）', async () => {
    const server = buildServer(app, { authentication: rolesAuth(['workspace-admin']) });
    expect((await server.inject({ method: 'GET', url: '/tools', headers: auth })).statusCode).toBe(200);
  });

  it('sink が壊れていてもリクエストは成功する', async () => {
    const server = buildServer(app, {
      authentication: rolesAuth(['workspace-admin']),
      audit: { sink: { record: async () => { throw new Error('audit storage is full'); } }, fallbackScope: SCOPE },
    });
    expect((await server.inject({ method: 'POST', url: '/tools', headers: auth, payload: toolBody('resilient') })).statusCode).toBe(201);
    expect((await server.inject({ method: 'DELETE', url: '/tools/resilient', headers: auth })).statusCode).toBe(204);
  });
});

describe('GET /operations/audit', () => {
  it('Operator だけが読め、フィルタが効く', async () => {
    const operator = serverFor(['operator']);
    await operator.inject({ method: 'POST', url: '/operations/retention/apply', headers: auth, payload: { scope: SCOPE } });
    await settle();
    const listed = await operator.inject({ method: 'GET', url: '/operations/audit?limit=10&outcome=succeeded', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().entries).toMatchObject([{ subject: 'rita', action: 'operate', outcome: 'succeeded' }]);
    expect((await operator.inject({ method: 'GET', url: '/operations/audit?outcome=denied', headers: auth })).json().entries).toEqual([]);
  });

  it('値域外のフィルタは 400', async () => {
    const operator = serverFor(['operator']);
    expect((await operator.inject({ method: 'GET', url: '/operations/audit?outcome=whatever', headers: auth })).statusCode).toBe(400);
    expect((await operator.inject({ method: 'GET', url: '/operations/audit?limit=99999', headers: auth })).statusCode).toBe(400);
  });

  it('publisher からは読めない', async () => {
    const server = serverFor(['publisher']);
    expect((await server.inject({ method: 'GET', url: '/operations/audit', headers: auth })).statusCode).toBe(403);
  });

  it('他テナントの監査は見えない', async () => {
    const server = serverFor(['operator']);
    await audit.record({ at: '2026-07-01T00:00:00.000Z', subject: 'mallory', tenantId: 'globex', workspaceId: 'main', action: 'delete', resource: { kind: 'tool' }, outcome: 'succeeded' });
    expect((await server.inject({ method: 'GET', url: '/operations/audit', headers: auth })).json().entries).toEqual([]);
  });
});
