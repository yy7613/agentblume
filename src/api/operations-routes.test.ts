import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { AesGcmSecretCipher } from '../adapters/security/aes-gcm-secret-cipher';
import type { TelemetryPort } from '../application/operations/telemetry';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { SemVer } from '../domain/tool/semver';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

describe('LLMOps operations API', () => {
  let model: ScriptedModelProvider; let app: App; let server: FastifyInstance;
  beforeEach(async () => {
    model = new ScriptedModelProvider(); app = createApp({ profile: 'test', modelProvider: model }); server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    await app.saveAgent.execute({ scope, internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer.', tools: [] });
  });
  afterEach(async () => { await server.close(); app.close(); });

  it('Run観測、Feedback、時系列、retentionを縦断し匿名集計を保持する', async () => {
    model.enqueue({ message: { role: 'assistant', content: 'answer' }, finishReason: 'stop', usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 } });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'agent', version: '1.0.0' }, message: 'hello', mode: 'preview' } });
    expect(response.statusCode).toBe(200);
    const run = response.json().run;
    expect(run).toMatchObject({ purpose: 'interactive', model: { provider: 'scripted', model: 'scripted' }, latency: { totalMs: expect.any(Number), modelMs: expect.any(Number), toolMs: 0 }, estimatedCost: { kind: 'estimated', amount: 0.0002, currency: 'USD' } });

    const saved = await server.inject({ method: 'PUT', url: `/runs/${run.runId}/feedback`, payload: { scope, thumb: 'down', rating: 2, comment: 'incorrect answer', issueTags: ['incorrect'] } });
    expect(saved.statusCode).toBe(200); expect(saved.json().feedback).toMatchObject({ runId: run.runId, agent: { internalId: 'agent', version: '1.0.0' }, thumb: 'down' });
    const updated = await server.inject({ method: 'PUT', url: `/runs/${run.runId}/feedback`, payload: { scope, thumb: 'up', comment: '  ', issueTags: ['helpful', 'helpful'] } });
    expect(updated.json().feedback).toMatchObject({ id: saved.json().feedback.id, thumb: 'up', issueTags: ['helpful'], createdAt: saved.json().feedback.createdAt });
    expect(updated.json().feedback.rating).toBeUndefined(); expect(updated.json().feedback.comment).toBeUndefined();
    const status = await server.inject({ method: 'GET', url: '/operations/status?tenantId=tenant&workspaceId=workspace&days=30' });
    expect(status.json().status.summary).toMatchObject({ runCount: 1, failureRate: 0, totalTokens: 150, estimatedCost: 0.0002, pricedRunCount: 1, feedbackRate: 1 });

    const defaults = await server.inject({ method: 'GET', url: '/operations/retention?tenantId=tenant&workspaceId=workspace' });
    expect(defaults.json().policy).toMatchObject({ payloadDays: 30, traceDays: 14, aggregateDays: 365 });
    const malformed = await server.inject({ method: 'PUT', url: '/operations/retention', payload: { scope, payloadDays: -1 } });
    expect(malformed.statusCode).toBe(400);
    await server.inject({ method: 'PUT', url: '/operations/retention', payload: { scope, payloadDays: 0, traceDays: 0, aggregateDays: 365 } });
    const applied = await server.inject({ method: 'POST', url: '/operations/retention/apply', payload: { scope } });
    expect(applied.json().result).toMatchObject({ deleted: 1, feedbackDeleted: 1, aggregateBucketsDeleted: 0 });
    const trace = await server.inject({ method: 'GET', url: `/runs/${run.runId}/trace?tenantId=tenant&workspaceId=workspace` });
    expect(trace.statusCode).toBe(404);
    const feedback = await server.inject({ method: 'GET', url: `/runs/${run.runId}/feedback?tenantId=tenant&workspaceId=workspace` });
    expect(feedback.json()).toEqual({ feedback: null });
    const aggregate = await server.inject({ method: 'GET', url: '/operations/status?tenantId=tenant&workspaceId=workspace&days=30' });
    expect(aggregate.json().status.summary.runCount).toBe(1);
  });

  it('Telemetry adapter停止と未知model価格をRun失敗へ伝播させない', async () => {
    await server.close(); app.close();
    const failingTelemetry: TelemetryPort = { startSpan: () => { throw new Error('exporter unavailable'); } };
    model = new ScriptedModelProvider();
    app = createApp({ profile: 'test', modelProvider: model, telemetry: failingTelemetry, modelSnapshot: { provider: 'unknown', model: 'unknown', modelConfigHash: 'hash' } }); server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    await app.saveAgent.execute({ scope, internalId: 'agent-2', workingName: 'agent', displayName: 'Agent', publishName: 'agent_2', owner: 'owner', kind: 'normal', systemPrompt: 'Answer.', tools: [] });
    model.enqueue({ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
    const response = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'agent-2', version: SemVer.parse('1.0.0').toString() }, message: 'hello', mode: 'preview' } });
    expect(response.statusCode).toBe(200); expect(response.json().run.estimatedCost).toBeUndefined();
  });

  it('揮発DB配線ではバックアップを拒否し、一覧は空で返す', async () => {
    const created = await server.inject({ method: 'POST', url: '/operations/backups', payload: {} });
    expect(created.statusCode).toBe(400);
    expect(created.json().error).toMatchObject({ code: 'BACKUP_VALIDATION' });
    expect(created.json().error.message).toMatch(/in-memory/);
    const listed = await server.inject({ method: 'GET', url: '/operations/backups' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().backups).toEqual([]);
    expect(typeof listed.json().root).toBe('string');
  });
});

describe('backup API (永続DB配線)', () => {
  let directory: string; let app: App; let server: FastifyInstance;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'agentblume-backup-api-'));
    writeFileSync(join(directory, 'secret.key'), `${Buffer.alloc(32, 7).toString('base64')}\n`, 'utf8');
    app = createApp({
      profile: 'local',
      dbPath: join(directory, 'agentblume.db'),
      backupRoot: join(directory, 'backups'),
      // 実ホームの鍵ファイルをテストが読まないよう、鍵の場所を一時ディレクトリへ固定する。
      secretCipher: new AesGcmSecretCipher({ keyPath: join(directory, 'secret.key') }),
      modelProvider: new ScriptedModelProvider(),
      judgeModelProvider: new ScriptedModelProvider(),
    });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
    await app.saveAgent.execute({ scope, internalId: 'agent', workingName: 'agent', displayName: 'Agent', publishName: 'agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer.', tools: [] });
  });
  afterEach(async () => { await server.close(); app.close(); rmSync(directory, { recursive: true, force: true }); });

  it('作成→一覧を縦断し、既定では鍵を含めない', async () => {
    const created = await server.inject({ method: 'POST', url: '/operations/backups', payload: {} });
    expect(created.statusCode).toBe(200);
    const backup = created.json().backup;
    expect(backup.name).toMatch(/^backup-\d{8}-\d{9}$/);
    expect(backup.manifest).toMatchObject({ formatVersion: 1, schemaVersion: 2, secretKey: { included: false } });
    expect(backup.manifest.database.bytes).toBeGreaterThan(0);
    expect(backup.warnings.join(' ')).toMatch(/NOT included/);

    // マニフェストとDBが実際に置かれている（応答だけでなくファイルとして残る）。
    const manifest = JSON.parse(await readFile(join(backup.path, 'manifest.json'), 'utf8')) as { schemaVersion: number };
    expect(manifest.schemaVersion).toBe(2);

    const listed = await server.inject({ method: 'GET', url: '/operations/backups' });
    expect(listed.json().root).toBe(join(directory, 'backups'));
    expect(listed.json().backups).toHaveLength(1);
    expect(listed.json().backups[0]).toMatchObject({ name: backup.name, manifest: { schemaVersion: 2 } });
  });

  it('includeSecretKey=true のときだけ鍵を同梱し、マニフェストに記録する', async () => {
    const created = await server.inject({ method: 'POST', url: '/operations/backups', payload: { includeSecretKey: true } });
    expect(created.statusCode).toBe(200);
    expect(created.json().backup.manifest.secretKey).toEqual({ included: true, file: 'secret.key' });
    expect(created.json().backup.warnings.join(' ')).toMatch(/plaintext API keys/);
    expect(await readFile(join(created.json().backup.path, 'secret.key'), 'utf8')).toContain(Buffer.alloc(32, 7).toString('base64'));
  });

  it('不正な body は 400（includeSecretKey は真偽値だけ受ける）', async () => {
    const response = await server.inject({ method: 'POST', url: '/operations/backups', payload: { includeSecretKey: 'yes' } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
  });

  it('バックアップとリストアが往復する（アーティファクトの実体も戻る）', async () => {
    const artifacts = join(directory, 'agentblume.db.session-artifacts', 'scope');
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, 'payload.json'), '{"rows":[1,2,3]}', 'utf8');

    const created = await server.inject({ method: 'POST', url: '/operations/backups', payload: {} });
    const backupPath = created.json().backup.path as string;
    expect(created.json().backup.manifest.artifacts.files).toBe(1);

    // 復元はHTTPからは行わない（稼働中プロセスの足元でファイルを差し替えないため）。
    // ここではCLIと同じ手順（サーバー停止 → restore）を再現する。
    const restoreBackup = app.restoreBackup;
    await server.close();
    app.close();
    writeFileSync(join(artifacts, 'payload.json'), 'corrupted', 'utf8');

    const restored = await restoreBackup.execute(backupPath);
    expect(restored.database.bytes).toBeGreaterThan(0);
    expect(restored.movedAside.length).toBe(2);
    expect(await readFile(join(artifacts, 'payload.json'), 'utf8')).toBe('{"rows":[1,2,3]}');

    // 戻したDBを開き直すと、バックアップ時点のAgentがそのまま読める。
    const reopened = createApp({ profile: 'local', dbPath: join(directory, 'agentblume.db'), modelProvider: new ScriptedModelProvider(), judgeModelProvider: new ScriptedModelProvider() });
    try { expect((await reopened.queryAgents.list(scope)).map((agent) => agent.internalId)).toContain('agent'); }
    finally { reopened.close(); }

    // afterEach の二重 close を避けるため、閉じ済みの App を差し替える。
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(scope) });
  });
});
