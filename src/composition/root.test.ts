/**
 * Composition Root のテスト（v3 実装契約 §3）
 *
 * composition 自身のテストなので adapters / application を import してよい。
 * env の検証は vi.stubEnv を使う（afterEach で全て解除）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryToolRepository } from '../adapters/storage/in-memory-tool-repository';
import { SqliteToolRepository } from '../adapters/storage/sqlite-tool-repository';
import { LmStudioModelProvider } from '../adapters/model/lm-studio-model-provider';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { InMemoryRunRepository } from '../adapters/storage/in-memory-run-repository';
import { SqliteRunRepository } from '../adapters/storage/sqlite-run-repository';
import type { ToolGraph } from '../domain/etl/graph';
import { ToolValidationError } from '../domain/tool/errors';
import type { TenantScope } from '../domain/tool/ids';
import { createApp } from './root';
import type { App } from './root';

const scope: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

/** 配線結果の確認のため LmStudioModelProvider の内部設定を読む（composition の責務検証に閉じる）。 */
function modelConfig(provider: unknown): { timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } } {
  return provider as { timeoutMs: number; idleTimeoutMs: number; options: { maxTokens?: number } };
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
    expect(app.modelProvider).toBeInstanceOf(LmStudioModelProvider);
    expect(app.runRepo).toBeInstanceOf(SqliteRunRepository);
    await roundTrip(app);
    app.close();
  });

  it('local の dbPath 既定は :memory:（dbPath 省略でも例外なく往復できる）', async () => {
    const app = createApp({ profile: 'local' });

    expect(app.repo).toBeInstanceOf(SqliteToolRepository);
    await roundTrip(app);
    app.close();
  });

  it('close() は往復後も例外なく完了する', async () => {
    const local = createApp({ profile: 'local', dbPath: ':memory:' });
    await roundTrip(local);
    expect(() => local.close()).not.toThrow();

    const test = createApp({ profile: 'test' });
    await roundTrip(test);
    expect(() => test.close()).not.toThrow();
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
        const first = createApp({ profile: 'local' });
        await roundTrip(first);
        first.close();

        // 同じ env パスで開き直すと保存済み Tool が見える = env パスが使われた証明。
        const second = createApp({ profile: 'local' });
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
});
