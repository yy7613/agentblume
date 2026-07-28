/**
 * Composition Root のテスト（v3 実装契約 §3）
 *
 * composition 自身のテストなので adapters / application を import してよい。
 * env の検証は vi.stubEnv を使う（afterEach で全て解除）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultDatabasePath } from '../adapters/storage/sqlite-database';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteUnitOfWork } from '../adapters/storage/sqlite-unit-of-work';
import { NoopUnitOfWork } from '../application/persistence/unit-of-work';
import { ReviewProposalUseCase } from '../application/memory/review-proposal';
import { createMemoryProposal } from '../domain/memory/memory-proposal';
import type { MemoryProposalRepository } from '../domain/memory/memory-proposal-repository';
import { InMemoryToolRepository } from '../adapters/storage/in-memory-tool-repository';
import { SqliteToolRepository } from '../adapters/storage/sqlite-tool-repository';
import { MastraModelProvider } from '../adapters/model/mastra-model-provider';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { SwitchableModelProvider } from '../application/model-settings/switchable-model-provider';
import { AesGcmSecretCipher } from '../adapters/security/aes-gcm-secret-cipher';
import type { ModelProviderFactoryPort, ResolvedSlotOptions } from '../application/model-settings/model-provider-factory';
import type { ModelCompletion, ModelProviderPort } from '../application/model/model-provider';
import { InMemoryRunRepository } from '../adapters/storage/in-memory-run-repository';
import { SqliteRunRepository } from '../adapters/storage/sqlite-run-repository';
import type { ToolGraph } from '../domain/etl/graph';
import { ToolValidationError } from '../domain/tool/errors';
import type { TenantScope } from '../domain/tool/ids';
import { beginFactoryRun, DEFAULT_FACTORY_OPTIONS, startFactoryRun, type FactoryRun } from '../domain/factory/factory-run';
import { createExperiment, startExperiment } from '../domain/evaluation/experiment';
import { SemVer } from '../domain/tool/semver';
import { createApp, resolveDatabasePath } from './root';
import type { App } from './root';

const scope: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

/**
 * 配線結果の確認のため、SwitchableModelProvider が現在保持しているアダプタ
 * （env既定から作った MastraModelProvider）の内部設定を読む（composition の責務検証に閉じる）。
 */
function modelConfig(provider: unknown): { timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } } {
  const current = (provider as { current: { provider: unknown } }).current.provider;
  expect(current).toBeInstanceOf(MastraModelProvider);
  return current as { timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } };
}

const graph: ToolGraph = {
  nodes: [
    { id: 'src', type: 'json-source', config: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    { id: 'flt', type: 'filter', config: { column: 'a', op: 'gte', value: 2 } },
  ],
  edges: [{ from: 'src', to: 'flt' }],
};

/** save→preview の縦切り往復（保存された Tool をプレビューし行を検証）。 */
async function roundTrip(app: App): Promise<void> {
  const saved = await app.saveTool.execute({
    scope,
    internalId: 'tool-1',
    workingName: 'working',
    displayName: 'Display',
    publishName: 'publish_name',
    owner: 'owner@example.com',
    sideEffect: 'read-only',
    graph,
  });
  expect(saved.metadata.version.toString()).toBe('1.0.0');

  const { tool, result } = await app.previewTool.preview(scope, 'tool-1');
  expect(tool.metadata.version.toString()).toBe('1.0.0');
  expect(result.output.rows).toEqual([{ a: 2 }, { a: 3 }]);

  const versions = await app.listToolVersions.execute(scope, 'tool-1');
  expect(versions.map((v) => v.toString())).toEqual(['1.0.0']);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createApp', () => {
  it("test プロファイル: InMemory リポジトリで save→preview 縦切り往復できる", async () => {
    const app = createApp({ profile: 'test' });

    expect(app.profile).toBe('test');
    expect(app.repo).toBeInstanceOf(InMemoryToolRepository);
    expect(app.modelProvider).toBeInstanceOf(ScriptedModelProvider);
    expect(app.judgeModelProvider).toBeInstanceOf(ScriptedModelProvider);
    expect(app.judgeModelProvider).not.toBe(app.modelProvider);
    expect(app.judgeEvaluator.snapshot()).toMatchObject({ provider: 'scripted-judge', model: 'scripted-judge' });
    expect(app.runRepo).toBeInstanceOf(InMemoryRunRepository);
    await roundTrip(app);
    app.close(); // InMemory は no-op（例外なし）。
  });

  it("local プロファイル + ':memory:': sqlite 実路で同往復できる", async () => {
    const app = createApp({ profile: 'local', dbPath: ':memory:' });

    expect(app.profile).toBe('local');
    expect(app.repo).toBeInstanceOf(SqliteToolRepository);
    expect(app.modelProvider).toBeInstanceOf(SwitchableModelProvider);
    expect(app.runRepo).toBeInstanceOf(SqliteRunRepository);
    await roundTrip(app);
    app.close();
  });

  it('local の dbPath 既定は ~/.agentblume/agentblume.db（揮発しない）', () => {
    // 実際にホームへ書かないよう、解決だけを検証する（起動すると本物のDBが作られるため）。
    expect(resolveDatabasePath(undefined)).toBe(join(homedir(), '.agentblume', 'agentblume.db'));
    expect(defaultDatabasePath('/home/example')).toBe(join('/home/example', '.agentblume', 'agentblume.db'));
  });

  it('空文字の AGENTCONTEXT_DB_PATH は未設定として扱う（黙って揮発させない）', () => {
    vi.stubEnv('AGENTCONTEXT_DB_PATH', '   ');
    expect(resolveDatabasePath(undefined)).toBe(defaultDatabasePath());
  });

  it('env AGENTCONTEXT_DB_PATH / options.dbPath が既定より優先される', () => {
    vi.stubEnv('AGENTCONTEXT_DB_PATH', '/tmp/from-env.db');
    expect(resolveDatabasePath(undefined)).toBe('/tmp/from-env.db');
    expect(resolveDatabasePath(':memory:')).toBe(':memory:');
  });

  it('保存先を起動時にログへ出す（既定解決時のみ・揮発は警告文言）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentcontext-root-log-'));
    try {
      const messages: string[] = [];
      vi.stubEnv('AGENTCONTEXT_DB_PATH', join(dir, 'logged.db'));
      createApp({ profile: 'local', logger: (message) => messages.push(message) }).close();
      expect(messages).toEqual([`agentblume: database file = ${join(dir, 'logged.db')}`]);

      messages.length = 0;
      vi.stubEnv('AGENTCONTEXT_DB_PATH', ':memory:');
      createApp({ profile: 'local', logger: (message) => messages.push(message) }).close();
      expect(messages[0]).toMatch(/EPHEMERAL/);

      // options.dbPath を明示した埋め込み・テスト利用ではログを出さない。
      messages.length = 0;
      createApp({ profile: 'local', dbPath: ':memory:', logger: (message) => messages.push(message) }).close();
      expect(messages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close() は往復後も例外なく完了する', async () => {
    const local = createApp({ profile: 'local', dbPath: ':memory:' });
    await roundTrip(local);
    expect(() => local.close()).not.toThrow();

    const test = createApp({ profile: 'test' });
    await roundTrip(test);
    expect(() => test.close()).not.toThrow();
  });

  describe('モデル設定の切替（v34）', () => {
    /** 生成されたアダプタの設定を記録するだけの工場。 */
    class RecordingFactory implements ModelProviderFactoryPort {
      readonly created: ResolvedSlotOptions[] = [];
      create(options: ResolvedSlotOptions): ModelProviderPort {
        this.created.push(options);
        return {
          async complete(): Promise<ModelCompletion> { return { message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }; },
          capabilities: () => ['chat', 'tool-calling', 'structured-output', 'vision'],
        };
      }
    }

    function switchableApp(factory: ModelProviderFactoryPort): App {
      return createApp({ profile: 'local', dbPath: ':memory:', modelProviderFactory: factory, secretCipher: AesGcmSecretCipher.ephemeral(), modelSettingsScope: scope });
    }

    it('設定未保存なら env 既定（LM_STUDIO_*）で解決する', async () => {
      vi.stubEnv('LM_STUDIO_BASE_URL', 'http://127.0.0.1:4321/v1');
      vi.stubEnv('LM_STUDIO_MODEL', 'env-model');
      vi.stubEnv('JUDGE_LM_STUDIO_MODEL', 'env-judge-model');
      const factory = new RecordingFactory();
      const app = switchableApp(factory);

      try {
        expect(app.modelProvider).toBeInstanceOf(SwitchableModelProvider);
        expect(app.judgeModelProvider).toBeInstanceOf(SwitchableModelProvider);
        expect(await (app.modelProvider as SwitchableModelProvider).currentSnapshot()).toMatchObject({ provider: 'openai-compatible', model: 'env-model' });
        expect(await (app.judgeModelProvider as SwitchableModelProvider).currentSnapshot()).toMatchObject({ provider: 'openai-compatible', model: 'env-judge-model' });
        expect(factory.created[0]?.model).toMatchObject({ id: 'env-model', url: 'http://127.0.0.1:4321/v1' });
      } finally { app.close(); }
    });

    it('保存した設定が次のリクエストから反映され、Run記録の指紋も実行時点の設定になる', async () => {
      const factory = new RecordingFactory();
      const app = switchableApp(factory);

      try {
        await roundTrip(app);
        await app.saveModelSettings.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-root-test-1234' } });

        const run = await app.runAgentPreview.execute({ scope, toolId: 'tool-1', systemPrompt: 'system', message: 'hello', mode: 'preview' });

        expect(run.model).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
        expect(factory.created.at(-1)?.model).toEqual({ id: 'openai/gpt-4o', apiKey: 'sk-root-test-1234' });

        // 保存済みRunにも同じ指紋が残る（観測・再現性の記録）。
        const stored = await app.queryRuns.get(scope, run.runId);
        expect(stored.model).toMatchObject({ provider: 'openai', model: 'gpt-4o' });

        // マスク済みDTOには平文キーが出ない。
        expect(JSON.stringify(await app.getModelSettings.execute(scope))).not.toContain('sk-root-test-1234');
      } finally { app.close(); }
    });

    it('明示 modelProvider 注入時は従来どおり固定配線（切替対象外）', () => {
      const app = createApp({ profile: 'local', dbPath: ':memory:', modelProvider: new ScriptedModelProvider(), judgeModelProvider: new ScriptedModelProvider() });
      try {
        expect(app.modelProvider).toBeInstanceOf(ScriptedModelProvider);
        expect(app.judgeEvaluator.snapshot()).toMatchObject({ provider: 'lm-studio-judge' });
      } finally { app.close(); }
    });
  });

  describe('env との優先順位', () => {
    it('env AGENTCONTEXT_PROFILE=test が既定として使われる', () => {
      vi.stubEnv('AGENTCONTEXT_PROFILE', 'test');

      const app = createApp();

      expect(app.profile).toBe('test');
      expect(app.repo).toBeInstanceOf(InMemoryToolRepository);
      app.close();
    });

    it('env AGENTCONTEXT_PROFILE=local が既定として使われる', () => {
      vi.stubEnv('AGENTCONTEXT_PROFILE', 'local');

      const app = createApp({ dbPath: ':memory:' });

      expect(app.profile).toBe('local');
      expect(app.repo).toBeInstanceOf(SqliteToolRepository);
      app.close();
    });

    it('options.profile が env より優先される', () => {
      vi.stubEnv('AGENTCONTEXT_PROFILE', 'local');

      const app = createApp({ profile: 'test' });

      expect(app.profile).toBe('test');
      expect(app.repo).toBeInstanceOf(InMemoryToolRepository);
      app.close();
    });

    it('env 未設定なら profile は local が既定', () => {
      vi.stubEnv('AGENTCONTEXT_PROFILE', undefined);

      const app = createApp({ dbPath: ':memory:' });

      expect(app.profile).toBe('local');
      expect(app.repo).toBeInstanceOf(SqliteToolRepository);
      app.close();
    });

    it('不正な env profile → ToolValidationError（メッセージに値を含む）', () => {
      vi.stubEnv('AGENTCONTEXT_PROFILE', 'staging');

      expect(() => createApp()).toThrow(ToolValidationError);
      expect(() => createApp()).toThrow(/staging/);
    });

    it.each([
      ['LM_STUDIO_TIMEOUT_MS', 'not-a-number'],
      ['LM_STUDIO_TIMEOUT_MS', '0'],
      ['LM_STUDIO_IDLE_TIMEOUT_MS', 'soon'],
      ['LM_STUDIO_IDLE_TIMEOUT_MS', '-1'],
      ['LM_STUDIO_MAX_TOKENS', '1.5'],
      ['LM_STUDIO_MAX_TOKENS', '0'],
    ])('不正な %s（"%s"）を拒否する', (name, value) => {
      vi.stubEnv(name, value);
      expect(() => createApp({ profile: 'local', dbPath: ':memory:' })).toThrow(ToolValidationError);
      expect(() => createApp({ profile: 'local', dbPath: ':memory:' })).toThrow(new RegExp(name));
    });

    it('LM Studio の timeout / idle timeout / max tokens を両providerへ配線する', () => {
      vi.stubEnv('LM_STUDIO_TIMEOUT_MS', '300000');
      vi.stubEnv('LM_STUDIO_IDLE_TIMEOUT_MS', '15000');
      vi.stubEnv('LM_STUDIO_MAX_TOKENS', '4096');

      const app = createApp({ profile: 'local', dbPath: ':memory:' });

      for (const provider of [app.modelProvider, app.judgeModelProvider]) {
        expect(modelConfig(provider)).toMatchObject({ timeoutMs: 300_000, idleTimeoutMs: 15_000 });
        expect(modelConfig(provider).options.maxTokens).toBe(4096);
      }
      app.close();
    });

    it('timeout 既定は600秒 / idle 既定は60秒、max tokens 未設定なら送らない', () => {
      vi.stubEnv('LM_STUDIO_TIMEOUT_MS', undefined);
      vi.stubEnv('LM_STUDIO_IDLE_TIMEOUT_MS', undefined);
      vi.stubEnv('LM_STUDIO_MAX_TOKENS', undefined);

      const app = createApp({ profile: 'local', dbPath: ':memory:' });

      expect(modelConfig(app.modelProvider)).toMatchObject({ timeoutMs: 600_000, idleTimeoutMs: 60_000 });
      expect(modelConfig(app.modelProvider).options.maxTokens).toBeUndefined();
      expect(modelConfig(app.judgeModelProvider).options.maxTokens).toBeUndefined();
      app.close();
    });

    it('env AGENTCONTEXT_DB_PATH が dbPath 既定として使われる（ファイルへ永続化される）', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentcontext-root-test-'));
      const dbPath = join(dir, 'env.db');
      vi.stubEnv('AGENTCONTEXT_DB_PATH', dbPath);

      try {
        const first = createApp({ profile: 'local', logger: () => {} });
        await roundTrip(first);
        first.close();

        // 同じ env パスで開き直すと保存済み Tool が見える = env パスが使われた証明。
        const second = createApp({ profile: 'local', logger: () => {} });
        const tool = await second.getTool.latest(scope, 'tool-1');
        expect(tool.metadata.version.toString()).toBe('1.0.0');
        second.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('options.dbPath が env AGENTCONTEXT_DB_PATH より優先される', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agentcontext-root-test-'));
      const envPath = join(dir, 'env.db');
      const optionPath = join(dir, 'option.db');
      vi.stubEnv('AGENTCONTEXT_DB_PATH', envPath);

      try {
        const app = createApp({ profile: 'local', dbPath: optionPath });
        await roundTrip(app);
        app.close();

        // options のパスに保存されている。
        const fromOption = createApp({ profile: 'local', dbPath: optionPath });
        await expect(fromOption.getTool.latest(scope, 'tool-1')).resolves.toBeDefined();
        fromOption.close();

        // env のパスには保存されていない。
        const fromEnv = createApp({ profile: 'local', dbPath: envPath });
        await expect(fromEnv.repo.findLatest(scope, 'tool-1')).resolves.toBeNull();
        fromEnv.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('永続化基盤（共有接続 / マイグレーション / トランザクション）', () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'agentcontext-persistence-'));
      dbPath = join(dir, 'agentblume.db');
    });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('local は全リポジトリで1本の接続を共有する（接続分裂を作り直さない）', () => {
      const app = createApp({ profile: 'local', dbPath });
      try {
        const handle = (repository: unknown): unknown => (repository as { database: { handle: unknown } }).database.handle;
        const shared = handle(app.repo);
        for (const repository of [app.runRepo, app.agentRepo, app.skillRepo, app.wikiRepo, app.sessionRepo, app.modelSettingsRepo, app.operationsRepo]) {
          expect(handle(repository)).toBe(shared);
        }
        expect(app.dbPath).toBe(dbPath);
        expect(app.unitOfWork).toBeInstanceOf(SqliteUnitOfWork);
      } finally {
        app.close();
      }
    });

    it('test プロファイルはトランザクション非対応の恒等実装を配線する', () => {
      const app = createApp({ profile: 'test' });
      expect(app.unitOfWork).toBeInstanceOf(NoopUnitOfWork);
      expect(app.dbPath).toBeUndefined();
      app.close();
    });

    it('旧スキーマのDBファイルでも起動でき、保存済みデータを読み続けられる', async () => {
      const first = createApp({ profile: 'local', dbPath });
      await roundTrip(first);
      first.close();

      // 旧DB（deleted列が無い）を再現する。この状態のままでは findLatest / list が動かない。
      const legacy = new DatabaseSync(dbPath);
      legacy.exec('ALTER TABLE tools DROP COLUMN deleted');
      legacy.exec('PRAGMA user_version = 0');
      legacy.close();

      const second = createApp({ profile: 'local', dbPath });
      try {
        const tool = await second.getTool.latest(scope, 'tool-1');
        expect(tool.metadata.version.toString()).toBe('1.0.0');
        expect((await second.listTools.execute(scope)).map((summary) => summary.internalId)).toEqual(['tool-1']);
      } finally {
        second.close();
      }
    });

    it('ReviewProposal の承認は「実体の適用」と「提案の承認済み化」を一括でコミットする', async () => {
      const app = createApp({ profile: 'local', dbPath });
      try {
        const proposal = createMemoryProposal({
          id: 'proposal-1', tenant: scope, summary: 'add a page', createdAt: '2026-07-01T00:00:00.000Z',
          target: { kind: 'wiki', pageId: 'page-1', isNewPage: true, title: 'Cohort', tags: ['sql'], body: 'Filter adults.' },
        });
        await app.memoryProposalRepo.save(proposal);

        // 提案の状態遷移だけを失敗させる（Wikiページの保存はすでに終わっている状況）。
        const failingProposals: MemoryProposalRepository = {
          find: (s, id) => app.memoryProposalRepo.find(s, id),
          list: (s, state) => app.memoryProposalRepo.list(s, state),
          save: async () => { throw new Error('proposal store crashed'); },
        };
        const review = new ReviewProposalUseCase(failingProposals, app.saveWikiPage, app.skillRepo, app.saveSkill, app.unitOfWork);
        await expect(review.approve(scope, 'proposal-1')).rejects.toThrow('proposal store crashed');
        // トランザクションで括られているので、承認されていないページは残らない。
        expect(await app.wikiRepo.find(scope, 'page-1')).toBeNull();

        // 境界が無ければ（従来の挙動）ページだけが残り、再承認で二重に書かれる。
        const unguarded = new ReviewProposalUseCase(failingProposals, app.saveWikiPage, app.skillRepo, app.saveSkill, new NoopUnitOfWork());
        await expect(unguarded.approve(scope, 'proposal-1')).rejects.toThrow('proposal store crashed');
        expect(await app.wikiRepo.find(scope, 'page-1')).not.toBeNull();
      } finally {
        app.close();
      }
    });
  });

  describe('起動時の孤児Run回収（RecoverInterruptedRuns）', () => {
    /** 未実行の `queued` Factory Run と、固まった `running` Factory Run を1件ずつ入れる。 */
    async function seedInterrupted(app: App): Promise<void> {
      const make = (id: string): FactoryRun => startFactoryRun({
        id, scope,
        input: { goal: { goal: '売上の質問に答える', language: 'ja' }, dataSourceIds: [], options: DEFAULT_FACTORY_OPTIONS },
        startedAt: '2026-07-28T08:00:00.000Z',
      });
      await app.factoryRunRepo.save(beginFactoryRun(make('stuck')));
      await app.factoryRunRepo.save(make('queued'));
      await app.experimentRepo.create(startExperiment(createExperiment({
        id: 'stuck-experiment', scope, target: { agentId: 'agent', version: SemVer.of(1, 0, 0) },
        dataset: { id: 'set', version: SemVer.of(1, 0, 0) }, evaluatorProfile: { id: 'profile', version: SemVer.of(1, 0, 0) },
        repetitions: 1, status: 'queued', snapshot: { provider: 'p', model: 'm', modelConfigHash: 'h' },
        progress: { completed: 0, total: 1 }, createdAt: '2026-07-28T08:00:00.000Z',
      }), '2026-07-28T08:00:01.000Z'));
    }

    it('createApp 自身は状態を書き換えない（回収はエントリポイントが明示的に呼ぶ）', async () => {
      const app = createApp({ profile: 'test' });
      try {
        await seedInterrupted(app);
        // 同じ保存先で App をもう1つ作っても、既存Runの状態は変わらない。
        expect(await app.factoryRunRepo.find(scope, 'stuck')).toMatchObject({ status: 'running' });
        expect(await app.experimentRepo.find(scope, 'stuck-experiment')).toMatchObject({ status: 'running' });
      } finally {
        app.close();
      }
    });

    it('recoverInterruptedRuns が配線済みのリポジトリとワーカーへ届く', async () => {
      const app = createApp({ profile: 'test' });
      try {
        await seedInterrupted(app);

        const summary = await app.recoverInterruptedRuns.execute();

        expect(summary).toMatchObject({ factoryRunsFailed: 1, factoryRunsRequeued: 1, experimentsInterrupted: 1 });
        // running は retry できる終端（failed）へ、queued はそのまま（ワーカーが拾い直す）。
        expect(await app.factoryRunRepo.find(scope, 'stuck')).toMatchObject({ status: 'failed' });
        // 再投入された `queued` は**本物のワーカー**が拾って動き出す（配線が届いている証拠）。
        expect(await app.factoryRunRepo.find(scope, 'queued')).not.toMatchObject({ status: 'queued' });
        expect(await app.experimentRepo.find(scope, 'stuck-experiment')).toMatchObject({ status: 'interrupted', error: { code: 'PROCESS_INTERRUPTED' } });
      } finally {
        app.close();
      }
    });

    it('errorLogger は test プロファイルで無音、明示すればそれを使う', async () => {
      const warns: string[] = [];
      const app = createApp({ profile: 'test', errorLogger: { info: () => {}, warn: (message) => { warns.push(message); }, error: () => {} } });
      try {
        // 再投入で本物のワーカーが動き出すと非同期のログが混ざるため、ここは running のRunだけを置く。
        await app.factoryRunRepo.save(beginFactoryRun(startFactoryRun({
          id: 'stuck', scope,
          input: { goal: { goal: '売上の質問に答える', language: 'ja' }, dataSourceIds: [], options: DEFAULT_FACTORY_OPTIONS },
          startedAt: '2026-07-28T08:00:00.000Z',
        })));
        app.factoryRunRepo.save = async (): Promise<void> => { throw new Error('disk is full'); };

        const summary = await app.recoverInterruptedRuns.execute();

        expect(summary.failures).toBe(1);
        expect(warns).toEqual(['failed to recover factory run']);
      } finally {
        app.close();
      }
    });
  });
});
