/**
 * ドメイン: 規程のヒアリング（質問モード）の話題のカタログ（docs/21 §20.7.2。UC9）。
 *
 * **値は持たない**（上限額などの数値は会社のデータで、モデルが利用者に聞く）。ここにあるのは「何を聞くか」の一覧だけ。
 * 固定の規程表を持たない方針（docs/21 §20 冒頭）を守りつつ、12B 級のモデルが聞き漏らさないよう話題を渡す。
 */

export interface HearingTopic {
  readonly id: string;
  /** 利用者に見せる話題の名前。 */
  readonly label: string;
  /** モデルへの手がかり（どの規程の項目に効くか）。 */
  readonly affects: string;
}

export const HEARING_TOPICS: readonly HearingTopic[] = [
  { id: 'entertainment-per-person', label: '交際費の 1 人あたり基準と税込 / 税抜', affects: 'categories の交際費の limits.perPerson と limits.perPersonBasis' },
  { id: 'meeting-per-person', label: '会議費の基準', affects: 'categories の会議費の limits' },
  { id: 'receipt-not-required', label: '領収書が要らない費目', affects: 'categories の receipt.required と receipt.exemptBelow' },
  { id: 'invoice-not-required', label: '登録番号が要らない取引', affects: 'categories の invoice.required と invoice.exemptBelow' },
  { id: 'submission-deadline', label: '提出期限', affects: 'claimRules.submissionDeadlineDays' },
  { id: 'pre-approval', label: '事前承認が要る支出', affects: 'preApprovalRules' },
  { id: 'allowance-lodging', label: '日当・宿泊の上限', affects: 'categories の limits.perUnit' },
  { id: 'taxi', label: 'タクシーの利用条件', affects: 'categories のタクシーの limits と requires.purpose' },
  { id: 'commuter-pass', label: '通勤定期の控除', affects: 'categories の route.commuterPass（従業員の定期区間は画面で登録する）' },
  { id: 'approval-steps', label: '承認の段（上長・部門長・経理）', affects: 'approvalRoutes（段の種類は claimant-manager / department-head / group / any-approver）' },
  { id: 'corporate-card', label: '会社のカードの運用', affects: 'claimRules.nonReimbursablePaymentMethods' },
];

/** カタログに無い話題（モデルが作った話題名）をまとめる鍵。 */
export const OTHER_HEARING_TOPIC = 'other';

export function hearingTopicId(value: unknown): string {
  return typeof value === 'string' && HEARING_TOPICS.some((topic) => topic.id === value) ? value : OTHER_HEARING_TOPIC;
}
