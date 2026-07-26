/**
 * ドメイン: 封緘された秘密値（APIキー）の表現。
 *
 * ドメインは暗号そのものを知らない（鍵も平文も持たない）。
 * 「この形をしていれば保存・復元してよい」という**形状**だけを保証する。
 * 実際の封緘・開封は application の SecretCipherPort（実装は adapters/security）が担う。
 *
 * `hint` は封緘時に平文の末尾数文字だけを別途保持したもの。復号せずにUIへ
 * `sk-...abcd` のようなマスク表示を出すためだけに使う（先頭は決して残さない）。
 */
import { ModelSettingsValidationError } from './errors';

/** マスク表示のために保持する平文末尾の文字数。 */
export const SECRET_HINT_LENGTH = 4;

export interface SealedSecret {
  readonly v: 1;
  readonly alg: 'aes-256-gcm';
  /** 初期化ベクトル（base64）。 */
  readonly iv: string;
  /** 認証タグ（base64）。改竄検知に使う。 */
  readonly tag: string;
  /** 暗号文（base64）。 */
  readonly data: string;
  /** 平文の末尾 SECRET_HINT_LENGTH 文字（それより短い平文はその全長）。 */
  readonly hint: string;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** マスク表示用のヒントを作る。空文字は空文字のまま（未設定と区別しない）。 */
export function secretHint(plaintext: string): string {
  return plaintext.length <= SECRET_HINT_LENGTH ? plaintext : plaintext.slice(-SECRET_HINT_LENGTH);
}

function base64(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value === '')) {
    throw new ModelSettingsValidationError(`createSealedSecret: ${field} must be a non-empty base64 string`);
  }
  if (!BASE64.test(value)) throw new ModelSettingsValidationError(`createSealedSecret: ${field} must be base64`);
  return value;
}

/** 形状を検証した SealedSecret を作る（値の複製までを保証する）。 */
export function createSealedSecret(value: unknown): SealedSecret {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ModelSettingsValidationError('createSealedSecret: value must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record['v'] !== 1) throw new ModelSettingsValidationError('createSealedSecret: v must be 1');
  if (record['alg'] !== 'aes-256-gcm') throw new ModelSettingsValidationError("createSealedSecret: alg must be 'aes-256-gcm'");
  const hint = record['hint'];
  if (typeof hint !== 'string' || hint.length > SECRET_HINT_LENGTH) {
    throw new ModelSettingsValidationError(`createSealedSecret: hint must be a string of at most ${SECRET_HINT_LENGTH} characters`);
  }
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: base64(record['iv'], 'iv'),
    tag: base64(record['tag'], 'tag'),
    // 空文字の平文を封緘すると暗号文も空になり得るため data だけは空を許す。
    data: base64(record['data'], 'data', true),
    hint,
  };
}

/** 例外を投げずに形状を判定する（保存済みデータの分岐用）。 */
export function isSealedSecret(value: unknown): value is SealedSecret {
  try { createSealedSecret(value); return true; } catch { return false; }
}
