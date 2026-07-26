import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SecretCipherError } from '../../application/model-settings/secret-cipher';
import { AesGcmSecretCipher, SECRET_KEY_FILE_NAME, resolveSecretKeyPath } from './aes-gcm-secret-cipher';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentblume-cipher-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AesGcmSecretCipher', () => {
  it('seal→open で往復し、暗号文には平文が現れない', async () => {
    const cipher = new AesGcmSecretCipher({ keyPath: join(tempDir(), 'secret.key') });
    const secret = 'sk-live-abcdefghijklmnop-1234';

    const sealed = await cipher.seal(secret);

    expect(sealed).toMatchObject({ v: 1, alg: 'aes-256-gcm', hint: '1234' });
    expect(JSON.stringify(sealed)).not.toContain(secret);
    expect(Buffer.from(sealed.data, 'base64').toString('utf8')).not.toContain('sk-live');
    expect(await cipher.open(sealed)).toBe(secret);
  });

  it('同じ平文でも毎回異なる暗号文になる（IVがランダム）', async () => {
    const cipher = new AesGcmSecretCipher({ keyPath: join(tempDir(), 'secret.key') });
    const first = await cipher.seal('same-secret-value');
    const second = await cipher.seal('same-secret-value');
    expect(first.iv).not.toBe(second.iv);
    expect(first.data).not.toBe(second.data);
    expect(await cipher.open(second)).toBe('same-secret-value');
  });

  it('改竄（tag / data の差し替え）を検知して SecretCipherError にする', async () => {
    const cipher = new AesGcmSecretCipher({ keyPath: join(tempDir(), 'secret.key') });
    const sealed = await cipher.seal('tamper-target-secret');

    await expect(cipher.open({ ...sealed, tag: Buffer.alloc(16).toString('base64') })).rejects.toThrow(SecretCipherError);
    await expect(cipher.open({ ...sealed, data: Buffer.from('other payload').toString('base64') })).rejects.toThrow(SecretCipherError);
    // メッセージに秘密値も鍵も出さない。
    await expect(cipher.open({ ...sealed, tag: Buffer.alloc(16).toString('base64') })).rejects.toThrow(/Save the API key again/);
  });

  it('鍵ファイルを差し替えると復号できなくなる（再入力を促すエラー）', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'secret.key');
    const sealed = await new AesGcmSecretCipher({ keyPath }).seal('secret-value-1234');

    rmSync(keyPath);
    const replaced = new AesGcmSecretCipher({ keyPath });
    await replaced.seal('regenerate the key file');

    await expect(replaced.open(sealed)).rejects.toThrow(SecretCipherError);
  });

  it('鍵ファイルは初回利用時に自動生成され、以後は再利用される', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'nested', 'secret.key');
    const cipher = new AesGcmSecretCipher({ keyPath });

    // 生成しただけでは鍵ファイルを作らない（アプリ起動でホームを汚さない）。
    expect(existsSync(keyPath)).toBe(false);

    const sealed = await cipher.seal('lazy-key-secret');
    expect(existsSync(keyPath)).toBe(true);
    const material = readFileSync(keyPath, 'utf8').trim();
    expect(Buffer.from(material, 'base64')).toHaveLength(32);

    // 別インスタンス（プロセス再起動相当）でも同じ鍵で開封できる。
    expect(await new AesGcmSecretCipher({ keyPath }).open(sealed)).toBe('lazy-key-secret');
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(material);
  });

  it('壊れた鍵ファイルは SecretCipherError（鍵の中身は出さない）', async () => {
    const dir = tempDir();
    const keyPath = join(dir, 'secret.key');
    writeFileSync(keyPath, 'too-short', 'utf8');
    const cipher = new AesGcmSecretCipher({ keyPath });

    await expect(cipher.seal('x')).rejects.toThrow(/Secret key file is invalid/);
  });

  it('ephemeral() はファイルを使わない揮発鍵で動く', async () => {
    const cipher = AesGcmSecretCipher.ephemeral();
    expect(cipher.keyPath()).toBeUndefined();
    const sealed = await cipher.seal('volatile-secret');
    expect(await cipher.open(sealed)).toBe('volatile-secret');
    // 別インスタンス = 別の鍵なので復号できない。
    await expect(AesGcmSecretCipher.ephemeral().open(sealed)).rejects.toThrow(SecretCipherError);
  });

  it('空文字も往復でき、hint は空になる', async () => {
    const cipher = AesGcmSecretCipher.ephemeral();
    const sealed = await cipher.seal('');
    expect(sealed.hint).toBe('');
    expect(await cipher.open(sealed)).toBe('');
  });
});

describe('resolveSecretKeyPath', () => {
  it('AGENTCONTEXT_SECRET_KEY_PATH を最優先する', () => {
    const dir = tempDir();
    expect(resolveSecretKeyPath({ AGENTCONTEXT_SECRET_KEY_PATH: join(dir, 'k.key'), AGENTCONTEXT_DB_PATH: join(dir, 'db.sqlite') })).toBe(join(dir, 'k.key'));
  });

  it('未設定なら DB と同じディレクトリの鍵ファイル', () => {
    const dir = tempDir();
    expect(resolveSecretKeyPath({ AGENTCONTEXT_DB_PATH: join(dir, 'db.sqlite') })).toBe(join(dir, SECRET_KEY_FILE_NAME));
  });

  it('DBパスが無い / :memory: ならホーム配下へ退避する', () => {
    expect(resolveSecretKeyPath({})).toMatch(/[\\/]\.agentblume[\\/]secret\.key$/);
    expect(resolveSecretKeyPath({ AGENTCONTEXT_DB_PATH: ':memory:' })).toMatch(/[\\/]\.agentblume[\\/]secret\.key$/);
  });

  it('env 未指定のインスタンスは process.env のパスを使う', () => {
    const dir = tempDir();
    vi.stubEnv('AGENTCONTEXT_SECRET_KEY_PATH', join(dir, 'from-env.key'));
    expect(new AesGcmSecretCipher().keyPath()).toBe(join(dir, 'from-env.key'));
  });
});
