/**
 * ui/api層: 契約書レビューと期限台帳（docs/23）のエラーの見出し。`src/api/contract-error-mapping.ts` の code 体系に対応する。
 *
 * 業務の見出しは業務ごとのファイルに置き、`error-messages.ts` が連結する（ADR-0039）。見出しは「原因 → 次の一手」まで 1 文で言う。
 */
import type { BusinessErrorMessages } from './business-error-types';

export const CONTRACT_ERROR_MESSAGES: BusinessErrorMessages = {
  headings: {
    CONTRACT_DOMAIN: ['Please check the contract review input', '契約書レビューの入力内容を確認してください'],
    CONTRACT_STATE: ['This contract cannot be changed in its current state. Open it from the step it belongs to', 'この契約は今の状態では変更できません。表示された手順の画面から開き直してください'],
    CONTRACT_PLAYBOOK_NOT_FOUND: ['The review playbook was not found. Reload the playbook list', '審査基準が見つかりませんでした。審査基準の一覧を読み込み直してください'],
    CONTRACT_DOCUMENT_NOT_FOUND: ['The contract document was not found. Reload the document list', '契約書が見つかりませんでした。取込済みの一覧を読み込み直してください'],
    CONTRACT_REVIEW_NOT_FOUND: ['The review was not found. Run the review again', 'レビューが見つかりませんでした。もう一度レビューを実行してください'],
    CONTRACT_SIGNED_NOT_FOUND: ['The signed contract or deadline was not found. Reload the deadline ledger', '締結済み契約または期限が見つかりませんでした。期限台帳を読み込み直してください'],
    // 409。原因（モデル未設定・能力不足）→ 次の一手（設定画面でモデルを変える / テキストを貼り付ける）。
    CONTRACT_EXTRACTION_UNAVAILABLE: [
      'The main model cannot read contracts (it needs structured output, and vision for images). Change the main model in Settings, or paste the contract text instead',
      'main モデルが契約書を読めません（構造化出力、画像なら画像読取が必要です）。設定画面で main モデルを変えるか、契約書のテキストを貼り付けてください',
    ],
    // 502。読み取れた束の結果は文書に残らない（全束が失敗したときだけ出る）ので、再実行かモデル変更を案内する。
    CONTRACT_EXTRACTION_SCHEMA: ['The AI response did not match the expected format. Run it again or try another model', 'AI の応答が形式に合いませんでした。もう一度実行するか、別のモデルを試してください'],
  },
  // 判定の確定で判断が未入力のトピックがあるときは、件数を見出しに入れる（直す場所がそのトピックだから）。
  heading: (payload, language) => {
    const undecided = payload.details?.['undecidedTopicIds'];
    if (payload.code !== 'CONTRACT_DOMAIN' || !Array.isArray(undecided) || undecided.length === 0) return undefined;
    return language === 'ja'
      ? `判断が未入力の条項が ${undecided.length} 件あります（${undecided.join('、')}）。各条項で「受け入れる / 交渉する / 受け入れない」を選んでから確定してください`
      : `${undecided.length} clause type(s) have no decision yet (${undecided.join(', ')}). Choose accept, negotiate, or reject for each before finalizing`;
  },
};
