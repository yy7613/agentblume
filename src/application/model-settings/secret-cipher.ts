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
 * 封緘・開封の失敗（鍵ファイルの差し替え・破損・改竄検知）。
 *
 * メッセージには**秘密値も鍵も含めない**。利用者が取るべき行動（キーの再入力）だけを伝える。
 * api では 409（設定を保存し直す必要がある状態）へ写す。
 */
export class SecretCipherError extends Error {
  readonly code = 'SECRET_CIPHER';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'SecretCipherError';
  }
}
