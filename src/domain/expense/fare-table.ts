/**
 * ドメイン: 運賃マスタ（ExpenseFareTable。docs/21 §20.2.10。UC8。ワークスペースに 1 つ。照合と CSV は C）。
 *
 * 路線図を持たず「駅の並び × 券種 × 片道運賃 × 有効期間」を利用者のデータとして持つ（外部の経路検索は使わない。ADR-0043 §11）。
 * 駅名の比較キー（別名・「駅」の除去）は C の `input/station.ts`。ここの重なりの検査は表記の揺れを吸収しない
 * 最小の正規化（NFKC・空白除去）で、同じ入力の二重登録だけを断る。
 */
import { assertIsoDateTime, type IsoDateTime } from '../shared/time';
import { isIsoDate } from '../journal/document';
import { ExpenseDomainError } from './errors';
import type { ExpenseFareRouteId } from './ids';
import { ROUTE_FARE_TYPES, validateStations, type FareType } from './receipt-facts';

export const FARE_ROUTE_ID_PATTERN = /^[a-z0-9_.-]{1,64}$/u;
export const FARE_TABLE_MAX_ROUTES = 2000;
export const FARE_TABLE_MAX_ALIASES = 500;
export const FARE_MAX = 100_000;
export const DEFAULT_FARE_TABLE_UPDATED_AT = '2026-09-15T00:00:00.000Z';

export interface FareRoute {
  readonly id: ExpenseFareRouteId;
  /** [出発, …経由, 到着]。 */
  readonly stations: readonly string[];
  readonly fareType: FareType;
  /** 片道運賃（円）。 */
  readonly fare: number;
  readonly bidirectional: boolean;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly note?: string;
}

export interface StationAlias {
  /** 代表名。 */
  readonly name: string;
  readonly aliases: readonly string[];
}

export interface ExpenseFareTable {
  readonly routes: readonly FareRoute[];
  readonly stationAliases: readonly StationAlias[];
  readonly updatedAt: IsoDateTime;
}

const fail = (message: string): ExpenseDomainError => new ExpenseDomainError(message);

function withDefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function simpleKey(stations: readonly string[]): string {
  return stations.map((station) => station.normalize('NFKC').replace(/\s+/gu, '')).join('>');
}

function overlaps(left: FareRoute, right: FareRoute): boolean {
  const leftFrom = left.validFrom ?? '0000-01-01';
  const leftTo = left.validTo ?? '9999-12-31';
  const rightFrom = right.validFrom ?? '0000-01-01';
  const rightTo = right.validTo ?? '9999-12-31';
  return leftFrom <= rightTo && rightFrom <= leftTo;
}

export function validateFareRoute(value: unknown, label: string): FareRoute {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string' || !FARE_ROUTE_ID_PATTERN.test(raw['id'])) throw fail(`${label}.id must match ${FARE_ROUTE_ID_PATTERN.source}`);
  if (!(ROUTE_FARE_TYPES as readonly unknown[]).includes(raw['fareType'])) throw fail(`${label}.fareType must be one of ${ROUTE_FARE_TYPES.join(', ')}`);
  const fare = raw['fare'];
  if (typeof fare !== 'number' || !Number.isInteger(fare) || fare < 1 || fare > FARE_MAX) throw fail(`${label}.fare must be an integer between 1 and ${FARE_MAX}`);
  if (typeof raw['bidirectional'] !== 'boolean') throw fail(`${label}.bidirectional must be a boolean`);
  for (const key of ['validFrom', 'validTo'] as const) {
    if (raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && !isIsoDate(raw[key])) throw fail(`${label}.${key} must be a date in YYYY-MM-DD`);
  }
  const validFrom = raw['validFrom'] === null || raw['validFrom'] === '' ? undefined : raw['validFrom'] as string | undefined;
  const validTo = raw['validTo'] === null || raw['validTo'] === '' ? undefined : raw['validTo'] as string | undefined;
  if (validFrom !== undefined && validTo !== undefined && validFrom > validTo) throw fail(`${label}.validFrom must not be after validTo`);
  const note = raw['note'];
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 200)) throw fail(`${label}.note must be at most 200 characters`);
  return withDefined({
    id: raw['id'],
    stations: validateStations(raw['stations'], `${label}.stations`),
    fareType: raw['fareType'] as FareType,
    fare,
    bidirectional: raw['bidirectional'],
    validFrom,
    validTo,
    note: typeof note === 'string' && note.trim() !== '' ? note.trim() : undefined,
  });
}

export function createExpenseFareTable(props: { readonly routes?: readonly FareRoute[]; readonly stationAliases?: readonly StationAlias[]; readonly updatedAt: string }): ExpenseFareTable {
  if (props === null || typeof props !== 'object') throw fail('expense fare table: props are required');
  const rawRoutes = props.routes ?? [];
  if (!Array.isArray(rawRoutes) || rawRoutes.length > FARE_TABLE_MAX_ROUTES) throw fail(`expense fare table: routes must have at most ${FARE_TABLE_MAX_ROUTES} entries`);
  const routes = rawRoutes.map((route, index) => validateFareRoute(route, `expense fare table: routes[${index}]`));
  const ids = new Set<string>();
  const byKey = new Map<string, FareRoute[]>();
  for (const route of routes) {
    if (ids.has(route.id)) throw fail(`expense fare table: duplicate route id: ${route.id}`);
    ids.add(route.id);
    const key = `${simpleKey(route.stations)}|${route.fareType}`;
    const same = byKey.get(key) ?? [];
    // 同じ駅の並び × 券種で有効期間が重なると、どちらの運賃で照合するか決められない。
    const clash = same.find((other) => overlaps(other, route));
    if (clash !== undefined) throw fail(`expense fare table: routes ${clash.id} and ${route.id} have the same stations and fare type with overlapping validity`);
    byKey.set(key, [...same, route]);
  }
  const rawAliases = props.stationAliases ?? [];
  if (!Array.isArray(rawAliases) || rawAliases.length > FARE_TABLE_MAX_ALIASES) throw fail(`expense fare table: stationAliases must have at most ${FARE_TABLE_MAX_ALIASES} entries`);
  const stationAliases = rawAliases.map((entry: unknown, index): StationAlias => {
    const label = `expense fare table: stationAliases[${index}]`;
    const raw = entry as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') throw fail(`${label} must be an object`);
    if (typeof raw['name'] !== 'string' || raw['name'].trim() === '' || raw['name'].trim().length > 40) throw fail(`${label}.name must be 1 to 40 characters`);
    const aliases = raw['aliases'];
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 20 || aliases.some((alias) => typeof alias !== 'string' || alias.trim() === '' || alias.trim().length > 40)) {
      throw fail(`${label}.aliases must be 1 to 20 names of 1 to 40 characters`);
    }
    return { name: raw['name'].trim(), aliases: [...new Set((aliases as string[]).map((alias) => alias.trim()))] };
  });
  assertIsoDateTime(props.updatedAt, 'expense fare table: updatedAt', fail);
  return { routes, stationAliases, updatedAt: props.updatedAt };
}

export function emptyExpenseFareTable(updatedAt: string = DEFAULT_FARE_TABLE_UPDATED_AT): ExpenseFareTable {
  return { routes: [], stationAliases: [], updatedAt };
}
