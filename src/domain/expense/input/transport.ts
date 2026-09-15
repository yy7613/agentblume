/**
 * ドメイン: 交通費の照合（docs/21 §20.3.4 / ADR-0043 §11。UC8。純関数）。
 *
 * 外部の経路検索は使わず、利用者のデータ（運賃マスタの「駅の並び × 券種 × 片道運賃 × 有効期間」と、
 * 従業員の通勤定期の「経路順の駅の並び」）だけで決定的に照合する。
 *
 * **検出できないもの**: 路線図を持たないので、駅の並びに書かれていない乗換経路の重なりは見つけられない
 * （例: 定期は A > B > C、明細は A > D > C。両端が定期内でも経由 D が定期の外なので「重なり」と言えない）。
 * 画面（規程タブ・運賃マスタ）と docs/21 に同じ制約を書いている。
 */
import type { CommuterPass } from '../employee';
import type { FareRoute, StationAlias } from '../fare-table';
import type { FareType } from '../receipt-facts';
import { buildStationAliasIndex, formatStations, stationKey, type StationAliasIndex } from './station';

/** 照合に使う運賃マスタの部分。 */
export interface FareTableFacts {
  readonly routes: readonly FareRoute[];
  readonly stationAliases: readonly StationAlias[];
}

interface Validity { readonly validFrom?: string; readonly validTo?: string }

/** 日付に有効か（省略は無制限。日付が無ければ期間で絞らない）。 */
export function validOn(entry: Validity, date: string | undefined): boolean {
  if (date === undefined) return true;
  return (entry.validFrom === undefined || entry.validFrom <= date) && (entry.validTo === undefined || date <= entry.validTo);
}

function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let position = 0;
  for (const value of haystack) {
    if (position < needle.length && value === needle[position]) position += 1;
  }
  return position === needle.length;
}

export interface FareQuery {
  readonly stations: readonly string[];
  readonly fareType: FareType;
  readonly date?: string;
}

/**
 * 区間に当たる運賃マスタの経路: 取引日に有効・同じ券種・両端の駅キーが一致（`bidirectional` なら逆向きも）。
 * 明細に経由があれば経由を順に含む経路に絞る（0 件になれば絞らない）。
 */
export function fareCandidates(query: FareQuery, table: FareTableFacts, index: StationAliasIndex = buildStationAliasIndex(table.stationAliases)): readonly FareRoute[] {
  const keys = query.stations.map((station) => stationKey(station, index));
  const from = keys[0];
  const to = keys[keys.length - 1];
  const vias = keys.slice(1, -1);
  const matched: { readonly route: FareRoute; readonly oriented: readonly string[] }[] = [];
  for (const route of table.routes) {
    if (route.fareType !== query.fareType || !validOn(route, query.date)) continue;
    const routeKeys = route.stations.map((station) => stationKey(station, index));
    const routeFrom = routeKeys[0];
    const routeTo = routeKeys[routeKeys.length - 1];
    if (routeFrom === from && routeTo === to) matched.push({ route, oriented: routeKeys });
    else if (route.bidirectional && routeFrom === to && routeTo === from) matched.push({ route, oriented: [...routeKeys].reverse() });
  }
  if (vias.length === 0) return matched.map((entry) => entry.route);
  const viaMatched = matched.filter((entry) => isSubsequence(vias, entry.oriented.slice(1, -1)));
  return (viaMatched.length > 0 ? viaMatched : matched).map((entry) => entry.route);
}

export type FareCheck =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'within'; readonly fare: number; readonly expected: number; readonly candidateCount: number }
  | { readonly kind: 'exceeds'; readonly fare: number; readonly expected: number; readonly over: number; readonly candidateCount: number };

/**
 * 運賃の照合。運賃マスタに経路が 1 件も無ければ undefined（照合しない = 何も出さない）。
 * 候補が複数なら**最大**運賃を基準にする（どれで行っても超えない額）。ちょうど「運賃 × 回数 + 許容差」は超過にしない。
 */
export function checkFare(input: FareQuery & { readonly trips: number; readonly amount: number; readonly toleranceYen: number }, table: FareTableFacts): FareCheck | undefined {
  if (table.routes.length === 0) return undefined;
  const candidates = fareCandidates(input, table);
  if (candidates.length === 0) return { kind: 'unknown' };
  const fare = Math.max(...candidates.map((route) => route.fare));
  const expected = fare * input.trips;
  if (input.amount > expected + input.toleranceYen) return { kind: 'exceeds', fare, expected, over: input.amount - expected, candidateCount: candidates.length };
  return { kind: 'within', fare, expected, candidateCount: candidates.length };
}

export type CommuterOverlap =
  | { readonly kind: 'full'; readonly pass: CommuterPass }
  | {
    readonly kind: 'partial';
    readonly pass: CommuterPass;
    /** 定期に含まれる駅の範囲（明細に書かれた駅名のまま）。 */
    readonly overlapFrom: string;
    readonly overlapTo: string;
    /** 定期の外の区間（運賃マスタに経路があるときだけ）。 */
    readonly restRoute?: string;
    /** 定期の外の区間の最小運賃 × 回数（金額は直さない。文言の候補）。 */
    readonly suggestedAmount?: number;
  };

export interface CommuterOverlapInput {
  readonly stations: readonly string[];
  readonly trips: number;
  readonly fareType: FareType;
  readonly date: string;
  readonly passes: readonly CommuterPass[];
  readonly table: FareTableFacts;
}

function suggestionFor(rest: readonly string[], input: CommuterOverlapInput, index: StationAliasIndex): { readonly restRoute: string; readonly suggestedAmount: number } | undefined {
  const candidates = fareCandidates({ stations: rest, fareType: input.fareType, date: input.date }, input.table, index);
  if (candidates.length === 0) return undefined;
  return { restRoute: formatStations(rest), suggestedAmount: Math.min(...candidates.map((route) => route.fare)) * input.trips };
}

function overlapWith(pass: CommuterPass, input: CommuterOverlapInput, index: StationAliasIndex): CommuterOverlap | undefined {
  const passKeys = new Set(pass.stations.map((station) => stationKey(station, index)));
  const inPass = input.stations.map((station) => passKeys.has(stationKey(station, index)));
  if (inPass.every((value) => value)) return { kind: 'full', pass };
  const last = input.stations.length - 1;
  if (inPass[0] === true && inPass[last] !== true) {
    let end = 0;
    while (end + 1 <= last && inPass[end + 1] === true) end += 1;
    const suggestion = suggestionFor(input.stations.slice(end), input, index);
    return { kind: 'partial', pass, overlapFrom: input.stations[0]!, overlapTo: input.stations[end]!, ...(suggestion ?? {}) };
  }
  if (inPass[0] !== true && inPass[last] === true) {
    let start = last;
    while (start - 1 >= 0 && inPass[start - 1] === true) start -= 1;
    const suggestion = suggestionFor(input.stations.slice(0, start + 1), input, index);
    return { kind: 'partial', pass, overlapFrom: input.stations[start]!, overlapTo: input.stations[last]!, ...(suggestion ?? {}) };
  }
  if (inPass[0] !== true && inPass[last] !== true) {
    // 両端が定期の外: 経由の連続する 2 駅以上が定期に含まれれば一部重複（外の区間が 2 つあるので金額の候補は出さない）。
    let best: { readonly from: number; readonly to: number } | undefined;
    let runStart = -1;
    for (let position = 1; position <= last; position += 1) {
      const inside = position < last && inPass[position] === true;
      if (inside && runStart < 0) runStart = position;
      if (!inside && runStart >= 0) {
        const runEnd = position - 1;
        if (runEnd - runStart >= 1 && (best === undefined || runEnd - runStart > best.to - best.from)) best = { from: runStart, to: runEnd };
        runStart = -1;
      }
    }
    if (best !== undefined) return { kind: 'partial', pass, overlapFrom: input.stations[best.from]!, overlapTo: input.stations[best.to]! };
  }
  // 両端が定期内で経由が外（A > D > C）は、路線図が無いので重なりとは言えない（検出できないもの）。
  return undefined;
}

/**
 * 通勤定期との重なり。取引日に有効な定期ごとに比べ、全部重なる定期を優先し、次に定期の id の昇順で最初の 1 件。
 * 明細の全駅が定期に含まれれば全部（向きは問わない）、出発か到着の一方だけが含まれる・両端が外で経由の連続 2 駅以上が含まれるなら一部。
 */
export function findCommuterOverlap(input: CommuterOverlapInput): CommuterOverlap | undefined {
  const index = buildStationAliasIndex(input.table.stationAliases);
  const passes = input.passes.filter((pass) => validOn(pass, input.date)).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const overlaps = passes.map((pass) => overlapWith(pass, input, index)).filter((overlap): overlap is CommuterOverlap => overlap !== undefined);
  return overlaps.find((overlap) => overlap.kind === 'full') ?? overlaps[0];
}
