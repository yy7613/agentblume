import type { BusinessDescriptor } from '../business/types';

/** 経費精算の業務記述子（ADR-0039 / docs/21-expense.md §11）。 */
export const expenseBusiness: BusinessDescriptor = {
  id: 'expense',
  screen: 'Expense',
  listed: true,
  card: {
    title: { en: 'Expense claims', ja: '経費精算' },
    summary: {
      en: 'Check reimbursement claims against your own expense policy (limits, receipts, invoices, duplicates), approve them, and export a payout CSV and journal drafts.',
      ja: '立替経費の申請を自社の規程（上限・領収書・登録番号・重複）でチェックし、承認して、振込用 CSV と仕訳下書きに流します。',
    },
    order: 20,
  },
  help: {
    title: { en: 'Expense claims', ja: '経費精算' },
    summary: {
      en: 'Set up your expense policy, bring in receipts, and let deterministic checks mark each claim as pass, needs review, or return. People approve, return, and settle claims on this screen.',
      ja: '経費の規程を決めて領収書を取り込むと、決まった規則で申請ごとに「通過 / 要確認 / 差し戻し」を判定します。承認・差し戻し・精算は人がこの画面で押します。',
    },
    steps: [
      { en: 'Policy: compare the initial template with your company rules (categories, limits, required fields) and press Save.', ja: '規程: 初期テンプレートを自社の規程（費目・上限・必須項目）と見比べて「保存」を押します。' },
      { en: 'Ingest: create a claim, then add items from receipt images / PDFs, by hand, or from an expense CSV.', ja: '申請取込: 申請を作り、領収書の画像 / PDF・手入力・経費明細 CSV から明細を足します。' },
      { en: 'Check: run the checks and follow each reason card (cause, next step, and a button to the place to fix).', ja: 'チェック: チェックを実行し、理由カード（原因・次の一手・直す場所へのボタン）に従って直します。' },
      { en: 'Approve: mark review reasons as reviewed with a comment, or return the claim with a message; then approve.', ja: '承認: 要確認の理由をコメント付きで確認済みにするか、文言を添えて差し戻し、承認します。' },
      { en: 'Export: download the payout or detail CSV, create journal drafts, and mark claims as settled after paying.', ja: '精算出力: 振込用 / 明細の CSV を出し、仕訳下書きを作り、支払ったら「精算済み」にします。' },
    ],
    doc: 'docs/21-expense.md',
  },
  loading: { en: 'Loading expense claims…', ja: '経費精算画面を読み込み中…' },
  loadPage: async () => (await import('./ExpensePage')).ExpensePage,
};
