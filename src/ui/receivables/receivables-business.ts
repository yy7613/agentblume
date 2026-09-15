/**
 * 請求書発行と入金消込（docs/22-receivables.md）の業務記述子（ADR-0039）。一覧のカード・ヘルプ・画面の読み込みをここに宣言する。
 */
import type { BusinessDescriptor } from '../business/types';

export const receivablesBusiness: BusinessDescriptor = {
  id: 'receivables',
  screen: 'Receivables',
  listed: true,
  card: {
    title: { en: 'Invoicing and receivables', ja: '請求書発行と入金消込' },
    summary: {
      en: 'Issue qualified invoices with tax rounded once per rate, import bank CSVs, match deposits to invoices in two stages, and hand draft journal entries to the Journal.',
      ja: '税率ごとに 1 回の端数処理で適格請求書を発行し、銀行明細 CSV を取り込んで入金を 2 段階で請求に消し込み、仕訳の下書きを仕訳へ渡します。',
    },
    order: 30,
  },
  help: {
    title: { en: 'Invoicing and receivables', ja: '請求書発行と入金消込' },
    summary: {
      en: 'Create and issue invoices, import bank statements, and reconcile deposits against invoices. Issuing and confirming a matching create draft journal entries.',
      ja: '請求書を作って発行し、銀行明細を取り込んで入金を請求に消し込みます。発行と消込の確定で仕訳の下書きができます。',
    },
    steps: [
      { en: 'Settings (top right): the issuer name and registration number, rounding, fee tolerance, and the journal accounts are yours to set. Accounts are picked from the Journal chart.', ja: '設定（右上）: 発行者名と登録番号・端数処理・手数料の許容範囲・仕訳の科目は利用者が決めます。科目は仕訳の科目マスタから選びます。' },
      { en: 'Customers: register recipients and the payer name in kana as it appears on bank statements. Aliases learned when you confirm a matching can be edited here.', ja: '取引先: 宛名と、銀行明細に出る振込名義カナを登録します。消込の確定で覚えた別名もここで編集できます。' },
      { en: 'Invoice → Issue: the check lists missing requirements with a button to the field; an invoice with violations cannot be issued. Print preview supports "Save as PDF".', ja: '請求書作成 → 発行: 検査が記載事項の不足を「該当欄へ」ボタン付きで示し、違反があると発行できません。印刷プレビューから PDF に保存できます。' },
      { en: 'Bank import → Matching: import the CSV, "Judge deposits", then confirm. Decided means same amount and recognized payer name; everything else is a candidate or pending with the reason and the next step.', ja: '明細取込 → 消込: CSV を取り込み「消込を判定」して確定します。決定は同額かつ名義が一致したものだけで、それ以外は理由と次の一手つきの候補・保留になります。' },
      { en: 'Journal link: draft entries appear in the Journal. Entries already confirmed there are never overwritten; you get a button to open them instead.', ja: '仕訳連携: 下書きの仕訳が仕訳画面に出ます。仕訳側で確定済みの仕訳は上書きせず、開くボタンで案内します。' },
    ],
    doc: 'docs/22-receivables.md',
  },
  loading: { en: 'Loading invoicing and receivables…', ja: '請求書発行と入金消込画面を読み込み中…' },
  loadPage: async () => (await import('./ReceivablesPage')).ReceivablesPage,
};
