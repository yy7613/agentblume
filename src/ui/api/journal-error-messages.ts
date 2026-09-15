/**
 * ui/api層: 仕訳（docs/20）のエラーの見出し。src/domain/journal のエラー → src/api/journal-error-mapping.ts の code 体系に対応する。
 *
 * 業務の見出しは業務ごとのファイルに置き、`error-messages.ts` が連結する（ADR-0039）。
 */
import type { BusinessErrorMessages } from './business-error-types';

export const JOURNAL_ERROR_MESSAGES: BusinessErrorMessages = {
  headings: {
    JOURNAL_DOMAIN: ['Please check the journal input', '仕訳の入力内容を確認してください'],
    JOURNAL_DOCUMENT_NOT_FOUND: ['The journal document was not found', '帳票が見つかりませんでした'],
    JOURNAL_RULE_NOT_FOUND: ['The journal rule was not found', '仕訳ルールが見つかりませんでした'],
    JOURNAL_ENTRY_NOT_FOUND: ['The journal entry was not found', '仕訳が見つかりませんでした'],
    JOURNAL_HEARING_NOT_FOUND: ['The hearing session was not found', 'ヒアリングが見つかりませんでした'],
    // 409。原因（モデルが画像読取／構造化出力に非対応）→ 次の一手（設定画面でモデルを変える）まで 1 文で言う。
    JOURNAL_EXTRACTION_UNAVAILABLE: [
      'The model used for the journal does not support image reading or structured output. Change the main model in Settings to one with vision and structured output, then reopen this screen',
      '判定に使うモデルが画像読取または構造化出力に対応していません。設定画面で main モデルを画像読取・構造化出力に対応したものへ変え、この画面を開き直してください',
    ],
    JOURNAL_CSV_IMPORT: ['The CSV could not be imported. Check the preset, the header row, and the character encoding', 'CSV を取り込めませんでした。プリセット・ヘッダー行・文字コードを確認してください'],
    JOURNAL_EXPORT: ['The journal export failed. Check the status filter and date range, then retry', '仕訳の出力に失敗しました。状態の絞り込みと期間を確認して再試行してください'],
  },
  // CSV 取込の失敗は「何行目か」が直す場所そのものなので、見出しに行番号を埋める。
  heading: (payload, language) => {
    if (payload.code !== 'JOURNAL_CSV_IMPORT' || payload.row === undefined) return undefined;
    return language === 'ja'
      ? `CSV の ${payload.row} 行目を取り込めませんでした。その行の列数・日付・金額を確認してください`
      : `Row ${payload.row} of the CSV could not be imported. Check the column count, date, and amount on that row`;
  },
};
