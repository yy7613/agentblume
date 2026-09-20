/**
 * ドメイン: 期間の解釈ノード（`parse-period`）。
 *
 * 政府統計（e-Stat）の CSV は、時点を表す 1 つの列（`時点`）の中に粒度の違うラベルが混ざる:
 * 「1975年10月」（月）・「2024年1-3月期」（四半期）・「2024年」（暦年）・「2024年度」（年度）。
 * 文字列のままでは完全一致しか引けず、期間の範囲指定も時系列順の並べ替えもできない（しかも
 * 年の行と月の行が混ざったまま集計されてしまう）。
 *
 * このノードは、そのラベルを決定的に読み取って
 * - `startColumn`（既定 `periodStart`・型 `date`）= その期間の**開始日**（UTC 深夜 0 時）
 * - `granularityColumn`（既定 `periodGranularity`・型 `string`）= 粒度（`month` / `quarter` / …）
 * の 2 列を足す。粒度で絞ってから開始日で範囲指定・並べ替えるのが定石:
 * `parse-period` → `filter periodGranularity eq month` → `filter periodStart gte/lte` → `sort periodStart`。
 *
 * kind: transform / arity: 1。純粋・同期。読めないラベルは行ごとに握りつぶす（start は null、
 * 粒度は `unknown`）: 1 セルの表記ゆれで数千行の変換を止める方が害が大きい（`cast` と同じ規律）。
 */
import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

/** ノード種別。 */
export const PARSE_PERIOD_TYPE = 'parse-period';

/**
 * 粒度の正準リスト。Factory のデータプロファイラ（期間列の検出）と UI がこの 1 本を共有する。
 * `unknown` は「ラベルを解釈できなかった」であり、粒度の 1 つとして必ず値が入る（null にしない）。
 */
export const PERIOD_GRANULARITIES = ['day', 'month', 'quarter', 'half', 'year', 'fiscal-year', 'unknown'] as const;

/** 期間ラベルの粒度。 */
export type PeriodGranularity = (typeof PERIOD_GRANULARITIES)[number];

/** 1 つのラベルの解釈結果。 */
export interface ParsedPeriod {
  /** 期間の開始日（UTC 深夜 0 時）。解釈できなければ null。 */
  readonly start: Date | null;
  readonly granularity: PeriodGranularity;
}

/** `parse-period` の設定。 */
export interface ParsePeriodConfig {
  /** 期間ラベルが入っている列。 */
  readonly column: string;
  /** 開始日を入れる列名。 */
  readonly startColumn: string;
  /** 粒度を入れる列名。 */
  readonly granularityColumn: string;
  /** 年度の開始月（日本の会計年度は 4）。年度・年度四半期・上期/下期の解釈に使う。 */
  readonly fiscalYearStartMonth: number;
}

const configSchema = z.object({
  column: z.string().min(1),
  startColumn: z.string().min(1).default('periodStart'),
  granularityColumn: z.string().min(1).default('periodGranularity'),
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
});

/** 解釈できなかったラベルの結果（使い回す定数）。 */
const UNPARSED: ParsedPeriod = { start: null, granularity: 'unknown' };

/** 和暦の元号 → 元年の西暦。 */
const ERAS: ReadonlyMap<string, number> = new Map([
  ['明治', 1868],
  ['大正', 1912],
  ['昭和', 1926],
  ['平成', 1989],
  ['令和', 2019],
]);

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
}

/**
 * 年・月・日から UTC 深夜 0 時の Date を作る。範囲外（年 1..9999 / 月 1..12 / その月に無い日）は null。
 * 年 0..99 は `Date.UTC` が 1900 年代へ寄せるので、作った後に西暦年を入れ直す。
 */
function utcDate(year: number, month: number, day: number): Date | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 100) date.setUTCFullYear(year);
  return date;
}

/** 「年 + 月」を 1 本の通し月数にして繰り上がりを扱う（年度第 4 四半期が翌年の 1 月になる等）。 */
function shiftMonth(year: number, month: number, offset: number): { year: number; month: number } {
  const total = (year * 12) + (month - 1) + offset;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

/**
 * ラベルの表記ゆれをならす。NFKC で全角の数字・英字・空白を半角へ寄せ、各種ダッシュを `-` に統一し、
 * 空白をすべて落とす（`FY 2024` や `平成 20 年 4 月` のような空白入りを同じ形にするため）。
 */
function normalizeLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[〜～~−‐‑–—―]/g, '-')
    .replace(/\s+/g, '')
    .trim();
}

/** 和暦の接頭辞（`平成20` / `令和元`）を西暦の年へ置き換える。元号が無ければそのまま返す。 */
function withWesternYear(label: string): string {
  const matched = /^(明治|大正|昭和|平成|令和)(元|\d{1,2})年/.exec(label);
  if (matched === null) return label;
  const base = ERAS.get(matched[1] ?? '');
  if (base === undefined) return label;
  const offset = matched[2] === '元' ? 1 : Number(matched[2]);
  if (!Number.isInteger(offset) || offset < 1) return label;
  return `${base + offset - 1}年${label.slice(matched[0].length)}`;
}

/** 開始月と粒度から結果を組み立てる（日付が作れなければ unknown）。 */
function periodAt(year: number, month: number, day: number, granularity: PeriodGranularity): ParsedPeriod {
  const start = utcDate(year, month, day);
  return start === null ? UNPARSED : { start, granularity };
}

/** 月の span（開始月 M・終了月 N、年をまたぐ場合は繰り上げ）から粒度を決める。3=四半期 / 6=半期 / 他=unknown。 */
function spanGranularity(fromMonth: number, toMonth: number): PeriodGranularity {
  const span = toMonth >= fromMonth ? toMonth - fromMonth + 1 : toMonth + 12 - fromMonth + 1;
  if (span === 3) return 'quarter';
  if (span === 6) return 'half';
  return 'unknown';
}

/** 和暦を西暦へ直した後の日本語表記を解釈する。当てはまらなければ undefined（呼び出し側が次の形を試す）。 */
function parseJapanese(label: string, fiscalYearStartMonth: number): ParsedPeriod | undefined {
  // YYYY年M月D日
  let matched = /^(\d{1,4})年(\d{1,2})月(\d{1,2})日$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), Number(matched[2]), Number(matched[3]), 'day');

  // YYYY年第N四半期 / YYYY年度第N四半期（年度は fiscalYearStartMonth 起点）
  matched = /^(\d{1,4})年(度)?第(\d{1,2})四半期$/.exec(label);
  if (matched !== null) {
    const quarter = Number(matched[3]);
    if (quarter < 1 || quarter > 4) return UNPARSED;
    const base = matched[2] === undefined ? 1 : fiscalYearStartMonth;
    const shifted = shiftMonth(Number(matched[1]), base, (quarter - 1) * 3);
    return periodAt(shifted.year, shifted.month, 1, 'quarter');
  }

  // YYYY年度上期/下期（暦年の上期/下期も同じ形で受ける）
  matched = /^(\d{1,4})年(度)?(上|下)期$/.exec(label);
  if (matched !== null) {
    const base = matched[2] === undefined ? 1 : fiscalYearStartMonth;
    const shifted = shiftMonth(Number(matched[1]), base, matched[3] === '上' ? 0 : 6);
    return periodAt(shifted.year, shifted.month, 1, 'half');
  }

  // YYYY年M-N月期 / YYYY年M月-N月（`〜` 等は正規化で `-` になっている）
  matched = /^(\d{1,4})年(\d{1,2})月?-(\d{1,2})月期?$/.exec(label);
  if (matched !== null) {
    const fromMonth = Number(matched[2]);
    const toMonth = Number(matched[3]);
    if (toMonth < 1 || toMonth > 12) return UNPARSED;
    // span が 3・6 以外でも開始日は分かるので入れる（粒度だけ unknown）。
    return periodAt(Number(matched[1]), fromMonth, 1, spanGranularity(fromMonth, toMonth));
  }

  // YYYY年M月
  matched = /^(\d{1,4})年(\d{1,2})月$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), Number(matched[2]), 1, 'month');

  // YYYY年度
  matched = /^(\d{1,4})年度$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), fiscalYearStartMonth, 1, 'fiscal-year');

  // YYYY年
  matched = /^(\d{1,4})年$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), 1, 1, 'year');

  return undefined;
}

/** 西洋式の表記（ISO・スラッシュ区切り・YYYYMM・四半期・FY）を解釈する。 */
function parseWestern(label: string, fiscalYearStartMonth: number): ParsedPeriod | undefined {
  // YYYY-MM-DD / YYYY/MM/DD
  let matched = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), Number(matched[2]), Number(matched[3]), 'day');

  // YYYY-Qn / YYYYQn（暦年の四半期）
  matched = /^(\d{4})-?[Qq](\d)$/.exec(label);
  if (matched !== null) {
    const quarter = Number(matched[2]);
    if (quarter < 1 || quarter > 4) return UNPARSED;
    return periodAt(Number(matched[1]), (quarter - 1) * 3 + 1, 1, 'quarter');
  }

  // YYYY-MM / YYYY/MM
  matched = /^(\d{4})[-/](\d{1,2})$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), Number(matched[2]), 1, 'month');

  // FYYYYY / FY YYYY（空白は正規化で落ちている）
  matched = /^[Ff][Yy](\d{4})$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), fiscalYearStartMonth, 1, 'fiscal-year');

  // YYYYMM（6 桁。月が 01..12 のときだけ）
  matched = /^(\d{4})(\d{2})$/.exec(label);
  if (matched !== null) {
    const month = Number(matched[2]);
    if (month < 1 || month > 12) return UNPARSED;
    return periodAt(Number(matched[1]), month, 1, 'month');
  }

  // YYYY
  matched = /^(\d{4})$/.exec(label);
  if (matched !== null) return periodAt(Number(matched[1]), 1, 1, 'year');

  return undefined;
}

/**
 * 期間ラベル 1 つを解釈する純粋関数。ノード本体のほか、Factory のデータプロファイラが
 * 「この列は期間列か」を見るためにこの名前・この引数で呼ぶ（名前と引数を変えないこと）。
 *
 * @param value セルの値（文字列 / 数値 / Date / null）。
 * @param fiscalYearStartMonth 年度の開始月（1..12。省略時は 4）。
 */
export function parsePeriodLabel(value: unknown, fiscalYearStartMonth = 4): ParsedPeriod {
  // すでに Date のセルはその日付をそのまま使う（CSV 推論で日付になった列など）。
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? UNPARSED : { start: value, granularity: 'day' };
  }
  if (value === null || value === undefined || typeof value === 'boolean') return UNPARSED;
  if (typeof value === 'number' && !Number.isFinite(value)) return UNPARSED;

  const month = Number.isInteger(fiscalYearStartMonth) && fiscalYearStartMonth >= 1 && fiscalYearStartMonth <= 12
    ? fiscalYearStartMonth
    : 4;
  const label = normalizeLabel(String(value));
  if (label === '') return UNPARSED;

  return parseJapanese(withWesternYear(label), month)
    ?? parseWestern(label, month)
    ?? UNPARSED;
}

function validate(config: unknown): ParsePeriodConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) {
    throw new ConfigError(`${PARSE_PERIOD_TYPE}: invalid config: ${zodMessage(parsed.error)}`);
  }
  return parsed.data;
}

/** 入力スキーマ・設定の問題（すべて error）。inferSchema の issue と execute の例外で同じ文言を使う。 */
function issuesOf(input: Schema, config: ParsePeriodConfig): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (findColumn(input, config.column) === undefined) {
    issues.push({ severity: 'error', message: `${PARSE_PERIOD_TYPE}: column not found: ${config.column}`, column: config.column });
  }
  if (findColumn(input, config.startColumn) !== undefined) {
    issues.push({ severity: 'error', message: `${PARSE_PERIOD_TYPE}: start column already exists: ${config.startColumn}`, column: config.startColumn });
  }
  if (findColumn(input, config.granularityColumn) !== undefined) {
    issues.push({ severity: 'error', message: `${PARSE_PERIOD_TYPE}: granularity column already exists: ${config.granularityColumn}`, column: config.granularityColumn });
  }
  if (config.startColumn === config.granularityColumn) {
    issues.push({ severity: 'error', message: `${PARSE_PERIOD_TYPE}: start column and granularity column must differ: ${config.startColumn}`, column: config.startColumn });
  }
  return issues;
}

function outputSchema(input: Schema, config: ParsePeriodConfig): Schema {
  const added: Column[] = [
    // 読めないラベルは null になるので nullable。粒度は必ず値が入る（unknown）ので nullable: false。
    { name: config.startColumn, type: 'date', nullable: true },
    { name: config.granularityColumn, type: 'string', nullable: false },
  ];
  return { columns: [...input.columns, ...added] };
}

class ParsePeriodNode implements EtlNode<ParsePeriodConfig> {
  readonly type = PARSE_PERIOD_TYPE;
  readonly kind: NodeKind = 'transform';
  readonly inputArity = 1 as const;

  validateConfig(config: unknown): ParsePeriodConfig {
    return validate(config);
  }

  inferSchema(inputs: readonly Schema[], config: ParsePeriodConfig): SchemaInference {
    const input = inputs[0] ?? { columns: [] };
    const issues = issuesOf(input, config);
    if (issues.length > 0) return { schema: input, state: 'mismatch', issues };
    return { schema: outputSchema(input, config), state: 'confirmed', issues: [] };
  }

  execute(inputs: readonly Table[], config: ParsePeriodConfig): Table {
    const input = inputs[0] ?? { schema: { columns: [] }, rows: [] };
    if (findColumn(input.schema, config.column) === undefined) {
      throw new SchemaError(`${PARSE_PERIOD_TYPE}: column not found: ${config.column}`);
    }
    if (findColumn(input.schema, config.startColumn) !== undefined) {
      throw new ConfigError(`${PARSE_PERIOD_TYPE}: start column already exists: ${config.startColumn}`);
    }
    if (findColumn(input.schema, config.granularityColumn) !== undefined) {
      throw new ConfigError(`${PARSE_PERIOD_TYPE}: granularity column already exists: ${config.granularityColumn}`);
    }
    if (config.startColumn === config.granularityColumn) {
      throw new ConfigError(`${PARSE_PERIOD_TYPE}: start column and granularity column must differ: ${config.startColumn}`);
    }

    const rows: Row[] = input.rows.map((row) => {
      const parsed = parsePeriodLabel(row[config.column] ?? null, config.fiscalYearStartMonth);
      const out: Record<string, Cell> = { ...row };
      out[config.startColumn] = parsed.start;
      out[config.granularityColumn] = parsed.granularity;
      return out;
    });

    return { schema: outputSchema(input.schema, config), rows };
  }
}

/** `parse-period` ノードのシングルトン。 */
export const parsePeriodNode: EtlNode<ParsePeriodConfig> = new ParsePeriodNode();
