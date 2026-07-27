import { describe, expect, it } from 'vitest';
import { InMemoryModelSettingsRepository } from '../../adapters/storage/in-memory-model-settings-repository';
import { ModelSettingsValidationError } from '../../domain/model-settings/errors';
import { secretHint } from '../../domain/model-settings/sealed-secret';
import { GetModelSettingsUseCase, SaveModelSettingsUseCase } from './manage-model-settings';
import type { SecretCipherPort } from './secret-cipher';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

class FakeCipher implements SecretCipherPort {
  sealed: string[] = [];
  async seal(plaintext: string) {
    this.sealed.push(plaintext);
    return { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plaintext).toString('base64'), hint: plaintext.slice(-4) } as const;
  }
  async open(sealed: { data: string }): Promise<string> { return Buffer.from(sealed.data, 'base64').toString('utf8'); }
}

function make() {
  const repo = new InMemoryModelSettingsRepository();
  const cipher = new FakeCipher();
  const now = () => new Date('2026-07-26T00:00:00.000Z');
  return { repo, cipher, get: new GetModelSettingsUseCase(repo), save: new SaveModelSettingsUseCase(repo, cipher, now) };
}

describe('GetModelSettingsUseCase', () => {
  it('未保存ならスコープだけを返す（= env 既定を使う）', async () => {
    const { get } = make();
    expect(await get.execute(scope)).toEqual({ scope, storage: 'persistent' });
  });

  it('揮発ストレージ運用は storage:"ephemeral" を返す（UIが再起動で消えると警告できる）', async () => {
    const repo = new InMemoryModelSettingsRepository();
    expect(await new GetModelSettingsUseCase(repo, 'ephemeral').execute(scope)).toEqual({ scope, storage: 'ephemeral' });
  });

  it('APIキーはマスク（configured + 末尾4文字）だけを返し、封緘済みデータも返さない', async () => {
    const { get, save, cipher } = make();
    await save.execute({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: 'sk-super-secret-1234' },
      judge: { source: 'registry', model: 'openai/gpt-4o-mini' },
    });

    const view = await get.execute(scope);

    expect(view).toEqual({
      scope,
      main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', apiKey: { configured: true, hint: '1234' } },
      judge: { source: 'registry', model: 'openai/gpt-4o-mini', apiKey: { configured: false } },
      updatedAt: '2026-07-26T00:00:00.000Z',
      storage: 'persistent',
    });
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('sk-super-secret-1234');
    expect(serialized).not.toContain('aes-256-gcm');
    expect(serialized).not.toContain(Buffer.from('sk-super-secret-1234').toString('base64'));
    expect(cipher.sealed).toEqual(['sk-super-secret-1234']);
  });
});

describe('SaveModelSettingsUseCase', () => {
  it('apiKey 省略は既存キーを維持する（同じ宛先のとき）', async () => {
    const { save, repo } = make();
    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-keep-me-5678' } });

    const view = await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o-mini' } });

    expect(view.main?.apiKey).toEqual({ configured: true, hint: '5678' });
    expect((await repo.find(scope))?.main?.apiKey?.data).toBe(Buffer.from('sk-keep-me-5678').toString('base64'));
  });

  it('apiKey 空文字（および null）はキーをクリアする', async () => {
    const { save } = make();
    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-remove-me-1111' } });

    expect((await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: '' } })).main?.apiKey).toEqual({ configured: false });

    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-again-2222' } });
    expect((await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: null } })).main?.apiKey).toEqual({ configured: false });
  });

  it('スロット省略は変更なし、null は設定を消して env 既定へ戻す', async () => {
    const { save, repo } = make();
    await save.execute({
      scope,
      main: { source: 'registry', model: 'openai/gpt-4o' },
      judge: { source: 'registry', model: 'openai/gpt-4o-mini' },
    });

    // judge だけ更新しても main は残る。
    const kept = await save.execute({ scope, judge: { source: 'registry', model: 'openai/o4-mini' } });
    expect(kept.main).toEqual({ source: 'registry', model: 'openai/gpt-4o', apiKey: { configured: false } });
    expect(kept.judge?.model).toBe('openai/o4-mini');

    const cleared = await save.execute({ scope, main: null });
    expect(cleared.main).toBeUndefined();
    expect((await repo.find(scope))?.main).toBeUndefined();
    expect(cleared.judge?.model).toBe('openai/o4-mini');
  });

  it('ドメイン検証違反はそのまま伝える（保存しない）', async () => {
    const { save, repo } = make();
    await expect(save.execute({ scope, main: { source: 'registry', model: 'gpt-4o' } })).rejects.toThrow(ModelSettingsValidationError);
    await expect(save.execute({ scope, main: { source: 'openai-compatible', model: 'm' } })).rejects.toThrow(ModelSettingsValidationError);
    expect(await repo.find(scope)).toBeNull();
  });

  it('source を切り替えたらキーは継承しない（別プロバイダへキーを送らない）', async () => {
    const { save } = make();
    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-shared-4321' } });

    const view = await save.execute({ scope, main: { source: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o' } });

    expect(view.main).toEqual({ source: 'openai-compatible', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', apiKey: { configured: false } });
  });

  it('openai-compatible の baseUrl を変えたらキーは継承しない', async () => {
    const { save, repo } = make();
    await save.execute({ scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: 'sk-lmstudio-1111' } });

    const moved = await save.execute({ scope, main: { source: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' } });
    expect(moved.main?.apiKey).toEqual({ configured: false });
    expect((await repo.find(scope))?.main?.apiKey).toBeUndefined();

    // 末尾スラッシュ・大文字小文字の違いは同じ宛先なので維持する。
    await save.execute({ scope, main: { source: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local', apiKey: 'sk-lmstudio-1111' } });
    const same = await save.execute({ scope, main: { source: 'openai-compatible', baseUrl: 'HTTP://127.0.0.1:1234/V1/', model: 'local-2' } });
    expect(same.main?.apiKey).toEqual({ configured: true, hint: '1111' });
  });

  it('registry の provider 接頭辞を変えたらキーは継承しない（モデル違いだけなら維持）', async () => {
    const { save } = make();
    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-openai-2222' } });

    const switched = await save.execute({ scope, main: { source: 'registry', model: 'anthropic/claude-sonnet-4-5' } });
    expect(switched.main?.apiKey).toEqual({ configured: false });

    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'sk-openai-2222' } });
    const kept = await save.execute({ scope, main: { source: 'registry', model: 'openai/o4-mini' } });
    expect(kept.main?.apiKey).toEqual({ configured: true, hint: '2222' });
  });

  it('スロットを1つも指定しない保存は no-op（updatedAt を進めず、空行も作らない）', async () => {
    const { save, repo } = make();

    expect(await save.execute({ scope })).toEqual({ scope });
    expect(await repo.find(scope)).toBeNull();

    await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o' } });
    const before = await repo.find(scope);
    const view = await save.execute({ scope });
    expect(view.updatedAt).toBe(before?.updatedAt);
    expect(await repo.find(scope)).toEqual(before);
  });

  it('空文字キーの hint は返さない（configured のみ）', async () => {
    const { save } = make();
    // 空白のみのキーはクリア扱い。
    expect((await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: '   ' } })).main?.apiKey).toEqual({ configured: false });
  });

  it('hint が空のキーは configured だけを返す（短いキーで平文を露出させない）', async () => {
    const repo = new InMemoryModelSettingsRepository();
    // 実装（secretHint）と同じく、4文字以下の平文では hint を作らない暗号器。
    const shortHintCipher: SecretCipherPort = {
      async seal(plaintext) { return { v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: Buffer.from(plaintext).toString('base64'), hint: secretHint(plaintext) } as const; },
      async open(sealed) { return Buffer.from(sealed.data, 'base64').toString('utf8'); },
    };
    const save = new SaveModelSettingsUseCase(repo, shortHintCipher, () => new Date('2026-07-26T00:00:00.000Z'));

    const view = await save.execute({ scope, main: { source: 'registry', model: 'openai/gpt-4o', apiKey: 'ab' } });

    expect(view.main?.apiKey).toEqual({ configured: true });
    expect(JSON.stringify(view)).not.toContain('ab"');
  });
});
