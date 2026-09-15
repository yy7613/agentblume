/**
 * ドメイン: 条項の値の日本語要約（組込みツールの `value_summary` と台帳の表示に使う）。
 *
 * 値を言い換えるだけで、判定・補正はしない。支払条件だけは最長日数（決定的な計算）を添える。
 */
import type { ClauseValue } from './clause-value';
import { paymentMaxDays } from './legal-checks';

const YEN = new Intl.NumberFormat('ja-JP');

function dayLabel(day: number | 'month_end' | 'none' | undefined): string {
  if (day === undefined) return '不明';
  if (day === 'month_end') return '末日';
  if (day === 'none') return '締めなし';
  return `${day}日`;
}

function offsetLabel(offset: number | undefined): string {
  return offset === undefined ? '不明' : offset === 0 ? '当月' : offset === 1 ? '翌月' : offset === 2 ? '翌々月' : `${offset}か月後`;
}

export function summarizeClauseValue(value: ClauseValue | undefined, parties: { readonly A?: string; readonly B?: string } = {}): string | null {
  if (value === undefined) return null;
  switch (value.kind) {
    case 'term': {
      const range = value.startDate !== undefined || value.endDate !== undefined ? `${value.startDate ?? (value.startsOnSigning ? '締結日' : '始期不明')}〜${value.endDate ?? '満了日不明'}` : value.startsOnSigning ? '締結日から' : '';
      return [range, value.durationMonths === undefined ? '' : `（${value.durationMonths}か月）`].join('') || '期間の定めあり（値不明）';
    }
    case 'auto_renewal':
      if (!value.renews) return '自動更新なし';
      return value.renewalMonths !== undefined ? `自動更新あり（${value.renewalMonths}か月ごと）` : value.sameAsInitial ? '自動更新あり（同一期間）' : '自動更新あり（期間不明）';
    case 'notice':
      return `${value.anchor === 'renewal' ? '更新日' : '満了'}の${value.amount}${value.unit === 'month' ? 'か月' : value.businessDays ? '営業日' : '日'}前まで`;
    case 'payment_terms': {
      const basis = { delivery: '受領', acceptance: '検収', invoice: '請求', unknown: '基準日不明' }[value.basis];
      const method = value.method === undefined ? '' : `・${{ bank_transfer: '振込', promissory_note: '手形', electronic_record: '電子記録債権', factoring: 'ファクタリング', cash: '現金', other: 'その他' }[value.method]}`;
      const result = paymentMaxDays(value);
      const longest = result.kind === 'indeterminate' ? '（最長日数は計算不能）' : `（最長 ${result.maxDays} 日目）`;
      if (value.daysAfterBasis !== undefined) return `${basis}後 ${value.daysAfterBasis} 日以内${method}${longest}`;
      return `${basis}基準・${dayLabel(value.closingDay)}締め${offsetLabel(value.payMonthOffset)}${dayLabel(value.payDay)}払い${method}${longest}`;
    }
    case 'liability_cap': {
      const cap = { none: '上限なし', fixed_amount: `上限 ${value.amount === undefined ? '金額不明' : `${YEN.format(value.amount)} 円`}`, fees_paid: '支払済み委託料の総額まで', fees_months: `委託料の${value.months ?? '?'}か月分まで`, unspecified: '上限の定めが不明確' }[value.capKind];
      return `${cap}${value.excludesWillfulOrGross === true ? '（故意・重過失は除く）' : ''}`;
    }
    case 'permission':
      return { free: '自由', prior_consent: '事前の承諾が必要', notify: '通知が必要', prohibited: '禁止' }[value.policy];
    case 'ip_ownership': {
      const owner = value.owner === 'A' ? `甲${parties.A === undefined ? '' : `（${parties.A}）`}に帰属` : value.owner === 'B' ? `乙${parties.B === undefined ? '' : `（${parties.B}）`}に帰属` : value.owner === 'shared' ? '共有' : '帰属の定めが不明確';
      return `${owner}${value.transferOn === undefined ? '' : `（${{ delivery: '納品時', payment: '支払完了時', creation: '発生時' }[value.transferOn]}に移転）`}`;
    }
    case 'jurisdiction':
      return `${value.court ?? '裁判所名なし'}${value.exclusive === true ? '（専属）' : value.exclusive === false ? '（専属ではない）' : ''}`;
    case 'text':
      return value.summary;
  }
}
