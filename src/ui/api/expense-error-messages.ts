/**
 * ui/api層: 経費精算（docs/21 §10.1 / §20.9.5）のエラーの見出し。src/api/expense-error-mapping.ts の code 体系に対応する。
 *
 * 業務の見出しは業務ごとのファイルに置き、`error-messages.ts` が連結する（ADR-0039）。
 * 見出しは「原因 → 次の一手」を 1 文で。本文に直す場所（行番号・足りない列・次の一手）があれば、それを埋めた見出しを優先する。
 */
import type { BusinessErrorMessages } from './business-error-types';

/** 追加読取・ヒアリングが使えない理由（本文の `missing`）→ 次の一手。 */
function missingCapability(missing: unknown, language: 'en' | 'ja'): string | undefined {
  switch (missing) {
    case 'model': return language === 'ja' ? '設定画面で main モデルを選んでください' : 'choose a main model in Settings';
    case 'structured-output': return language === 'ja' ? '設定画面で構造化出力に対応したモデルを選んでください' : 'choose a model with structured output in Settings';
    case 'vision': return language === 'ja' ? '設定画面で画像（vision）に対応したモデルを選んでください' : 'choose a vision-capable model in Settings';
    default: return undefined;
  }
}

export const EXPENSE_ERROR_MESSAGES: BusinessErrorMessages = {
  headings: {
    EXPENSE_DOMAIN: ['Please check the expense input (a value is out of range or in the wrong format)', '経費精算の入力内容を確認してください（値の範囲か形式が合っていません）'],
    EXPENSE_CSV_IMPORT: ['The expense CSV could not be imported. Check the header names (date and amount columns are required) and the character encoding', '経費明細の CSV を取り込めませんでした。列名（日付と金額の列は必須）と文字コードを確認してください'],
    EXPENSE_CLAIM_NOT_FOUND: ['The expense claim was not found. Reload the list; it may have been deleted', '申請が見つかりませんでした。一覧を読み込み直してください（削除された可能性があります）'],
    EXPENSE_ITEM_NOT_FOUND: ['The expense item was not found. Reopen the claim to see its current items', '明細が見つかりませんでした。申請を開き直して、いまの明細を確認してください'],
    EXPENSE_RECEIPT_NOT_FOUND: ['No receipt image is attached to this item. Attach the receipt from the ingest step', 'この明細には領収書の画像がありません。取込ステップで領収書を添付してください'],
    EXPENSE_TRANSITION: ['This operation is not allowed in the claim\'s current state. Follow the reasons shown next to the button', 'いまの申請の状態ではこの操作はできません。ボタンの横に出ている理由に従ってください'],
    EXPENSE_JOURNAL_LINK: ['Journal drafts could not be created. Fix the items or accounts listed below, then create them again', '仕訳下書きを作成できませんでした。下に並んだ明細・科目を直してから、もう一度作成してください'],
    // 実用化（§20.9.5）
    EXPENSE_EMPLOYEE_NOT_FOUND: ['The employee was not found. Reload the employee list; it may have been deleted', '従業員が見つかりませんでした。従業員の一覧を読み込み直してください（削除された可能性があります）'],
    EXPENSE_ADVANCE_NOT_FOUND: ['The advance was not found. Reload the advance ledger; it may have been deleted', '仮払が見つかりませんでした。仮払台帳を読み込み直してください（削除された可能性があります）'],
    EXPENSE_PAYOUT_NOT_FOUND: ['The payout batch was not found. Reload the payout batch list', '振込データが見つかりませんでした。振込バッチの一覧を読み込み直してください'],
    EXPENSE_CARD_TRANSACTION_NOT_FOUND: ['The card transaction was not found. Reload the card ledger; its statement may have been deleted', 'カードの利用が見つかりませんでした。カード台帳を読み込み直してください（明細の取込を削除した可能性があります）'],
    EXPENSE_CARD_IMPORT_NOT_FOUND: ['The card statement import was not found. Reload the import history', 'カード明細の取込が見つかりませんでした。取込の履歴を読み込み直してください'],
    EXPENSE_HEARING_NOT_FOUND: ['The policy hearing was not found. Start a new hearing from the policy step', '規程のヒアリングが見つかりませんでした。規程ステップから新しく始めてください'],
    EXPENSE_EMPLOYEE_CSV_IMPORT: ['The employee CSV could not be imported. Check the header names against the sample employees.csv and the character encoding', '従業員 CSV を取り込めませんでした。列名を見本の employees.csv と見比べ、文字コードを確認してください'],
    EXPENSE_CARD_IMPORT: ['The card statement could not be imported. Check which column is the date, amount, and merchant in the column mapping', 'カード明細を取り込めませんでした。列の対応で日付・金額・加盟店の列を確認してください'],
    EXPENSE_CARD_DUPLICATE_IMPORT: ['This card statement has already been imported. Use the existing import, or delete it before importing again', 'このカード明細は取込済みです。既存の取込を使うか、削除してから取り込み直してください'],
    EXPENSE_PAYOUT_BLOCKED: ['The payout file was not created. Fix the problems listed below (accounts, claimants, transfer date), then check again', '振込データを作れませんでした。下に並んだ問題（口座・申請者・振込日）を直してから、もう一度点検してください'],
    EXPENSE_POLICY_CONFLICT: ['The policy was changed after the proposal was made. Recreate the diff, then choose the changes again', '案を作った後に規程が変わりました。差分を作り直してから、変更を選び直してください'],
    EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE: ['The additional expense reading is not available. Choose a model with structured output and vision in Settings, or read without it', '経費の追加読取は使えません。設定画面で構造化出力と画像に対応したモデルを選ぶか、追加読取なしで読み取ってください'],
    EXPENSE_HEARING_UNAVAILABLE: ['Drafting the policy from your rules is not available. Choose a model with structured output in Settings', '社内規程からの案づくりは使えません。設定画面で構造化出力に対応したモデルを選んでください'],
    EXPENSE_HEARING_SCHEMA: ['The model returned a proposal that did not fit the expected form. Try again, or try another model in Settings', 'モデルの案が決まった形になりませんでした。もう一度試すか、設定画面で別のモデルを試してください'],
  },
  heading: (payload, language) => {
    if ((payload.code === 'EXPENSE_CSV_IMPORT' || payload.code === 'EXPENSE_DOMAIN' || payload.code === 'EXPENSE_EMPLOYEE_CSV_IMPORT' || payload.code === 'EXPENSE_CARD_IMPORT') && payload.row !== undefined) {
      return language === 'ja'
        ? `CSV の ${payload.row} 行目を取り込めませんでした。その行の値を確認してください`
        : `Row ${payload.row} of the CSV could not be imported. Check the values on that row`;
    }
    // 足りない列が分かれば、行番号の無い CSV の失敗でも「どの列を足すか」を見出しにする。
    const missingColumns = payload.details?.['missingColumns'];
    if ((payload.code === 'EXPENSE_EMPLOYEE_CSV_IMPORT' || payload.code === 'EXPENSE_CARD_IMPORT') && Array.isArray(missingColumns)) {
      const columns = missingColumns.filter((column): column is string => typeof column === 'string' && column !== '');
      if (columns.length > 0) {
        return language === 'ja'
          ? `CSV に必要な列がありません: ${columns.join('、')}。列名を直すか列の対応を選んでください`
          : `The CSV is missing required columns: ${columns.join(', ')}. Rename the headers or choose the column mapping`;
      }
    }
    if (payload.code === 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE' || payload.code === 'EXPENSE_HEARING_UNAVAILABLE') {
      const next = missingCapability(payload.details?.['missing'], language);
      if (next !== undefined) {
        const what = payload.code === 'EXPENSE_HEARING_UNAVAILABLE'
          ? (language === 'ja' ? '社内規程からの案づくりは使えません' : 'Drafting the policy from your rules is not available')
          : (language === 'ja' ? '経費の追加読取は使えません' : 'The additional expense reading is not available');
        return language === 'ja' ? `${what}。${next}` : `${what}: ${next}`;
      }
    }
    const nextStep = payload.details?.['nextStep'];
    if (payload.code === 'EXPENSE_TRANSITION' && typeof nextStep === 'string' && nextStep !== '') {
      // サーバーの次の一手は日本語。英語表示では共通の見出しに任せる。
      return language === 'ja' ? `操作できません。${nextStep}` : undefined;
    }
    return undefined;
  },
};
