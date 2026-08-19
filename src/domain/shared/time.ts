/**
 * ドメイン共有: ISO 8601 日時文字列のドメインプリミティブ(ADR-0034 / ADR-0035)
 *
 * タイムスタンプ生成は注入クロック(`this.now().toISOString()`)で統一済みのため、
 * ここで導入するのは**型**である。`Flavor`(弱ブランド)なので素の string から代入でき、
 * 既存コード・既存テストを変更せずに「日時のつもりの string」をコンパイル時に区別できる。
 *
 * - domain 層の非 Serialized 型の `xxxAt` フィールドはこの型で注釈する。
 * - serialization 系の `Serialized*` 型と zod スキーマは素の string のまま(境界はプリミティブ)。
 * - 既存ファクトリへの ISO 形式検証の追加は行わない(挙動変更になる。検証強化は
 *   将来の BC ごとの意図的採用に委ねる — ADR-0034 の負債台帳項目)。
 */
import type { Flavor } from './brand';
import type { ErrorFactory } from './errors';
import { SharedValidationError } from './errors';

const defaultFail: ErrorFactory = (message) => new SharedValidationError(message);

/** ISO 8601 の日時文字列(`Date#toISOString()` の形)。素の string から代入可(弱ブランド)。 */
export type IsoDateTime = Flavor<string, 'IsoDateTime'>;

/**
 * `date.toISOString()` の型付きラッパー。
 * Flavor は string から代入可能なので `as` は不要。
 */
export function isoDateTime(date: Date): IsoDateTime {
  return date.toISOString();
}

/**
 * ISO 8601 日時の形式検査。`toISOString()` の出力(UTC・ミリ秒3桁)に限定せず、
 * 秒とタイムゾーン(`Z` または `±hh:mm`)を必須とし、小数秒は 1〜9 桁まで許す。
 * 桁だけ合う架空の日付(13月など)は `Date.parse` で落とす。
 */
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 の日時文字列かどうか(型ガード)。 */
export function isIsoDateTime(value: unknown): value is IsoDateTime {
  return typeof value === 'string' && ISO_DATE_TIME_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** ISO 8601 日時でなければ `${label} must be an ISO 8601 date-time string` を fail で投げる。 */
export function assertIsoDateTime(
  value: unknown,
  label: string,
  fail: ErrorFactory = defaultFail,
): asserts value is IsoDateTime {
  if (!isIsoDateTime(value)) {
    throw fail(`${label} must be an ISO 8601 date-time string`);
  }
}
