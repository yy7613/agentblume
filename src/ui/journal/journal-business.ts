/**
 * 仕訳（docs/20-journal.md）の業務記述子（ADR-0039）。一覧のカード・ヘルプ・画面の読み込みをここに宣言する。
 */
import type { BusinessDescriptor } from '../business/types';

export const journalBusiness: BusinessDescriptor = {
  id: 'journal',
  screen: 'Journal',
  listed: true,
  card: {
    title: { en: 'Journal entries', ja: '仕訳' },
    summary: {
      en: 'Ingest receipts, invoices, and bank/card CSV rows, judge them against your own rules, and export the entries for your accounting software.',
      ja: 'レシート・請求書・銀行/カード明細を取り込み、自分で決めたルールで判定して仕訳を起こし、会計ソフト向けの CSV に出力します。',
    },
    order: 10,
  },
  help: {
    title: { en: 'Journal', ja: '仕訳' },
    summary: { en: 'Ingest receipts, invoices, and bank/card CSV rows, judge each one against your own rules (stage 1), and export the resulting journal entries as a generic CSV.', ja: 'レシート・請求書・銀行/カード明細 CSV を取り込み、自分で決めたルールで判定（Stage 1）して仕訳を起こし、汎用 CSV に出力します。' },
    steps: [
      { en: 'Accounts, tax categories, and dimensions are yours to define in the Chart tab — the standard set is only a starting point. Rules refer to accounts by id, so renaming is safe.', ja: '勘定科目・税区分・補助軸は「科目」タブで自由に定義できます。標準セットは初期値に過ぎません。ルールは科目を id で参照するので、名前を変えても壊れません。' },
      { en: 'Ingest: import a bank/card CSV (the preset is detected from the header), fill the facts form, paste facts JSON, or store a text source for later extraction.', ja: '取込: 銀行/カード CSV（ヘッダーからプリセットを自動判定）、事実フォーム、JSON 貼り付け、またはテキストの保存（後で抽出）。' },
      { en: 'Judge: "Judge pending" applies enabled rules. Undecided rows show the cause, the next step, and a button that opens the place to fix it (make a rule, edit facts, open the chart).', ja: '判定: 「未判定を判定」で有効なルールを照合します。未確定の行には原因 → 次の一手 → 直す場所へのボタン（ルールを作る / 項目を編集 / 科目マスタを開く）が出ます。' },
      { en: 'Export: confirm the draft entries, then download the generic CSV (UTF-8 BOM, CRLF).', ja: '出力: ドラフトの仕訳を確定し、汎用 CSV（UTF-8 BOM・CRLF）をダウンロードします。' },
      { en: 'LLM extraction from images/PDF/text and the hearing (stage 2) become available when the main model slot is configured and the server enables them.', ja: '画像 / PDF / テキストの LLM 抽出とヒアリング（Stage 2）は、main モデルを設定しサーバーが有効化すると使えるようになります。' },
    ],
    doc: 'docs/20-journal.md',
  },
  loading: { en: 'Loading journal…', ja: '仕訳画面を読み込み中…' },
  // 仕訳画面は 5 サブタブ（取込 / 判定 / ルール / 科目 / 出力）を持つ大きな画面なので、遅延読込にする。
  loadPage: async () => (await import('./JournalPage')).JournalPage,
};
