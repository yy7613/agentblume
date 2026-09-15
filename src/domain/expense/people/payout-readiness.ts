/**
 * ドメイン: 従業員の口座が振込データ（全銀協）に使えるかの点検（docs/21 §20.5.2 の従業員に関わるコード。系統 A。純関数）。
 *
 * 振込データの組み立て（B の `planPayout`）より前に、従業員マスタの画面で「この人は振込データに入れられるか」を
 * 同じ点検コードと文言（骨格の `payoutProblem`）で見せるためのもの。B もそのまま使える（振込元の書式設定だけを受ける）。
 *
 * - 止める: 口座なし / 口座の桁不正（社員番号を顧客コードに使う設定の社員番号を含む）/ 名義カナの禁止文字 /
 *   **名義カナが変換後 30 バイト超**（切り詰めない。利用者の決定 §20.17-7）/ 銀行名・支店名のカナなし（銀行名を入れる設定のとき）。
 * - 確認必須の警告: 名義カナの書式の変換が起きた / 直近 30 日に口座を変えた。
 * 口座番号は封緘値の hint（末尾 4 桁）の形だけを見る（開封しない）。
 */
import type { BankAccount } from '../bank-account';
import { recentBankAccountChange, type ExpenseEmployee } from '../employee';
import type { ExpensePayoutProblem } from '../errors';
import { isBlockingPayoutProblem, payoutProblem, type ZenginFormatSettings } from '../payout';
import { checkZenginName, ZENGIN_HOLDER_NAME_MAX_BYTES } from '../zengin-charset';

export type PayoutReadinessEmployee = Pick<ExpenseEmployee, 'id' | 'name' | 'code' | 'bankAccount' | 'history'>;
export type PayoutReadinessFormat = Pick<ZenginFormatSettings, 'charset' | 'includeBankNames' | 'customerCode1'>;

export interface EmployeePayoutReadiness {
  /** 止める理由（1 件でもあれば振込データに入れられない）。 */
  readonly problems: readonly ExpensePayoutProblem[];
  /** 確認必須の警告。 */
  readonly warnings: readonly ExpensePayoutProblem[];
  /** 変換後の名義（口座が無ければ undefined）。 */
  readonly holderKanaConverted?: string;
  readonly holderKanaBytes?: number;
}

function shapeProblems(employee: PayoutReadinessEmployee, bank: BankAccount, format: PayoutReadinessFormat): ExpensePayoutProblem[] {
  const refs = { employeeId: employee.id };
  const invalid = (field: string, label: string, detail: string) => payoutProblem('payout-bank-account-invalid', { employee: employee.name, field: label, detail }, { ...refs, field });
  const problems: ExpensePayoutProblem[] = [];
  if (!/^\d{4}$/u.test(bank.bankCode)) problems.push(invalid('bankAccount.bankCode', '銀行コード', `「${bank.bankCode}」は 4 桁の数字ではありません`));
  if (!/^\d{3}$/u.test(bank.branchCode)) problems.push(invalid('bankAccount.branchCode', '支店コード', `「${bank.branchCode}」は 3 桁の数字ではありません`));
  if (!/^\d{4}$/u.test(bank.accountNumber.hint)) problems.push(invalid('bankAccount.accountNumber', '口座番号', '口座番号の保存値が壊れています'));
  if (format.customerCode1 === 'employee-code' && (employee.code === undefined || !/^\d{1,10}$/u.test(employee.code))) {
    problems.push(invalid('code', '顧客コード（社員番号）', employee.code === undefined ? '社員番号がありません' : `社員番号「${employee.code}」は 10 桁以内の数字ではありません`));
  }
  return problems;
}

/** 1 人分の点検。`now` は直近の口座変更の判定に使う。 */
export function employeePayoutReadiness(employee: PayoutReadinessEmployee, format: PayoutReadinessFormat, now: Date): EmployeePayoutReadiness {
  const bank = employee.bankAccount;
  const refs = { employeeId: employee.id };
  if (bank === undefined) {
    return { problems: [payoutProblem('payout-bank-account-missing', { employee: employee.name }, { ...refs, field: 'bankAccount' })], warnings: [] };
  }
  const found = shapeProblems(employee, bank, format);
  const check = checkZenginName(bank.holderKana, ZENGIN_HOLDER_NAME_MAX_BYTES, format.charset);
  const holderField = { ...refs, field: 'bankAccount.holderKana' };
  if (check.invalid.length > 0) {
    found.push(payoutProblem('payout-holder-kana-invalid', {
      employee: employee.name,
      chars: check.invalid.map((entry) => entry.char).join(''),
      positions: check.invalid.map((entry) => String(entry.index + 1)).join(', '),
    }, holderField));
  } else if (check.tooLong) {
    found.push(payoutProblem('payout-holder-kana-too-long', { employee: employee.name, bytes: check.bytes }, holderField));
  } else if (check.converted) {
    found.push(payoutProblem('payout-holder-kana-converted', { employee: employee.name, from: bank.holderKana, to: check.text }, holderField));
  }
  if (format.includeBankNames && (bank.bankNameKana === undefined || bank.branchNameKana === undefined)) {
    found.push(payoutProblem('payout-bank-name-missing', { employee: employee.name }, { ...refs, field: bank.bankNameKana === undefined ? 'bankAccount.bankNameKana' : 'bankAccount.branchNameKana' }));
  }
  const changed = recentBankAccountChange(employee, now);
  if (changed !== undefined) {
    found.push(payoutProblem('payout-bank-account-recently-changed', { employee: employee.name, changedAt: changed.at, changedBy: changed.by }, { ...refs, field: 'history' }));
  }
  return {
    problems: found.filter((problem) => isBlockingPayoutProblem(problem.code)),
    warnings: found.filter((problem) => !isBlockingPayoutProblem(problem.code)),
    holderKanaConverted: check.text,
    holderKanaBytes: check.bytes,
  };
}
