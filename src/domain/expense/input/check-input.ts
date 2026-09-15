/**
 * ドメイン: 「入力と規程」の検査関数（contributor。docs/21 §20.3.2 の 3・5a / §20.3.4 / §20.3.6。系統 C）。
 *
 * 出してよいコードは `INPUT_REASON_CODES`（読取の 3 コード・交通費の 5 コード）。
 * - 読取（3）: 明細の `extraction.flags`（構造化した読取の印）だけを見る。印の無い明細（MVP のデータ・手入力・CSV）には何も出ない。
 * - 交通費（5a）: 費目に `route` の設定があり、交通費の照合を使っている構成（運賃マスタに経路 / 申請者に通勤定期）のときだけ。
 *   `route-missing` なら残りを飛ばす。`commuter-pass-overlap` なら運賃の 2 つを飛ばす。取引日が無ければ定期、金額が無ければ運賃を飛ばす。
 *
 * `params` の名前は §20.4 の差し込み値（`application/expense/reason-messages.ts` と `ui/expense/expense-model.ts`）に合わせる。
 */
import type { CheckedClaim, ExpenseCheckContributor, ItemEvaluation, ReasonDraft } from '../check-extensions';
import type { DetailDisagreementField, ExpenseDetailRecord, ExtractionFlag } from '../detail-read';
import type { ExpensePolicy } from '../policy';
import { INPUT_REASON_CODES } from '../reason-codes';
import { digitCount } from '../receipt-facts';
import { transportInUse, type InputCheckFacts } from './check-facts';
import { formatStations } from './station';
import { checkFare, findCommuterOverlap } from './transport';

export type { InputCheckFacts } from './check-facts';

const DISAGREEMENT_LABELS: Readonly<Record<DetailDisagreementField, string>> = {
  registrationNumber: '登録番号', transactionDate: '取引日', issueDate: '発行日', payeeName: '支払先',
};

/** 画面・文言に出す食い違いの最大の欄数（§20.4.2）。 */
export const MAX_DISAGREEMENTS_IN_MESSAGE = 4;

/** 人が確認していない読取の候補（印 → 欄の呼び名）。並びは文言の並び。 */
const UNCONFIRMED_FIELDS: readonly (readonly [ExtractionFlag, string])[] = [
  ['attendees-read', '参加人数'], ['route-read', '区間'], ['payee-read', '支払先'], ['purpose-read', '目的'],
];

/** `{disagreements}` の整形（「登録番号: 仕訳の読取「…」/ 追加の読取「…（数字 12 桁）」」を ` / ` で並べる）。 */
export function formatDisagreements(disagreements: ExpenseDetailRecord['disagreements']): string {
  return disagreements.slice(0, MAX_DISAGREEMENTS_IN_MESSAGE).map((entry) => {
    const detail = entry.detailValue === null
      ? 'なし'
      : entry.field === 'registrationNumber' ? `${entry.detailValue}（数字 ${digitCount(entry.detailValue)} 桁）` : entry.detailValue;
    return `${DISAGREEMENT_LABELS[entry.field]}: 仕訳の読取「${entry.journalValue ?? 'なし'}」/ 追加の読取「${detail}」`;
  }).join(' / ');
}

function readReasons(evaluation: ItemEvaluation): ReasonDraft[] {
  const { extraction } = evaluation.item;
  const flags = new Set(extraction.flags ?? []);
  const reasons: ReasonDraft[] = [];
  // 取引日が無ければ `date-missing` が先に出るので、発行日の代用は言わない。
  if (flags.has('transaction-date-substituted') && evaluation.date !== undefined) {
    reasons.push({ code: 'date-substituted-by-issue-date', params: { date: evaluation.date } });
  }
  if (flags.has('reads-disagree')) {
    reasons.push({ code: 'receipt-reads-disagree', params: { disagreements: formatDisagreements(extraction.detail?.disagreements ?? []) } });
  }
  const fields = UNCONFIRMED_FIELDS.filter(([flag]) => flags.has(flag)).map(([, label]) => label);
  if (fields.length > 0) reasons.push({ code: 'read-values-unconfirmed', params: { fields: fields.join('・') } });
  return reasons;
}

function transportReasons(evaluation: ItemEvaluation, policy: ExpensePolicy, facts: InputCheckFacts | undefined, claim: CheckedClaim | undefined): ReasonDraft[] {
  const category = evaluation.category;
  const settings = category?.route;
  if (category === undefined || settings === undefined || facts === undefined || !transportInUse(facts)) return [];
  const route = evaluation.item.facts.route;
  if (route === undefined) {
    // 区間は駅 2 つ以上でしか保存できないので、欠けるのは常に区間全体。
    return settings.required ? [{ code: 'route-missing', params: { category: category.name, missing: '区間' } }] : [];
  }
  const routeText = formatStations(route.stations);
  const fareType = route.fareType ?? policy.transport.defaultFareType;
  const table = { routes: facts.fareRoutes ?? [], stationAliases: facts.stationAliases ?? [] };
  const employeeId = claim?.claimant?.employeeId;
  const ref: Readonly<Record<string, string>> = employeeId === undefined ? {} : { employeeId };
  const reasons: ReasonDraft[] = [];

  const passes = facts.commuterPasses ?? [];
  if (settings.commuterPass && policy.transport.commuterPassDeduction && evaluation.date !== undefined && passes.length > 0) {
    const overlap = findCommuterOverlap({ stations: route.stations, trips: route.trips, fareType, date: evaluation.date, passes, table });
    if (overlap?.kind === 'full') {
      return [{
        code: 'commuter-pass-overlap',
        params: { route: routeText, claimant: claim?.claimant?.name ?? '', passRoute: formatStations(overlap.pass.stations), ...(overlap.pass.validTo === undefined ? {} : { validTo: overlap.pass.validTo }), ...ref },
      }];
    }
    if (overlap?.kind === 'partial') {
      reasons.push({
        code: 'commuter-pass-partial-overlap',
        params: {
          route: routeText, overlapFrom: overlap.overlapFrom, overlapTo: overlap.overlapTo,
          ...(overlap.restRoute === undefined ? {} : { restRoute: overlap.restRoute }),
          ...(overlap.suggestedAmount === undefined ? {} : { suggestedAmount: overlap.suggestedAmount }),
          ...ref,
        },
      });
    }
  }

  if (settings.fareTable && evaluation.amount !== undefined) {
    const tolerance = policy.transport.fareToleranceYen;
    const result = checkFare({ stations: route.stations, fareType, trips: route.trips, amount: evaluation.amount, toleranceYen: tolerance, ...(evaluation.date === undefined ? {} : { date: evaluation.date }) }, table);
    if (result?.kind === 'unknown') reasons.push({ code: 'fare-route-unknown', params: { route: routeText, fareType } });
    if (result?.kind === 'exceeds') {
      reasons.push({
        code: 'fare-exceeds-table',
        params: { amount: evaluation.amount, route: routeText, fareType, fare: result.fare, trips: route.trips, expected: result.expected, over: result.over, tolerance, candidateCount: result.candidateCount },
      });
    }
  }
  return reasons;
}

export const inputContributor: ExpenseCheckContributor = {
  id: 'input',
  codes: INPUT_REASON_CODES,
  itemReasons: (evaluation, policy, extensions, claim) => [
    ...readReasons(evaluation),
    ...transportReasons(evaluation, policy, extensions.input, claim),
  ],
};
