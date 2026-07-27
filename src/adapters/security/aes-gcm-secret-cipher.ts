/**
 * adapters層: node:crypto の AES-256-GCM による秘密値の封緘・開封。
 *
 * 鍵は**鍵ファイル**（32バイトのランダム値をbase64で1行）に置く。初回利用時に自動生成し、
 * 以後は同じ鍵で復号する。DBとは別ファイルに分けることで、DBファイル単体が流出しても
 * 平文のAPIキーは復元できない。
 *
 * 鍵ファイルのパス解決:
 *   1. env `AGENTCONTEXT_SECRET_KEY_PATH`
 *   2. **後方互換**: 旧既定（env `AGENTCONTEXT_DB_PATH` と同じディレクトリの
 *      `agentblume.secret.key`）に鍵が**既に存在する**場合はそれを使う
 *   3. `os.homedir()/.agentblume/secret.key`（ディレクトリは自動作成）
 *
 * 既定を「DBと同じディレクトリ」から「ホーム配下」へ移したのは、鍵と暗号文が同じフォルダに
 * 同居すると、フォルダごとのZIP・同期・バックアップで**鍵と暗号文が一緒に運ばれてしまう**
 * ためである（DBだけが流出しても復号できない、という前提が崩れる）。
 *
 * 鍵・平文は**ログにもエラーメッセージにも出さない**。鍵ファイルの絶対パスも出さない
 * （ホームディレクトリ名＝利用者名が露出するため）。復旧手順が違うので失敗は2種類に分ける:
 * 鍵ファイルが読めない（`key-unavailable`）と、復号できない（`decrypt-failed`）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SecretCipherError, type SecretCipherPort } from '../../application/model-settings/secret-cipher';
import { createSealedSecret, secretHint, type SealedSecret } from '../../domain/model-settings/sealed-secret';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** 旧既定（DBと同じディレクトリ）で使っていたファイル名。移行のために読むだけ。 */
export const SECRET_KEY_FILE_NAME = 'agentblume.secret.key';
/** パスを含めずに原因だけを伝える文言（絶対パスは利用者名を含み得る）。 */
const KEY_UNAVAILABLE_MESSAGE = 'The secret key file could not be created or read. Check AGENTCONTEXT_SECRET_KEY_PATH.';

export interface AesGcmSecretCipherOptions {
  /** 明示的な鍵ファイルパス（env より優先）。 */
  readonly keyPath?: string;
  /** ファイルを使わずメモリ上の鍵で動かす（テスト・揮発運用）。 */
  readonly key?: Buffer;
  readonly env?: NodeJS.ProcessEnv;
}

/** 旧既定の置き場所（DBと同じディレクトリ）。移行判定にだけ使う。 */
export function legacySecretKeyPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dbPath = env['AGENTCONTEXT_DB_PATH']?.trim();
  if (dbPath === undefined || dbPath === '' || dbPath === ':memory:') return undefined;
  return join(dirname(resolve(dbPath)), SECRET_KEY_FILE_NAME);
}

/**
 * 鍵ファイルの置き場所を決める。
 * 新規は常にホーム配下だが、旧既定の位置に鍵が**既にある**環境では既存の鍵を使い続ける
 * （移行で復号不能にしない）。存在確認のためファイルシステムは見るが、書き込みはしない。
 */
export function resolveSecretKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['AGENTCONTEXT_SECRET_KEY_PATH']?.trim();
  if (explicit !== undefined && explicit !== '') return resolve(explicit);
  const legacy = legacySecretKeyPath(env);
  if (legacy !== undefined && existsSync(legacy)) return legacy;
  return join(homedir(), '.agentblume', 'secret.key');
}

export class AesGcmSecretCipher implements SecretCipherPort {
  private cachedKey: Buffer | undefined;

  constructor(private readonly options: AesGcmSecretCipherOptions = {}) {
    this.cachedKey = options.key;
  }

  /** ファイルを一切触らない揮発鍵の暗号器（プロセス終了で復号不能になる）。 */
  static ephemeral(): AesGcmSecretCipher {
    return new AesGcmSecretCipher({ key: randomBytes(KEY_BYTES) });
  }

  /** 実際に使う鍵ファイルのパス（揮発鍵のときは undefined）。 */
  keyPath(): string | undefined {
    if (this.options.key !== undefined) return undefined;
    return this.options.keyPath ?? resolveSecretKeyPath(this.options.env ?? process.env);
  }

  async seal(plaintext: string): Promise<SealedSecret> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return createSealedSecret({
      v: 1,
      alg: ALGORITHM,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      hint: secretHint(plaintext),
    });
  }

  async open(sealed: SealedSecret): Promise<string> {
    const checked = createSealedSecret(sealed);
    // 鍵ファイル側の障害（key-unavailable）は「復号失敗」に混ぜない。復旧手順が違う。
    const key = this.key();
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(checked.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(checked.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(checked.data, 'base64')), decipher.final()]).toString('utf8');
    } catch (error) {
      // 認証タグ不一致（改竄）と鍵違いは区別できない。どちらも「保存し直し」が唯一の復旧手段。
      throw new SecretCipherError('Stored secret could not be decrypted with the current key file. Save the API key again.', error, 'decrypt-failed');
    }
  }

  /** 鍵は初回利用まで読まない（アプリ起動だけでは鍵ファイルを作らない）。 */
  private key(): Buffer {
    if (this.cachedKey !== undefined) return this.cachedKey;
    const path = this.options.keyPath ?? resolveSecretKeyPath(this.options.env ?? process.env);
    this.cachedKey = readOrCreateKey(path);
    return this.cachedKey;
  }
}

function readOrCreateKey(path: string): Buffer {
  const existing = readKeyFile(path);
  if (existing !== undefined) return existing;
  const key = randomBytes(KEY_BYTES);
  try {
    mkdirSync(dirname(path), { recursive: true });
    // wx: 競合した場合は既存を優先して読み直す（鍵の上書きは復号不能を意味する）。
    writeFileSync(path, `${key.toString('base64')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // NTFS には POSIX パーミッションが無く、Windows では chmod 0o600 は**実効性を持たない**
    // （node は読み取り専用属性しか写さない）。鍵ファイルの保護はOS側のACL・ディスク暗号化に依る。
    try { chmodSync(path, 0o600); } catch { /* パーミッション非対応環境は無視 */ }
    return key;
  } catch (error) {
    const raced = readKeyFile(path);
    if (raced !== undefined) return raced;
    // パスは載せない（ホームディレクトリ名が漏れる）。
    throw new SecretCipherError(KEY_UNAVAILABLE_MESSAGE, error, 'key-unavailable');
  }
}

function readKeyFile(path: string): Buffer | undefined {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); }
  catch { return undefined; }
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new SecretCipherError(`The secret key file is invalid (expected ${KEY_BYTES} base64-encoded bytes). Check AGENTCONTEXT_SECRET_KEY_PATH.`, undefined, 'key-unavailable');
  }
  return key;
}
