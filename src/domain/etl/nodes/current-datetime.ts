/**
 * ドメイン: ノード `current-datetime`
 *
 * kind: source / arity: 0。
 * 実行時点の日時を **1行** のテーブルとして返す。「今日は何日？」のような相対日付の
 * 問い合わせに Agent が答えられるようにするための組み込みソース。
 *
 * config は `{ timezone?: string }`（IANA名）。省略時はシステムローカルのタイムゾーンを使う。
 * 出力スキーマは固定（inferSchema は常に同じ列を confirmed で返す）:
 * - `now`: date（実行時刻そのもの。timezone に依存しない instant）
 * - `date`: string `YYYY-MM-DD`（timezone 適用後の暦日）
 * - `yearMonth`: string `YYYY-MM`
 * - `time`: string `HH:mm:ss`（24時間表記）
 * - `weekday`: string `Sun`〜`Sat`
 *
 * `Intl.DateTimeFormat` の生成コストは大きいため、time-series-analysis と同じく
 * モジュールスコープでキャッシュする（timezone の妥当性判定も同じ流儀で共有する）。
 */
import { z } from 'zod';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** `current-datetime` の設定。 */
export interface CurrentDatetimeConfig {
  /** IANA タイムゾーン名（例 'Asia/Tokyo'）。省略時はシステムローカル。 */
  readonly timezone?: string;
}

const configSchema = z.object({
  timezone: z.string().min(1).optional(),
});

/** 固定の出力スキーマ（入力に依存しない）。 */
const OUTPUT_SCHEMA: Schema = {
  columns: [
    { name: 'now', type: 'date', nullable: false },
    { name: 'date', type: 'string', nullable: false },
    { name: 'yearMonth', type: 'string', nullable: false },
    { name: 'time', type: 'string', nullable: false },
    { name: 'weekday', type: 'string', nullable: false },
  ],
};

/** timezone 省略（システムローカル）を表すキャッシュキー。 */
const LOCAL_ZONE = '';

/**
 * timezone ごとの `Intl.DateTimeFormat` キャッシュ。
 * 生成コストが支配的なため、呼び出しごとに new せずモジュールスコープで再利用する。
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** timezone が有効かの判定結果キャッシュ（無効な timezone は生成時に RangeError になる）。 */
const zoneSupport = new Map<string, boolean>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached !== undefined) return cached;
  // 無効な timezone はここで RangeError になるため、キャッシュには載らない。
  const created = new Intl.DateTimeFormat('en-US', {
    ...(timezone === LOCAL_ZONE ? {} : { timeZone: timezone }),
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23', weekday: 'short',
  });
  formatters.set(timezone, created);
  return created;
}

function zoneSupported(timezone: string): boolean {
  const cached = zoneSupport.get(timezone);
  if (cached !== undefined) return cached;
  let supported: boolean;
  try { formatterFor(timezone).format(); supported = true; } catch { supported = false; }
  zoneSupport.set(timezone, supported);
  return supported;
}

/** config の timezone をキャッシュキーへ（未指定はローカル）。 */
function zoneOf(config: CurrentDatetimeConfig): string {
  return config.timezone ?? LOCAL_ZONE;
}

/** timezone 適用後の日時部品を取り出す。 */
function partsAt(value: Date, timezone: string): Readonly<Record<string, string>> {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timezone).formatToParts(value)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return parts;
}

/** 実行時刻から出力1行を組み立てる。 */
function rowAt(now: Date, timezone: string): Row {
  const parts = partsAt(now, timezone);
  // en-US + 上記オプションでは全部品が必ず揃うため、既定値は保険。
  const part = (type: string): string => parts[type] ?? '';
  const date = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  return {
    now,
    date,
    yearMonth: date.slice(0, 7),
    time: `${part('hour')}:${part('minute')}:${part('second')}`,
    weekday: part('weekday'),
  };
}

class CurrentDatetimeNode implements EtlNode<CurrentDatetimeConfig> {
  readonly type = 'current-datetime';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): CurrentDatetimeConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`current-datetime: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], config: CurrentDatetimeConfig): SchemaInference {
    // 出力スキーマは入力にも timezone にも依存しない（列は常に同じ）。
    const issues: SchemaIssue[] = zoneSupported(zoneOf(config))
      ? []
      : [{ severity: 'error', message: `current-datetime: unsupported IANA timezone: ${String(config.timezone)}` }];
    return { schema: OUTPUT_SCHEMA, state: issues.length === 0 ? 'confirmed' : 'mismatch', issues };
  }

  execute(_inputs: readonly Table[], config: CurrentDatetimeConfig): Table {
    const timezone = zoneOf(config);
    if (!zoneSupported(timezone)) throw new ConfigError(`current-datetime: unsupported IANA timezone: ${String(config.timezone)}`);
    return { schema: OUTPUT_SCHEMA, rows: [rowAt(new Date(), timezone)] };
  }
}

/** `current-datetime` ノードのシングルトン。 */
export const currentDatetimeNode: EtlNode<CurrentDatetimeConfig> = new CurrentDatetimeNode();
