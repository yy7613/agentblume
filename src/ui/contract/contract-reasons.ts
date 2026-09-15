/**
 * 契約画面: 理由コード → 原因・次にやる操作・その場所を開くボタン（docs/23 §4.5）。
 *
 * エラー/診断は「平易な原因」「次にやる操作」「その場所を開くボタン」を必ず揃えて出す（利用者の方針）。
 * コードの列挙はサーバーの `domain/contract/reasons.ts` と同じ（テストが全 code を網羅する）。
 */
import type { ReasonDetailDto } from '../api/contract-types';
import type { ContractStep, Translate } from './contract-model';

export const UI_REASON_CODES = [
  'clause-missing', 'quote-not-found', 'conflicting-clauses', 'extraction-failed', 'value-unparsed', 'field-missing', 'role-not-set', 'unknown-topic',
  'criterion-failed', 'llm-criterion-failed', 'llm-unclear', 'llm-evidence-missing', 'llm-unavailable', 'payment-over-limit', 'payment-terms-indeterminate',
  'payment-basis-acceptance', 'prohibited-payment-method', 'counterparty-profile-missing', 'deadline-mismatch', 'notice-deadline-passed',
  'stamp-duty-candidate', 'stamp-duty-amount-unknown', 'review-stale',
] as const;

export type ReasonSeverityUi = 'onFail' | 'unresolved' | 'warning' | 'info';

export type ReasonAction =
  | { readonly kind: 'step'; readonly step: ContractStep; readonly label: string; readonly nodeId?: string }
  | { readonly kind: 'settings'; readonly label: string }
  | { readonly kind: 'copy-recommended'; readonly label: string }
  | { readonly kind: 'rescan-all'; readonly label: string }
  | { readonly kind: 'reread'; readonly label: string }
  | { readonly kind: 'rerun-review'; readonly label: string };

export interface ReasonGuide {
  readonly severity: ReasonSeverityUi;
  readonly cause: string;
  readonly next: string;
  readonly actions: readonly ReasonAction[];
}

function value(detail: ReasonDetailDto | undefined, key: string, fallback = '?'): string {
  const entry = detail?.[key];
  return entry === undefined || entry === null ? fallback : String(entry);
}

export function reasonGuide(code: string, detail: ReasonDetailDto | undefined, text: Translate, context: { readonly criterionId?: string; readonly topicId?: string } = {}): ReasonGuide {
  const openClauses = (label: string): ReasonAction => ({ kind: 'step', step: 'clauses', label, ...(context.topicId === undefined ? {} : { nodeId: context.topicId }) });
  const openPlaybook = (label: string, nodeId?: string): ReasonAction => ({ kind: 'step', step: 'playbook', label, ...(nodeId === undefined ? {} : { nodeId }) });
  const openReview = (label: string): ReasonAction => ({ kind: 'step', step: 'review', label, ...(context.topicId === undefined ? {} : { nodeId: context.topicId }) });
  const settings: ReasonAction = { kind: 'settings', label: text('Change the model in Settings', '設定でモデルを変える') };
  const copy: ReasonAction = { kind: 'copy-recommended', label: text('Copy the suggested wording', '修正文案をコピー') };
  switch (code) {
    case 'clause-missing':
      return { severity: 'onFail', cause: text('No clause of this type was found in the contract (including when no article matched the keywords).', 'この種類の条項が本文に見つかりませんでした（キーワードに当たる条文が無い場合を含みます）。'), next: text('If the clause exists, point to it by hand. If not, ask for it to be added with the suggested wording.', '該当条文があれば手で指定します。無ければ推奨文案で条項の追加を求めます。'), actions: [openClauses(text('Point to it in the clauses step', '条項抽出で指定する')), { kind: 'rescan-all', label: text('Read all articles', '全条文を読ませる') }] };
    case 'quote-not-found':
      return { severity: 'unresolved', cause: text('The sentence the AI cited as evidence is not in the contract (it may have been paraphrased or misread).', 'AI が示した根拠の文が本文に見つかりません（言い換え・読み違いの可能性があります）。'), next: text('Select the matching passage in the contract and attach it as the evidence again.', '本文で該当箇所を選択し、根拠を付け直します。'), actions: [openClauses(text('Select the evidence in the text', '本文で根拠を選ぶ'))] };
    case 'conflicting-clauses':
      return { severity: 'unresolved', cause: text('Several clauses of the same type say different things.', '同じ種類の条項が複数あり、内容が食い違っています。'), next: text('Choose the clause that prevails (also check special terms and appendices).', '優先する条文を選びます（特約・別紙の優先条項も確認します）。'), actions: [openClauses(text('Choose the clause', '条文を選ぶ'))] };
    case 'extraction-failed':
      return { severity: 'unresolved', cause: text('Reading this part failed (the AI response did not match the format).', 'この条文の読み取りに失敗しました（AI の応答が形式に合いませんでした）。'), next: text('Read it again. If it keeps failing, enter the value by hand or change the model.', '読み直します。繰り返すなら値を手入力するか、モデルを変えます。'), actions: [{ kind: 'reread', label: text('Read this article again', 'この条文を読み直す') }, settings] };
    case 'value-unparsed':
      return { severity: 'unresolved', cause: text('The clause was found but its value could not be read (for example "to be agreed separately" or business days).', '条文は見つかりましたが値を読み取れませんでした（「別途協議」「営業日」など）。'), next: text('Enter the value by hand, or raise the vague clause as a negotiation point.', '値を手入力するか、定めが曖昧な条項として交渉項目にします。'), actions: [openClauses(text('Enter the value', '値を入力する'))] };
    case 'field-missing':
      return { severity: 'unresolved', cause: text(`The value this criterion looks at is missing (${value(detail, 'field')}).`, `基準が参照する項目（${value(detail, 'field')}）が値にありません。`), next: text('Fill in the value.', '値を補います。'), actions: [openClauses(text('Enter the value', '値を入力する'))] };
    case 'role-not-set':
      return { severity: 'unresolved', cause: text('It is not set whether we are party A or B (client or vendor), so role-specific criteria cannot be checked.', '自社が甲・乙のどちらか（発注側 / 受注側）が未設定で、立場別の基準を評価できません。'), next: text('Choose our party and role in the import step.', '取込ステップで自社の立場を選びます。'), actions: [{ kind: 'step', step: 'import', label: text('Set our role', '立場を設定する') }] };
    case 'unknown-topic':
      return { severity: 'unresolved', cause: text('A criterion refers to a clause type that is disabled or deleted.', '基準が、無効化または削除された条項の種類を参照しています。'), next: text('Fix or delete the criterion in the playbook.', 'プレイブックで基準の対象を直すか削除します。'), actions: [openPlaybook(text('Open the criterion', '基準を開く'), context.criterionId)] };
    case 'criterion-failed':
      return { severity: 'onFail', cause: text(`Does not meet "${value(detail, 'rationale', '')}" (${value(detail, 'field')} is ${value(detail, 'actual')}; the criterion is ${value(detail, 'op')} ${value(detail, 'expected', '')}).`, `基準「${value(detail, 'rationale', '')}」に合いません（${value(detail, 'field')} が ${value(detail, 'actual')}、基準は ${value(detail, 'op')} ${value(detail, 'expected', '')}）。`), next: text('Ask for a change with the suggested wording. If the criterion does not fit reality, revise it.', '推奨文案で修正を求めます。基準が実態に合わなければ基準を見直します。'), actions: [copy, openPlaybook(text('Open the criterion', '基準を開く'), context.criterionId)] };
    case 'llm-criterion-failed':
      return { severity: 'onFail', cause: text(`According to the AI, the clause does not meet "${value(detail, 'question', '')}" (reason: ${value(detail, 'reasoning', '')}).`, `AI の判断では基準「${value(detail, 'question', '')}」に合いません（理由: ${value(detail, 'reasoning', '')}）。`), next: text('Read the quoted clause and the reason, then make the decision yourself.', '引用された条文と理由を読み、人が判断を確定します。'), actions: [openReview(text('Show the clause', '条文を表示'))] };
    case 'llm-unclear':
      return { severity: 'unresolved', cause: text('The AI could not decide this criterion.', 'AI はこの基準を判断できませんでした。'), next: text('Decide it yourself.', '人が判断します。'), actions: [openReview(text('Enter the decision', '判断を入力'))] };
    case 'llm-evidence-missing':
      return { severity: 'unresolved', cause: text('The sentence the AI used as evidence is not in the clause, so its answer was not used.', 'AI の判断の根拠となる文が条文内に見つかりません（AI の判断は採用していません）。'), next: text('Decide it yourself.', '人が判断します。'), actions: [openReview(text('Enter the decision', '判断を入力'))] };
    case 'llm-unavailable':
      return { severity: 'unresolved', cause: text('AI checks need a model setting (the rule-based criteria have been checked).', 'AI による基準判定にはモデルの設定が必要です（決定的な基準は判定済みです）。'), next: text('Choose a model in Settings, or decide it yourself.', '設定でモデルを選ぶか、人が判断します。'), actions: [settings, openReview(text('Enter the decision', '判断を入力'))] };
    case 'payment-over-limit':
      return { severity: 'onFail', cause: text(`Payment can fall up to day ${value(detail, 'maxDays')} after receipt, beyond the setting of ${value(detail, 'limit')} days (example: ${value(detail, 'worstCase', '-')}).`, `支払期日が給付の受領から最長 ${value(detail, 'maxDays')} 日目になり、設定値 ${value(detail, 'limit')} 日を超えます（例: ${value(detail, 'worstCase', '-')}）。`), next: text('Ask for a shorter closing / payment month with the suggested wording.', '締め日・支払月を短縮する文案で修正を求めます。'), actions: [copy, openPlaybook(text('Open the legal settings', '法令設定を開く'), 'legal')] };
    case 'payment-terms-indeterminate':
      return { severity: 'unresolved', cause: text('The longest payment period cannot be computed (closing day or payment day is unknown).', '支払条件から最長日数を計算できません（締め日・支払日が不明です）。'), next: text('Fill in the payment terms.', '支払条件の値を補います。'), actions: [openClauses(text('Enter the value', '値を入力する'))] };
    case 'payment-basis-acceptance':
      return { severity: 'warning', cause: text('Payment is counted from acceptance, so the days from receipt are not fixed.', '支払期日が検収日基準で、受領日からの日数が決まりません。'), next: text('Change it to count from receipt, or check the acceptance period.', '受領日基準へ直すか、検収期間の定めを確かめます。'), actions: [openReview(text('Show the clause', '条文を表示'))] };
    case 'prohibited-payment-method':
      return { severity: 'onFail', cause: text(`The payment method "${value(detail, 'method')}" is prohibited in the settings.`, `支払手段「${value(detail, 'method')}」は設定で禁止に指定されています。`), next: text('Ask for a bank transfer or similar with the suggested wording.', '振込等へ変更する文案で修正を求めます。'), actions: [copy, openPlaybook(text('Open the legal settings', '法令設定を開く'), 'legal')] };
    case 'counterparty-profile-missing':
      return { severity: 'unresolved', cause: text(`It is not entered whether the counterparty is covered by the Subcontract (Toriteki) Act or the Freelance Act, so the payment period check cannot be settled (reference: up to day ${value(detail, 'maxDays')}).`, `相手方が取適法・フリーランス法の対象か未入力のため、支払期日の照合を確定できません（参考値: 最長 ${value(detail, 'maxDays')} 日目）。`), next: text('Choose the counterparty category in the import step.', '取込ステップで相手方の区分を選びます。'), actions: [{ kind: 'step', step: 'import', label: text('Enter the counterparty category', '相手方の区分を入力') }] };
    case 'deadline-mismatch':
      return { severity: 'warning', cause: text(`The extracted dates do not match the dates in the text (${value(detail, 'message', '')}).`, `抽出した期限と本文の日付表現が合いません（${value(detail, 'message', '')}）。`), next: text('Read the term and notice clauses and fix the values.', '契約期間・通知期限の条文を読み、値を直します。'), actions: [openClauses(text('Open the term clause', '期間の条項を開く'))] };
    case 'notice-deadline-passed':
      return { severity: 'warning', cause: text(`The renewal notice deadline has already passed at registration (${value(detail, 'date', '')}).`, `更新拒絶の通知期限は締結登録時点で既に過ぎています（${value(detail, 'date', '')}）。`), next: text('Check the deadline of the next term and talk to the counterparty if needed.', '次の更新期の期限を確認し、必要なら相手方と協議します。'), actions: [{ kind: 'step', step: 'ledger', label: text('Open the deadline ledger', '期限台帳を開く') }] };
    case 'stamp-duty-candidate':
      return { severity: 'info', cause: text(`This may be a taxable document (${value(detail, 'name', '')}; nature: ${value(detail, 'nature', '')}; tax: ${value(detail, 'amount', 'unknown')}).`, `課税文書（${value(detail, 'name', '')}）に当たる可能性があります（契約の性質: ${value(detail, 'nature', '')}、税額: ${value(detail, 'amount', '不明')}）。`), next: text('If you sign on paper, check whether stamp duty applies and how much.', '紙で締結するなら印紙の要否と金額を確認します。'), actions: [{ kind: 'step', step: 'sign', label: text('Record the stamp on the sign step', '締結登録で印紙を記録') }, openPlaybook(text('Open the stamp duty table', '印紙税表を開く'), 'stampDuty')] };
    case 'stamp-duty-amount-unknown':
      return { severity: 'info', cause: text('This is a candidate for a No. 2 document but the contract amount is unknown, so the tax cannot be decided.', '第 2 号文書の候補ですが、契約金額が読み取れず税額を決められません。'), next: text('Enter the contract amount.', '契約金額を入力します。'), actions: [{ kind: 'step', step: 'sign', label: text('Enter the amount', '金額を入力') }] };
    case 'review-stale':
      return { severity: 'warning', cause: text('The clauses or the playbook changed after the review.', '判定の後に条項またはプレイブックが変わりました。'), next: text('Run the review again.', '再レビューします。'), actions: [{ kind: 'rerun-review', label: text('Run the review again', '再レビュー') }] };
    default:
      return { severity: 'unresolved', cause: code, next: text('Check the clause and decide it yourself.', '条項を確かめて人が判断します。'), actions: [openReview(text('Open the review', 'レビューを開く'))] };
  }
}
