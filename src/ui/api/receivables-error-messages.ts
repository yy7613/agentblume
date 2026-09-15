/**
 * ui/api層: 入金消込（docs/22）のエラーの見出し。src/api/receivables-error-mapping.ts の code 体系に対応する。
 *
 * 見出しは「原因 → 次の一手」を 1 文で言う。本文の項目（行番号・状態の理由・足りない科目・違反の件数）が
 * あれば、それを埋めた見出しを優先する（直す場所そのものなので）。業務の見出しは `error-messages.ts` が連結する（ADR-0039）。
 */
import type { Bilingual, BusinessErrorMessages, BusinessErrorPayload, ErrorLanguage } from './business-error-types';

/** 状態の理由 → 見出し（docs/22 §4.5 の確定の前提チェック）。 */
export const RECEIVABLES_STATE_HEADINGS: Readonly<Record<string, Bilingual>> = {
  'transaction-not-unmatched': ['This deposit has already been reconciled or ignored. Reload the list', 'この入金はすでに消込済みか対象外です。一覧を再読み込みしてください'],
  'invoice-outstanding-changed': ['The invoice balance changed after the judgment (another deposit was confirmed). Judge again', '判定の後に請求の残高が変わりました（別の入金が確定されました）。再判定してください'],
  'allocation-exceeds-outstanding': ['An allocation exceeds the invoice balance. Edit the allocation', '配分額が請求の残高を超えています。配分を編集してください'],
  'allocation-sum-mismatch': ['The allocations minus the fee do not equal the deposit. Edit the allocation', '配分合計 − 手数料 が入金額と合いません。配分を編集してください'],
  'fee-out-of-tolerance': ['The fee is outside the tolerance in Settings. Edit the allocation or widen the tolerance in Settings', '手数料が設定の許容範囲の外です。配分を編集するか、設定で手数料の許容範囲を見直してください'],
  'invoice-not-draft': ['Only a draft invoice can be edited or deleted. Void it and duplicate it to fix', '編集・削除できるのは下書きだけです。取消 → 複製して作り直してください'],
  'invoice-not-issued': ['Only an issued invoice can be voided or paid', '取消・入金の配分ができるのは発行済みの請求書だけです'],
  'invoice-has-payments': ['This invoice has confirmed payments. Cancel the matchings first, then void it', 'この請求には確定済みの入金があります。先に消込を取り消してから取消してください'],
  'customer-in-use': ['This customer is used by invoices, so it cannot be deleted. Disable it instead', 'この取引先は請求書で使われているため削除できません。無効にしてください'],
  'matching-not-confirmed': ['This matching has already been cancelled. Reload the list', 'この消込はすでに取り消されています。一覧を再読み込みしてください'],
  'transaction-not-ignored': ['This deposit is not marked as ignored. Reload the list', 'この入金は対象外になっていません。一覧を再読み込みしてください'],
  'profile-builtin': ['A built-in CSV profile cannot be changed. Save it under a new name', '組込みの CSV プロファイルは変更できません。別名で保存してください'],
};

function stateHeading(payload: BusinessErrorPayload, language: ErrorLanguage): string | undefined {
  const reason = payload.details?.['reason'];
  const heading = typeof reason === 'string' ? RECEIVABLES_STATE_HEADINGS[reason] : undefined;
  return heading === undefined ? undefined : heading[language === 'ja' ? 1 : 0];
}

export const RECEIVABLES_ERROR_MESSAGES: BusinessErrorMessages = {
  headings: {
    RECEIVABLES_DOMAIN: ['Please check the invoicing and receivables input', '請求・入金消込の入力内容を確認してください'],
    RECEIVABLES_INVOICE_COMPLIANCE: ['The invoice cannot be issued yet. Fix the listed requirements, then issue it', '請求書をまだ発行できません。一覧の記載事項を直してから発行してください'],
    RECEIVABLES_CSV_IMPORT: ['The bank CSV could not be imported. Check the column mapping, the header row, and the character encoding', '銀行明細 CSV を取り込めませんでした。列マッピング・ヘッダ行・文字コードを確認してください'],
    RECEIVABLES_CUSTOMER_NOT_FOUND: ['The customer was not found. Reload the list', '取引先が見つかりませんでした。一覧を再読み込みしてください'],
    RECEIVABLES_INVOICE_NOT_FOUND: ['The invoice was not found. Reload the list', '請求書が見つかりませんでした。一覧を再読み込みしてください'],
    RECEIVABLES_BANK_TRANSACTION_NOT_FOUND: ['The deposit was not found. Reload the list', '入金明細が見つかりませんでした。一覧を再読み込みしてください'],
    RECEIVABLES_MATCHING_NOT_FOUND: ['The matching was not found. Reload the list', '消込の記録が見つかりませんでした。一覧を再読み込みしてください'],
    RECEIVABLES_BANK_CSV_PROFILE_NOT_FOUND: ['The CSV profile was not found. Choose another profile or map the columns', 'CSV プロファイルが見つかりませんでした。別のプロファイルを選ぶか列を割り当ててください'],
    RECEIVABLES_STATE: ['The operation cannot be done in the current state. Reload and try again', '今の状態ではこの操作ができません。再読み込みしてからやり直してください'],
    RECEIVABLES_JOURNAL_ACCOUNT_MISSING: ['An account or tax category used for journal entries is missing or disabled. Fix it in Settings › Journal link or in the Journal chart', '仕訳に使う科目か税区分が科目マスタに無いか無効です。設定 › 仕訳連携 か 仕訳 › 科目 で直してください'],
    RECEIVABLES_EXTRACTION_UNAVAILABLE: ['The main model cannot read images or return structured output. Change the main model in Settings, then try again', 'main モデルが画像読取または構造化出力に対応していません。設定画面でモデルを変えてからやり直してください'],
  },
  heading: (payload, language) => {
    if (payload.code === 'RECEIVABLES_STATE') return stateHeading(payload, language);
    if (payload.code === 'RECEIVABLES_CSV_IMPORT' && payload.row !== undefined) {
      return language === 'ja'
        ? `CSV の ${payload.row} 行目を取り込めませんでした。その行の列数・日付・金額を確認してください`
        : `Row ${payload.row} of the CSV could not be imported. Check the column count, date, and amount on that row`;
    }
    if (payload.code === 'RECEIVABLES_JOURNAL_ACCOUNT_MISSING' && Array.isArray(payload.details?.['missing'])) {
      const missing = (payload.details['missing'] as { id?: unknown; settingPath?: unknown }[]).map((entry) => `${String(entry.settingPath)} = ${String(entry.id)}`).join(', ');
      return language === 'ja'
        ? `仕訳の科目・税区分がマスタに無いか無効です（${missing}）。設定 › 仕訳連携 か 仕訳 › 科目 で直してください`
        : `Journal accounts or tax categories are missing or disabled (${missing}). Fix them in Settings › Journal link or in the Journal chart`;
    }
    if (payload.code === 'RECEIVABLES_INVOICE_COMPLIANCE' && Array.isArray(payload.details?.['violations'])) {
      const count = (payload.details['violations'] as unknown[]).length;
      return language === 'ja'
        ? `請求書をまだ発行できません（直す項目が ${count} 件）。請求書の検査結果の一覧から直してください`
        : `The invoice cannot be issued yet (${count} items to fix). Fix them from the check list on the invoice`;
    }
    return undefined;
  },
};
