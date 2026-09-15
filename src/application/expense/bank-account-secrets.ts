/**
 * application層: 振込口座の口座番号の封緘・開封（docs/21 §20.2.5 / §20.17-1 の決定）。
 *
 * 口座番号は `SecretCipherPort`（鍵は DB の外。MCP 設定・モデル設定と同じ鍵）で封緘して保存し、平文は
 * **振込データを作る瞬間（B の payouts）と口座つき従業員 CSV の出力（A）でだけ**開封する。応答・一覧・ツールは封緘値の
 * hint（末尾 4 桁）しか使わない。domain は暗号を知らないので、封緘の手順はここ 1 か所に置き、A と B が同じ関数を使う。
 *
 * 平文はこのファイルの関数の入出力としてのみ存在し、ログ・監査の詳細・例外の文言に入れないこと。
 */
import { createBankAccount, normalizeAccountNumber, validateSealedAccountNumber, type BankAccount, type BankAccountType, type SealedAccountNumber } from '../../domain/expense/bank-account';
import type { SecretCipherPort } from '../model-settings/secret-cipher';

/** 画面・CSV から受ける口座（口座番号は平文。省略 = 既存の口座番号を保つ）。 */
export interface BankAccountInput {
  readonly bankCode: string;
  readonly bankNameKana?: string;
  readonly branchCode: string;
  readonly branchNameKana?: string;
  readonly accountType: BankAccountType;
  readonly accountNumber?: string;
  readonly holderKana: string;
}

/** 平文の口座番号を 7 桁に揃えてから封緘する（hint が末尾 4 桁になる）。 */
export async function sealAccountNumber(cipher: SecretCipherPort, plaintext: string): Promise<SealedAccountNumber> {
  return validateSealedAccountNumber(await cipher.seal(normalizeAccountNumber(plaintext)));
}

/** 封緘値を開封して 7 桁の平文にする（振込データの作成時だけ呼ぶ）。 */
export async function openAccountNumber(cipher: SecretCipherPort, sealed: SealedAccountNumber): Promise<string> {
  return normalizeAccountNumber(await cipher.open(sealed));
}

/**
 * 入力から口座を組み立てる。口座番号が省略されたら既存の封緘値を使う（編集画面で「変更する」を押さなければ口座番号を送らない）。
 * 既存の口座が無いのに口座番号が無ければ `normalizeAccountNumber` が 400 にする。
 */
export async function bankAccountFromInput(cipher: SecretCipherPort, input: BankAccountInput, existing: BankAccount | undefined, by: string, at: string): Promise<BankAccount> {
  const accountNumber = input.accountNumber === undefined || input.accountNumber === ''
    ? existing?.accountNumber ?? await sealAccountNumber(cipher, input.accountNumber ?? '')
    : await sealAccountNumber(cipher, input.accountNumber);
  return createBankAccount({ ...input, accountNumber, changedAt: at, changedBy: by });
}
