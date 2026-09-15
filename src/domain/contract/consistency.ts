/**
 * ドメイン: 突き合わせガード（docs/23 §5.3。値は補正しない）。
 *
 * 仕訳の「税率別合計 ≠ 総額」に相当する、誤読を人に見せる最後の網。抽出した値と、根拠の引用の中にある
 * 日付・期間表現（`date-expressions.ts`）が合わなければ `deadline-mismatch`（warning）を付ける。
 *
 * | チェック | 内容 |
 * |---|---|
 * | G1 期間の整合 | 始期・満了日・期間がそろうとき、R1 の計算値と明記の満了日が一致するか（1 日ずれは文言を変える） |
 * | G2 通知期間 | 通知の数と単位が、引用内の期間表現に含まれるか |
 * | G3 期間の日付 | 始期・満了日が引用内の日付（和暦換算後）のどれかと一致するか |
 * | G4 更新期間 | 更新の月数が引用内の期間表現と一致するか（「同一条件」なら初回期間と比べる） |
 * | G5 取りこぼし | 期間・更新・通知の引用にあるのに値に使われていない日付・期間表現を列挙（code なしの補足） |
 *
 * G6（締結日が始期より後）と G7（通知期限の経過）は締結登録の時点で `signed-contract.ts` が見る。
 */
import { daysBetween } from './calendar';
import type { AutoRenewalValue, NoticeValue, TermValue, ValueKind } from './clause-value';
import { scanDates, scanDurations } from './date-expressions';
import { computeTermEndDate, monthsBetweenTerm } from './deadline';
import type { Clause, ClauseWarning } from './document';

export interface TopicKind {
  readonly id: string;
  readonly valueKind: ValueKind;
}

function quotesOf(clause: Clause): string {
  return clause.evidence.map((entry) => entry.quote).join('\n');
}

function mismatch(message: string, days?: number): ClauseWarning {
  return { code: 'deadline-mismatch', message, origin: 'consistency', ...(days === undefined ? {} : { days }) };
}

/** 期間の月数（明記が無ければ始期と満了日から R1 で逆算）。 */
export function termMonthsOf(value: TermValue): number | undefined {
  if (value.durationMonths !== undefined) return value.durationMonths;
  return value.startDate !== undefined && value.endDate !== undefined ? monthsBetweenTerm(value.startDate, value.endDate) : undefined;
}

function termWarnings(value: TermValue, quote: string): ClauseWarning[] {
  const warnings: ClauseWarning[] = [];
  if (value.startDate !== undefined && value.endDate !== undefined && value.durationMonths !== undefined) {
    const computed = computeTermEndDate(value.startDate, value.durationMonths);
    if (computed !== undefined && computed !== value.endDate) {
      const days = daysBetween(computed, value.endDate);
      warnings.push(mismatch(Math.abs(days) === 1
        ? `始期 ${value.startDate} から ${value.durationMonths} か月の満了日は ${computed} ですが、本文の満了日は ${value.endDate} です（始期を含めない書き方の可能性があります）`
        : `始期 ${value.startDate} から ${value.durationMonths} か月の満了日は ${computed} ですが、本文の満了日は ${value.endDate} です`, days));
    }
  }
  if (quote !== '') {
    const dates = new Set(scanDates(quote).map((entry) => entry.iso));
    for (const [label, date] of [['始期', value.startDate], ['満了日', value.endDate]] as const) {
      if (date !== undefined && !dates.has(date)) warnings.push(mismatch(`${label} ${date} が根拠の引用の中の日付（${[...dates].join('、') || 'なし'}）と一致しません`));
    }
  }
  return warnings;
}

function noticeWarnings(value: NoticeValue, quote: string): ClauseWarning[] {
  if (quote === '') return [];
  const durations = scanDurations(quote);
  const found = durations.some((entry) => value.unit === 'month' ? entry.months === value.amount : entry.days === value.amount);
  return found ? [] : [mismatch(`通知期間「${value.amount}${value.unit === 'month' ? 'か月' : '日'}」が根拠の引用の中の期間表現（${durations.map((entry) => entry.raw).join('、') || 'なし'}）と一致しません`)];
}

function renewalWarnings(value: AutoRenewalValue, quote: string, termMonths: number | undefined): ClauseWarning[] {
  if (!value.renews) return [];
  const durations = scanDurations(quote);
  if (value.renewalMonths !== undefined && quote !== '' && !durations.some((entry) => entry.months === value.renewalMonths)) {
    return [mismatch(`更新期間「${value.renewalMonths}か月」が根拠の引用の中の期間表現（${durations.map((entry) => entry.raw).join('、') || 'なし'}）と一致しません`)];
  }
  if (value.sameAsInitial && value.renewalMonths !== undefined && termMonths !== undefined && value.renewalMonths !== termMonths) {
    return [mismatch(`更新は「同一条件」ですが、更新期間 ${value.renewalMonths} か月が初回の期間 ${termMonths} か月と違います`)];
  }
  return [];
}

/** G5: 引用にあるのに値に使われていない日付・期間表現（補足の説明だけ。判定には影響しない）。 */
function unusedExpressionNotes(clause: Clause, used: { readonly dates: readonly string[]; readonly months: readonly number[]; readonly days: readonly number[] }): ClauseWarning[] {
  const quote = quotesOf(clause);
  if (quote === '') return [];
  const unused = [
    ...scanDates(quote).filter((entry) => !used.dates.includes(entry.iso)).map((entry) => entry.raw),
    ...scanDurations(quote).filter((entry) => !(entry.months !== undefined && used.months.includes(entry.months)) && !(entry.days !== undefined && used.days.includes(entry.days))).map((entry) => entry.raw),
  ];
  return unused.length === 0 ? [] : [{ message: `根拠の引用に値として使っていない日付・期間があります: ${[...new Set(unused)].join('、')}`, origin: 'consistency' }];
}

/**
 * 条項へ突き合わせの警告を付け直す（以前の `consistency` 由来の警告は外す）。
 * 期間・更新・通知のトピックは valueKind で探す（トピックの id はデータなので決め打ちしない）。
 */
export function applyConsistency(clauses: readonly Clause[], topics: readonly TopicKind[]): readonly Clause[] {
  const kindOf = new Map(topics.map((topic) => [topic.id, topic.valueKind]));
  const primaryTerm = topics.filter((topic) => topic.valueKind === 'term').map((topic) => clauses.find((clause) => clause.topicId === topic.id && clause.present && clause.value?.kind === 'term')).find((clause) => clause !== undefined);
  const termMonths = primaryTerm?.value?.kind === 'term' ? termMonthsOf(primaryTerm.value) : undefined;
  return clauses.map((clause) => {
    const kept = clause.warnings.filter((warning) => warning.origin !== 'consistency');
    if (!clause.present || clause.value === undefined) return { ...clause, warnings: kept };
    const quote = quotesOf(clause);
    const value = clause.value;
    const added: ClauseWarning[] = [];
    const kind = kindOf.get(clause.topicId);
    if (kind === 'term' && value.kind === 'term') {
      added.push(...termWarnings(value, quote));
      added.push(...unusedExpressionNotes(clause, { dates: [value.startDate, value.endDate].filter((date): date is string => date !== undefined), months: [termMonthsOf(value)].filter((months): months is number => months !== undefined), days: [] }));
    } else if (kind === 'notice' && value.kind === 'notice') {
      added.push(...noticeWarnings(value, quote));
      added.push(...unusedExpressionNotes(clause, { dates: [], months: value.unit === 'month' ? [value.amount] : [], days: value.unit === 'day' ? [value.amount] : [] }));
    } else if (kind === 'auto_renewal' && value.kind === 'auto_renewal') {
      added.push(...renewalWarnings(value, quote, termMonths));
      added.push(...unusedExpressionNotes(clause, { dates: [], months: [value.renewalMonths, termMonths].filter((months): months is number => months !== undefined), days: [] }));
    }
    return { ...clause, warnings: [...kept, ...added] };
  });
}
