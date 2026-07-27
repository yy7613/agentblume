/**
 * application層(Port): 秘密値の封緘・開封。
 *
 * 実装（adapters/security）は鍵の出所（鍵ファイル・KMS等）を隠す。application は
 * 「平文 → SealedSecret」「SealedSecret → 平文」だけを知り、鍵を一切見ない。
 *
 * 重要: 平文はこのPortの入出力としてのみ存在し、**保存・ログ・API応答へは決して出さない**。
 */
import type { SealedSecret } from '../../domain/model-settings/sealed-secret';

export interface SecretCipherPort {
  seal(plaintext: string): Promise<SealedSecret>;
  open(sealed: SealedSecret): Promise<string>;
}

/**
 * 失敗の種別。**利用者が取れる行動が違う**ので分ける。
 * - `decrypt-failed` … 鍵は読めたが復号できない（鍵の差し替え・改竄）。キーの再入力で直る → 409。
 * - `key-unavailable` … 鍵ファイル自体が読めない・壊れている。再入力しても直らない（運用者の対処）→ 500。
 */
export type SecretCipherFailureReason = 'key-unavailable' | 'decrypt-failed';

/**
 * 封緘・開封の失敗（鍵ファイルの差し替え・破損・改竄検知）。
 *
 * メッセージには**秘密値も鍵も、鍵ファイルの絶対パスも含めない**
 * （パスにはホームディレクトリ名＝利用者名が入り得る）。
 */
export class SecretCipherError extends Error {
  readonly code = 'SECRET_CIPHER';
  readonly reason: SecretCipherFailureReason;
  constructor(message: string, override readonly cause?: unknown, reason: SecretCipherFailureReason = 'decrypt-failed') {
    super(message);
    this.name = 'SecretCipherError';
    this.reason = reason;
  }
}
