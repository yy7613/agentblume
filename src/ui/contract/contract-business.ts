/**
 * 契約書レビューと期限台帳（docs/23-contract.md）の業務記述子（ADR-0039）。一覧のカード・ヘルプ・画面の読み込みをここに宣言する。
 */
import type { BusinessDescriptor } from '../business/types';

export const contractBusiness: BusinessDescriptor = {
  id: 'contract',
  screen: 'Contract',
  listed: true,
  card: {
    title: { en: 'Contract review and deadline ledger', ja: '契約書レビューと期限台帳' },
    summary: {
      en: 'Check received contracts clause by clause against your own review playbook, get suggested wording for points to negotiate, and track renewal and notice deadlines after signing.',
      ja: '受け取った契約書を自社の審査基準で条項ごとに確認し、要交渉の条項には修正文案を添え、締結後は更新・解約通知の期限を台帳で管理します。',
    },
    order: 40,
  },
  help: {
    title: { en: 'Contract review', ja: '契約書レビューと期限台帳' },
    summary: {
      en: 'Import a contract (pasted text, PDF, or page images), extract its clauses, check them against your playbook, register the signed contract, and track its deadlines. Results are a comparison with your registered criteria, not legal advice.',
      ja: '契約書（テキスト・PDF・ページ画像）を取り込み、条項を抜き出して審査基準で確認し、締結登録して期限を管理します。結果は登録した基準との照合であり、法的な判断ではありません。',
    },
    steps: [
      { en: 'Playbook: create one from a template (outsourcing / NDA) and edit the clause types, criteria, suggested wording, legal settings, and the stamp duty table. All of them are your data.', ja: '審査基準: テンプレート（業務委託 / 秘密保持契約）から作り、条項の種類・基準・推奨文案・法令設定・印紙税表を編集します。すべて利用者のデータです。' },
      { en: 'Import: paste the text, read a PDF (scanned pages are transcribed one page at a time), choose whether we are party A or B, our role, and the counterparty category.', ja: '取込: テキストを貼り付けるか PDF を読み込み（スキャンページは 1 ページずつ文字起こし）、自社が甲か乙か・立場・相手方の区分を選びます。' },
      { en: 'Clauses: extract with AI, check each value against the highlighted evidence, fix or point to the evidence by selecting text, then confirm.', ja: '条項抽出: AI で抜き出し、ハイライトされた根拠と値を確かめ、本文を選んで根拠を付け直すなどしてから確定します。' },
      { en: 'Review: each clause type shows accept / negotiate / reject / needs a decision with the cause, the next step, and a button to the place to fix it. Record your decision and finalize.', ja: 'レビュー: 条項ごとに 受け入れ可 / 要交渉 / 不可 / 要確認 と、原因・次の一手・直す場所へのボタンが出ます。人の判断を記録して確定します。' },
      { en: 'Sign and ledger: register the signing date to calculate the expiry, renewal notice, and renewal deadlines; mark notices as done in the ledger.', ja: '締結登録と台帳: 締結日を登録すると満了日・更新拒絶の通知期限・更新日を計算します。台帳で通知済みにします。' },
      { en: 'In chat, attach a contract PDF to an agent that has the contract_review_draft tool; its text is passed to the tool only.', ja: 'チャットでは contract_review_draft ツールを持つエージェントに契約書 PDF を添付できます（本文はツールだけが読みます）。' },
    ],
    doc: 'docs/23-contract.md',
  },
  loading: { en: 'Loading contract review…', ja: '契約書レビュー画面を読み込み中…' },
  // 6 つの手順を持つ大きな画面なので遅延読込にする。
  loadPage: async () => (await import('./ContractPage')).ContractPage,
};
