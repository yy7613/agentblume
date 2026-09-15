/**
 * application層: 理由コードの日本語の文言（ツールの行・申請者向けの差し戻し文言。docs/21 §4 / §20.4）。
 *
 * 画面の文言（日英）は `ui/expense/expense-model.ts` の `summarizeCheck` が持つ。ここはサーバー側で文を作る 2 用途:
 * 1. ツール `expense_check_receipt` の `message`（原因）/ `fix`（直し方）。エージェントがそのまま利用者へ伝えられる文。
 * 2. 差し戻し文言の既定形（`buildReturnMessage`）。経理側の問題（規程が未保存・読取の注意点など）は含めない。
 *
 * 全コードを網羅していることをテストで固定する（型でも `Record<ExpenseReasonCode, …>` で漏れを検出する）。
 */
import { itemLabel, returnReasonsOf, unacknowledgedReviewReasons, type ExpenseClaim } from '../../domain/expense/claim';
import type { CheckReason, ReasonParamValue } from '../../domain/expense/judgment';
import { REASON_CATALOG, type ExpenseReasonCode } from '../../domain/expense/reason-codes';

type Params = Readonly<Record<string, ReasonParamValue>>;

interface ReasonMessage {
  readonly cause: (params: Params) => string;
  readonly fix: (params: Params) => string;
  /** 申請者向け（`REASON_CATALOG[code].applicantFacing` のものだけ）。 */
  readonly applicant?: (params: Params) => string;
}

function text(params: Params, key: string): string {
  const value = params[key];
  return value === null || value === undefined ? '' : String(value);
}

function yen(params: Params, key: string): string {
  const value = params[key];
  return typeof value === 'number' ? value.toLocaleString('ja-JP') : text(params, key);
}

const PAYMENT_METHOD_LABELS: Readonly<Record<string, string>> = {
  cash: '現金', credit_card: 'クレジットカード', bank_transfer: '振込', qr: 'QR コード決済', e_money: '電子マネー', direct_debit: '口座振替', unknown: '不明', corporate: '会社払い',
};

const weakNote = (params: Params): string => (params['weak'] === true ? '（支払先が空のため、取引日・金額・費目だけで照合しています）' : '');

/** 差し込み値があるか（null・undefined・空文字は「無い」。注記の出し分けに使う）。 */
function present(params: Params, key: string): boolean {
  const value = params[key];
  return value !== null && value !== undefined && value !== '';
}

/*
 * 実用化の 16 コード（§20.4）の注記。画面（`ui/expense/expense-model.ts`）が同じ条件で同じ文を組み立て、テストで一致を固定する。
 * 系統の contributor は `params` に値だけを入れ、文の組み立てはここに寄せる（系統ごとに言い回しが揺れないため）。
 */

/** 仮払の状態（B の `ADVANCE_STATUSES`）。知らない値はそのまま出す。 */
export const ADVANCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  requested: '申請中', approved: '承認済み', paid: '支払済み', settling: '精算中', settled: '精算済み', cancelled: '取消',
};

/** 承認者が決まらない原因（`APPROVAL_UNRESOLVED_CAUSES`）→ 原因の文と直し方。§20.4.1 の 6 件に、申請者が紐付かないときを足す。 */
export function approvalCauseText(params: Params): { readonly causeText: string; readonly causeFix: string } {
  switch (params['cause']) {
    case 'manager-missing': return { causeText: `${text(params, 'claimant')} さんの上長が未設定です`, causeFix: '従業員マスタで上長を設定してください' };
    case 'manager-disabled': return { causeText: `上長 ${text(params, 'manager')} さんが無効です`, causeFix: '上長を設定し直してください' };
    case 'department-head-missing': return { causeText: `部門「${text(params, 'department')}」とその上位の部門に部門長がいません`, causeFix: '組織で部門長を設定してください' };
    case 'group-empty': return { causeText: `承認グループ「${text(params, 'group')}」に有効なメンバーがいません`, causeFix: '組織でメンバーを足してください' };
    case 'employee-disabled': return { causeText: `指定の承認者 ${text(params, 'employee')} さんが無効です`, causeFix: '規程の承認経路で承認者を選び直してください' };
    case 'only-claimant': return { causeText: '承認者が申請者本人しかいません', causeFix: '別の承認者を足すか、規程の承認経路を見直してください' };
    // 上長・部門長の経路は申請者の従業員から辿るので、紐付かなければ決まらない（claimant-unlinked の理由と並んで出る）。
    case 'claimant-unlinked': return { causeText: '申請者が従業員マスタに紐付いていません', causeFix: '申請の編集で申請者を従業員マスタから選んでください' };
    default: return { causeText: '承認者を決められません', causeFix: '従業員マスタ・組織・規程の承認経路を確認してください' };
  }
}

export function fareTypeLabel(params: Params): string {
  const value = params['fareType'];
  return value === 'ic' ? 'IC' : value === 'ticket' ? '切符' : text(params, 'fareType');
}

/** カード照合の注記（弱い一致・日付のずれ）。弱い一致の文言は重複の weakNote と別（照合の根拠が違う）。 */
export function cardMatchNote(params: Params): string {
  const weak = params['weak'] === true ? '（加盟店名が一致しないため、日付と金額だけで照合しています）' : '';
  const diff = params['dateDiffDays'];
  const shifted = typeof diff === 'number' && diff !== 0 ? `（利用日と ${String(Math.abs(diff))} 日ずれ）` : '';
  return `${weak}${shifted}`;
}

export const REASON_MESSAGES: Readonly<Record<ExpenseReasonCode, ReasonMessage>> = {
  'policy-unreviewed': {
    cause: () => '規程が初期テンプレートのまま保存されていません。上限額などが自社の規程と違う可能性があります',
    fix: () => '規程ステップで費目と上限額を確認して「保存」を押し、もう一度チェックしてください',
  },
  'claimant-unlinked': {
    cause: (p) => `申請者「${text(p, 'claimant')}」が従業員マスタの誰にも紐付いていません${present(p, 'candidates') ? `（同じ名前の従業員: ${text(p, 'candidates')}）` : ''}`,
    fix: () => '申請の編集で申請者を従業員マスタから選んでください。マスタに居なければ先に従業員を登録します。承認経路・定期区間の控除・振込データは、紐付いた申請者でしか使えません',
  },
  'claimant-employee-disabled': {
    cause: (p) => `申請者「${text(p, 'claimant')}」は従業員マスタで${p['missing'] === true ? '見つかりません（削除されたデータの可能性があります）' : '無効になっています'}`,
    fix: () => '退職・異動の前の支出で本人の申請なら確認済みにしてください。別の人なら申請者を選び直してください',
  },
  'advance-employee-mismatch': {
    cause: (p) => `紐付けた仮払 ${text(p, 'advanceId')}（${text(p, 'advanceEmployee')} さん）は、この申請の申請者のものではありません`,
    fix: () => '正しい仮払を選び直すか、仮払の紐付けを外してください',
  },
  'advance-not-paid': {
    cause: (p) => `紐付けた仮払 ${text(p, 'advanceId')} はまだ支払済みではありません（状態: ${ADVANCE_STATUS_LABELS[text(p, 'advanceStatus')] ?? text(p, 'advanceStatus')}）`,
    fix: () => '仮払を渡したなら仮払台帳で「支払済みにする」を押してください。渡していなければ紐付けを外して通常の立替精算にします',
  },
  'advance-already-settled': {
    cause: (p) => `紐付けた仮払 ${text(p, 'advanceId')} は ${text(p, 'settledOn')} に精算済みです`,
    fix: () => '別の仮払に紐付けるか、紐付けを外して通常の立替精算にしてください',
  },
  'approval-route-unresolved': {
    cause: (p) => `承認経路「${text(p, 'routeName')}」の段「${text(p, 'stepName')}」の承認者が決まりません（${approvalCauseText(p).causeText}）`,
    fix: (p) => `${approvalCauseText(p).causeFix}。直すまでこの申請は承認できません`,
  },
  'claim-empty': {
    cause: () => 'この申請には明細がありません',
    fix: () => '取込ステップで領収書か明細を追加してください',
    applicant: () => '明細が 1 件もありません。精算する領収書を添付してください',
  },
  'category-missing': {
    cause: (p) => `費目が決まっていません（取込時の値「${text(p, 'categoryText')}」に一致する費目がありません）`,
    fix: (p) => `明細の費目を選んでください。いつも同じ書き方なら、規程の費目の「別名」に「${text(p, 'categoryText')}」を足すと次から自動で当たります`,
    applicant: (p) => `明細「${text(p, 'description')}」が何の費用か分かりません。用途（交通費・会議費など）を記入してください`,
  },
  'category-unknown': {
    cause: (p) => `費目「${text(p, 'categoryId')}」が規程に無いか、無効になっています`,
    fix: () => '別の費目を選び直すか、規程でその費目を有効に戻してください',
  },
  'amount-missing': {
    cause: () => '金額がありません（0 円以下も含む）。電子帳簿保存法の検索要件「取引金額」を満たしません',
    fix: () => '領収書を見て税込の支払額を入力してください',
    applicant: (p) => `明細「${text(p, 'description')}」の金額が読み取れません。金額が見えるように領収書を添付し直してください`,
  },
  'date-missing': {
    cause: (p) => `取引日がありません${p['issueDate'] === null || p['issueDate'] === undefined ? '' : `（発行日 ${text(p, 'issueDate')} はあります）`}。電子帳簿保存法の検索要件「取引年月日」を満たしません`,
    fix: () => '領収書の取引日を入力してください。発行日と同じなら「発行日を取引日にする」を押してください',
    applicant: (p) => `明細「${text(p, 'description')}」の利用日が分かりません。利用日を記入してください`,
  },
  'payee-missing': {
    cause: (p) => `支払先（店名・事業者名）がありません。電子帳簿保存法の検索要件「取引先」を満たしません${p['readerHint'] === true ? '（精算書・伝票の読取では支払先が空になりやすいため、元の領収書を確認してください）' : ''}`,
    fix: () => '領収書の発行者名（店舗名・支店名まで）を入力してください',
    applicant: (p) => `明細「${text(p, 'description')}」の支払先（お店・会社の名前）を記入してください`,
  },
  'purpose-missing': {
    cause: (p) => `費目「${text(p, 'category')}」は目的の記入が必要ですが、空欄です`,
    fix: () => '誰と・何のための支出かを入力してください',
    applicant: (p) => `明細「${text(p, 'description')}」の目的（誰と・何のために）を記入してください`,
  },
  'receipt-missing': {
    cause: (p) => (p['exemptBelow'] === null ? `費目「${text(p, 'category')}」は領収書が必要ですが、添付がありません` : `費目「${text(p, 'category')}」は ${yen(p, 'exemptBelow')} 円以上で領収書が必要ですが、添付がありません`),
    fix: () => '領収書の画像を添付してください。領収書が出ない支払い（IC カードなど）の費目なら、規程の費目で「領収書の要否」を見直してください',
    applicant: (p) => `明細「${text(p, 'description')}」の領収書を添付してください`,
  },
  'receipt-extraction-warning': {
    cause: (p) => `読み取りに注意点があります: ${text(p, 'warnings')}`,
    fix: () => '領収書の画像と見比べて、金額・日付・登録番号が正しいか確かめてください。値は自動で直していません',
  },
  'receipt-amount-mismatch': {
    cause: (p) => `税率別の内訳の合計 ${yen(p, 'sum')} 円が金額 ${yen(p, 'amount')} 円と ${yen(p, 'diff')} 円ずれています（許容 ${text(p, 'tolerance')} 円）`,
    fix: () => 'どちらかの読み取り・入力の誤りです。領収書を見て正しい方に直してください',
    applicant: (p) => `明細「${text(p, 'description')}」の金額と内訳が合いません。領収書の合計金額を確認してください`,
  },
  'date-substituted-by-issue-date': {
    cause: (p) => `取引日 ${text(p, 'date')} は、読取で利用日が見つからず発行日を使った値です`,
    fix: () => '領収書の利用日と見比べてください。違えば取引日を直し、同じなら取引日欄を確認して保存すると消えます。値は自動で直していません',
  },
  'receipt-reads-disagree': {
    cause: (p) => `2 回の読取で値が食い違っています: ${text(p, 'disagreements')}`,
    fix: () => '領収書を見て正しい値を入力してください。どちらの値も自動では採用していません',
  },
  'read-values-unconfirmed': {
    cause: (p) => `${text(p, 'fields')}は読取で入れた候補のままで、人が確認していません`,
    fix: () => '領収書と申請者の説明を確かめ、正しければその欄を確認して保存してください（保存すると消えます）',
  },
  'date-in-future': {
    cause: (p) => `取引日 ${text(p, 'date')} が今日より後です`,
    fix: () => '取引日の入力（年の打ち間違い・和暦の換算）を確認してください',
    applicant: (p) => `明細「${text(p, 'description')}」の利用日 ${text(p, 'date')} が未来の日付です。正しい日付を記入してください`,
  },
  'date-outside-period': {
    cause: (p) => `取引日 ${text(p, 'date')} が申請期間 ${text(p, 'from')}〜${text(p, 'to')} の外です`,
    fix: () => '申請期間を直すか、この明細を該当期間の申請へ移してください',
    applicant: (p) => `明細「${text(p, 'description')}」（${text(p, 'date')}）は今回の精算期間 ${text(p, 'from')}〜${text(p, 'to')} の対象外です。該当する期間の申請で出してください`,
  },
  'submission-late': {
    cause: (p) => `取引日 ${text(p, 'date')} から取込まで ${text(p, 'days')} 日経っています（規程の期限 ${text(p, 'limitDays')} 日）`,
    fix: () => '遅れの理由を確認し、認めるなら確認済みにしてください',
    applicant: (p) => `明細「${text(p, 'description')}」は提出期限（利用日から ${text(p, 'limitDays')} 日）を過ぎています。遅れた理由を記入してください`,
  },
  'payment-not-reimbursable': {
    cause: (p) => `支払方法「${PAYMENT_METHOD_LABELS[text(p, 'paymentMethod')] ?? text(p, 'paymentMethod')}」は立替精算の対象外です（会社のカード等は会社側の明細から計上されるため二重計上になります）`,
    fix: () => '支払方法の入力を確認し、会社払いならこの明細を削除してください',
    applicant: (p) => `明細「${text(p, 'description')}」は会社のカード等で支払われているため精算できません。立替えた場合は支払方法を訂正してください`,
  },
  'registration-number-missing': {
    cause: (p) => {
      const raw = p['raw'] === null || p['raw'] === undefined ? '' : `（読み取った「${text(p, 'raw')}」は数字 ${text(p, 'digits')} 桁のため採用していません）`;
      const tail = p['date'] === null ? '取引日が無いため経過措置の割合は決まりません' : `取引日 ${text(p, 'date')} 時点の経過措置（${text(p, 'deductionRate')}%）になります`;
      return `登録番号（T + 13 桁）がありません${raw}。適格請求書でなければ、仕入税額控除は${tail}`;
    },
    fix: () => '領収書に登録番号があれば入力してください。無ければ相手が免税事業者か確認して確認済みにしてください。登録番号の要らない費目（3 万円未満の公共交通機関など）なら規程の費目で設定を見直してください',
    applicant: (p) => `明細「${text(p, 'description')}」の領収書に登録番号（T から始まる番号）が見当たりません。インボイス対応の領収書があれば添付し直してください`,
  },
  'route-missing': {
    cause: (p) => `費目「${text(p, 'category')}」は区間（出発駅・到着駅）の記入が必要ですが、${text(p, 'missing')}がありません`,
    fix: () => '出発駅と到着駅を入力してください（経由があれば順に足します）。往復なら回数を 2 にします',
    applicant: (p) => `明細「${text(p, 'description')}」の区間（出発駅・到着駅）を記入してください`,
  },
  'commuter-pass-overlap': {
    cause: (p) => `区間 ${text(p, 'route')} は ${text(p, 'claimant')} さんの通勤定期（${text(p, 'passRoute')}${present(p, 'validTo') ? `、${text(p, 'validTo')} まで` : ''}）の範囲内です`,
    fix: () => '定期で乗れる区間は精算できません。定期の範囲外の移動なら区間を直してください。定期の区間が古ければ従業員マスタで更新してください',
    applicant: (p) => `明細「${text(p, 'description')}」の区間 ${text(p, 'route')} は通勤定期の範囲内のため精算できません。範囲外の移動であれば区間を訂正してください`,
  },
  'commuter-pass-partial-overlap': {
    cause: (p) => {
      // 定期の外の区間と金額の両方が引けたときだけ提案する（片方だけでは直す金額を示せない）。
      const suggest = present(p, 'restRoute') && present(p, 'suggestedAmount') ? `（運賃マスタでは定期の外の ${text(p, 'restRoute')} が ${yen(p, 'suggestedAmount')} 円です）` : '';
      return `区間 ${text(p, 'route')} のうち ${text(p, 'overlapFrom')}〜${text(p, 'overlapTo')} が通勤定期と重なります${suggest}`;
    },
    fix: () => '定期で乗れる部分を除いた金額に直すか、経路上やむを得なければ理由を確かめて確認済みにしてください。金額は自動で直していません',
    applicant: (p) => `明細「${text(p, 'description')}」は通勤定期と重なる区間を含みます。定期の範囲を除いた金額で申請してください`,
  },
  'fare-exceeds-table': {
    cause: (p) => {
      const count = p['candidateCount'];
      const candidates = typeof count === 'number' && count >= 2 ? `、同じ区間の登録 ${text(p, 'candidateCount')} 件のうち最も高い運賃で比べています` : '';
      return `金額 ${yen(p, 'amount')} 円が運賃マスタの ${text(p, 'route')}（${fareTypeLabel(p)}）${yen(p, 'fare')} 円 × ${text(p, 'trips')} 回 = ${yen(p, 'expected')} 円を ${yen(p, 'over')} 円超えています（許容 ${yen(p, 'tolerance')} 円${candidates}）`;
    },
    fix: () => '回数（往復なら 2）と IC / 切符の別を確認してください。運賃が改定されていれば運賃マスタを直してください',
    applicant: (p) => `明細「${text(p, 'description')}」の金額が登録された運賃より高くなっています。回数と経路を確認してください`,
  },
  'fare-route-unknown': {
    cause: (p) => `区間 ${text(p, 'route')}（${fareTypeLabel(p)}）は運賃マスタに登録がありません`,
    fix: () => '運賃を確かめて運賃マスタに登録すると、次から照合されます。一度きりの経路なら確認済みにしてください',
  },
  'per-item-limit-exceeded': {
    cause: (p) => `費目「${text(p, 'category')}」の 1 件上限 ${yen(p, 'limit')} 円を ${yen(p, 'over')} 円超えています（${yen(p, 'amount')} 円）`,
    fix: () => '規程の上限が正しいか確認してください。例外として認める運用なら、重さを「要確認」に変えるか事前承認条件で扱ってください',
    applicant: (p) => `明細「${text(p, 'description')}」は「${text(p, 'category')}」の 1 件あたりの上限 ${yen(p, 'limit')} 円を超えています。事前承認があれば番号を記入してください`,
  },
  'attendees-missing': {
    cause: (p) => `費目「${text(p, 'category')}」は参加人数の記入が必要ですが、空欄です`,
    fix: () => '参加人数を入力してください（申請者を含めるかは規程の申請ルールに従う）',
    applicant: (p) => `明細「${text(p, 'description')}」の参加人数を記入してください`,
  },
  'per-person-limit-exceeded': {
    cause: (p) => `1 人あたり ${yen(p, 'perPerson')} 円（${p['basis'] === 'tax-excluded' ? '税抜' : '税込'}、${text(p, 'count')} 人）が費目「${text(p, 'category')}」の基準 ${yen(p, 'limit')} 円を超えています${p['basisFallback'] === true ? '（税率別の内訳が無く税抜にできないため、税込で判定しました）' : ''}`,
    fix: () => '人数の入力を確認してください。基準を超える飲食費は交際費になるため、費目を変える必要がないか確認してください',
    applicant: (p) => `明細「${text(p, 'description')}」は 1 人あたり ${yen(p, 'limit')} 円の基準を超えています。参加人数と費目が正しいか確認してください`,
  },
  'attendee-details-missing': {
    cause: (p) => `費目「${text(p, 'category')}」は参加者の氏名（社名）と関係の記入が必要ですが、${[p['missingNames'] === true ? '参加者の氏名' : '', p['missingRelation'] === true ? '関係' : ''].filter((part) => part !== '').join('と')}がありません`,
    fix: () => '参加者の氏名または社名と、自社との関係（取引先・社内など）を入力してください',
    applicant: (p) => `明細「${text(p, 'description')}」の参加者（お名前・会社名）と関係を記入してください`,
  },
  'unit-count-missing': {
    cause: (p) => `費目「${text(p, 'category')}」は${text(p, 'unitLabel')}数の記入が必要ですが、空欄です`,
    fix: (p) => `${text(p, 'unitLabel')}数を入力してください`,
    applicant: (p) => `明細「${text(p, 'description')}」の${text(p, 'unitLabel')}数を記入してください`,
  },
  'per-unit-limit-exceeded': {
    cause: (p) => `1 ${text(p, 'unitLabel')}あたり ${yen(p, 'perUnit')} 円が上限 ${yen(p, 'limit')} 円を超えています（${yen(p, 'amount')} 円 / ${text(p, 'unitCount')} ${text(p, 'unitLabel')}）`,
    fix: (p) => `${text(p, 'unitLabel')}数の入力と規程の上限を確認してください`,
    applicant: (p) => `明細「${text(p, 'description')}」は 1 ${text(p, 'unitLabel')}あたりの上限 ${yen(p, 'limit')} 円を超えています`,
  },
  'pre-approval-missing': {
    cause: (p) => `事前承認の条件「${text(p, 'ruleName')}」に当たりますが、事前承認の番号・記録がありません`,
    fix: () => '事前承認の番号（稟議番号など）を入力してください。条件が広すぎるなら規程の事前承認条件を見直してください',
    applicant: (p) => `明細「${text(p, 'description')}」は事前承認が必要な支出です（${text(p, 'ruleName')}）。承認番号を記入してください`,
  },
  'duplicate-in-claim': {
    cause: (p) => `この申請の明細「${text(p, 'otherDescription')}」と支払先・取引日・金額が同じです${weakNote(p)}`,
    fix: () => '同じ領収書を 2 回取り込んでいないか確認し、重複ならどちらかを削除してください',
    applicant: (p) => `明細「${text(p, 'description')}」が同じ申請の中で二重に計上されている可能性があります。重複していれば 1 件にしてください`,
  },
  'duplicate-across-claims': {
    cause: (p) => `${text(p, 'claimantName')} さんの申請 ${text(p, 'otherClaimId')}（${text(p, 'otherStatus')}）の明細と支払先・取引日・金額が同じです${weakNote(p)}`,
    fix: () => '相手の申請を開き、同じ支出が既に精算されていないか確認してください。別の支出なら確認済みにしてください',
    applicant: (p) => `明細「${text(p, 'description')}」は過去の申請（${text(p, 'otherClaimId')}）と同じ内容です。既に精算済みでないか確認してください`,
  },
  'duplicate-receipt-image': {
    cause: (p) => `添付の画像が申請 ${text(p, 'otherClaimId')} の明細の画像と同じファイルです`,
    fix: () => '同じ領収書を別の明細・別の申請で使っていないか確認してください',
    applicant: (p) => `明細「${text(p, 'description')}」の領収書は別の申請で使われたものと同じ画像です。正しい領収書を添付してください`,
  },
  'card-charge-claimed': {
    cause: (p) => `法人カード「${text(p, 'cardLabel')}」の ${text(p, 'usedOn')} ${text(p, 'merchant')} ${yen(p, 'cardAmount')} 円の利用と一致します${cardMatchNote(p)}。立替として精算すると二重払いになります`,
    fix: () => '法人カードで払った支出なら、この明細を削除するか支払方法を「会社払い」にしてください。別の支出なら確認済みにしてください',
    applicant: (p) => `明細「${text(p, 'description')}」は会社のカードで支払われた記録があります。ご自身で立て替えていない場合は明細から外してください`,
  },
  'corporate-payment-unmatched': {
    cause: (p) => `会社払いの明細ですが、取り込んだ法人カード明細（${text(p, 'coverage')}）に一致する利用がありません`,
    fix: () => 'カード明細の取込漏れ・金額や日付の入力誤り・別のカードの利用でないか確かめてください。カード台帳から手動で紐付けることもできます',
    applicant: (p) => `明細「${text(p, 'description')}」は会社のカードの利用記録と照合できません。利用日・金額・使ったカードを確認してください`,
  },
  'per-claim-limit-exceeded': {
    cause: (p) => `費目「${text(p, 'category')}」の申請内合計 ${yen(p, 'total')} 円が上限 ${yen(p, 'limit')} 円を ${yen(p, 'over')} 円超えています`,
    fix: () => '規程の上限が正しいか確認し、正しければ申請者へ差し戻してください',
    applicant: (p) => `「${text(p, 'category')}」の合計が 1 回の申請の上限 ${yen(p, 'limit')} 円を超えています。対象の明細を見直してください`,
  },
};

/** 原因と直し方（日本語）。 */
export function reasonText(reason: Pick<CheckReason, 'code' | 'params'>): { readonly cause: string; readonly fix: string } {
  const message = REASON_MESSAGES[reason.code];
  return { cause: message.cause(reason.params), fix: message.fix(reason.params) };
}

/** 申請者向けの文（経理側の問題は undefined）。 */
export function applicantText(reason: Pick<CheckReason, 'code' | 'params'>): string | undefined {
  if (!REASON_CATALOG[reason.code].applicantFacing) return undefined;
  return REASON_MESSAGES[reason.code].applicant?.(reason.params);
}

/**
 * 差し戻し文言の既定形（§7）。差し戻し理由と未確認の要確認理由を明細ごとに番号付きで並べ、
 * 経理側の問題のコードは含めない。人が編集してから送る前提なので保存しない。
 */
export function buildReturnMessage(claim: ExpenseClaim): string {
  const reasons = [...returnReasonsOf(claim), ...unacknowledgedReviewReasons(claim)];
  const order = new Map(claim.items.map((item, index) => [item.id, index]));
  const sorted = [...reasons].sort((left, right) => (left.itemId === undefined ? -1 : (order.get(left.itemId) ?? 0)) - (right.itemId === undefined ? -1 : (order.get(right.itemId) ?? 0)));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const reason of sorted) {
    const sentence = applicantText(reason);
    if (sentence === undefined || seen.has(sentence)) continue;
    seen.add(sentence);
    const index = reason.itemId === undefined ? undefined : order.get(reason.itemId);
    const item = index === undefined ? undefined : claim.items[index];
    const label = item === undefined || index === undefined ? '申請全体' : `明細「${itemLabel(item, index)}」`;
    lines.push(`${lines.length + 1}. ${label}: ${sentence}`);
  }
  return [
    `${claim.claimant.name} さん`,
    `${claim.period.from}〜${claim.period.to} の経費精算（${claim.id}）を差し戻します。次の点を直して、もう一度提出してください。`,
    '',
    ...(lines.length === 0 ? ['（差し戻しの理由として挙げる項目がありません。直してほしい点を書き足してください）'] : lines),
  ].join('\n');
}
