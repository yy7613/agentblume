import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AesGcmSecretCipher } from '../security/aes-gcm-secret-cipher';
import { createModelSettings } from '../../domain/model-settings/model-settings';
import { InMemoryModelSettingsRepository } from './in-memory-model-settings-repository';
import { modelSettingsRepositoryContract } from './model-settings-repository.contract';
import { SqliteModelSettingsRepository } from './sqlite-model-settings-repository';

describe.each([
  ['in-memory', () => ({ repo: new InMemoryModelSettingsRepository(), close: () => {} })],
  ['sqlite', () => { const repo = new SqliteModelSettingsRepository(); return { repo, close: () => repo.close() }; }],
])('%s model settings repository', (_name, make) => {
  it('共有契約を満たす', async () => {
    const { repo, close } = make();
    try { await modelSettingsRepositoryContract(repo); } finally { close(); }
  });
});

describe('SqliteModelSettingsRepository', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('DBファイルの生バイトに平文APIキーが現れない（封緘済みだけが保存される）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentblume-model-settings-'));
    dirs.push(dir);
    const dbPath = join(dir, 'settings.db');
    const secret = 'sk-plaintext-must-never-touch-disk-9876';
    const cipher = new AesGcmSecretCipher({ keyPath: join(dir, 'secret.key') });
    const repo = new SqliteModelSettingsRepository(dbPath);
    try {
      await repo.save(createModelSettings({
        scope: { tenantId: 'tenant', workspaceId: 'workspace' },
        main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: await cipher.seal(secret) },
        updatedAt: '2026-07-26T00:00:00.000Z',
      }));
    } finally { repo.close(); }

    const bytes = readFileSync(dbPath).toString('latin1');
    expect(bytes).not.toContain(secret);
    expect(bytes).not.toContain('sk-plaintext');
    // 設定そのものは読める（保存されていない、という偽陰性を防ぐ）。
    expect(bytes).toContain('local-model');
    // 末尾4文字のヒントだけは平文で保存される（マスク表示のため）。
    expect(bytes).toContain('"hint":"9876"');
  });
});
