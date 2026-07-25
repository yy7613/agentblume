import { z } from 'zod';
import type { Row, Schema, Table } from '../../data/types';
import { findColumn } from '../../data/schema';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';
import { existingColumns, groupKey, groupValues, mean, numericColumns, requireColumns, requireNumbers, standardDeviation } from './analysis-utils';

export const SUMMARY_METRICS = ['valid-count', 'missing-count', 'unique-count', 'sum', 'mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max'] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];
export interface SummaryStatisticsConfig { readonly configVersion: 1; readonly columns: readonly string[]; readonly groupBy: readonly string[]; readonly metrics: readonly SummaryMetric[]; readonly variance: 'sample' | 'population'; }
const configSchema = z.object({ configVersion: z.literal(1).default(1), columns: z.array(z.string().min(1)).min(1), groupBy: z.array(z.string().min(1)).default([]), metrics: z.array(z.enum(SUMMARY_METRICS)).min(1).default(['valid-count', 'missing-count', 'mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max']), variance: z.enum(['sample', 'population']).default('sample') });
function validate(config: unknown): SummaryStatisticsConfig { const parsed = configSchema.safeParse(config); if (!parsed.success) throw new ConfigError(`summary-statistics: invalid config: ${zodMessage(parsed.error)}`); return parsed.data; }
function outputSchema(input: Schema, config: SummaryStatisticsConfig): Schema { return { columns: [...config.groupBy.map((name) => input.columns.find((column) => column.name === name)!), { name: 'column', type: 'string', nullable: false }, { name: 'rowCount', type: 'number', nullable: false }, ...config.metrics.map((name) => ({ name, type: 'number' as const, nullable: ['mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max'].includes(name) }))] }; }

/** 出力で生成する列名（`column` / `rowCount` / 選択 metric 名）。 */
function generatedNames(config: SummaryStatisticsConfig): Set<string> { return new Set<string>(['column', 'rowCount', ...config.metrics]); }
/** 生成列と同名のグループ列（出力で静かに上書きされ、schema に同名列が2つ現れる）。 */
function conflictingColumns(input: Schema, config: SummaryStatisticsConfig): string[] { const generated = generatedNames(config); return config.groupBy.filter((name) => generated.has(name) && findColumn(input, name) !== undefined); }
function conflictMessage(name: string): string { return `summary-statistics: input column '${name}' conflicts with generated column`; }

/** 分位点 metric と対応する q 値。 */
const QUANTILES: Readonly<Partial<Record<SummaryMetric, number>>> = { q1: .25, median: .5, q3: .75 };

/** 単一パスで最小・最大を求める（`Math.min(...values)` は約13万要素でスタックを溢れさせる）。 */
function extrema(values: readonly number[]): { readonly min: number; readonly max: number } | null {
  if (values.length === 0) return null;
  let min = values[0]!; let max = values[0]!;
  for (let index = 1; index < values.length; index += 1) { const value = values[index]!; if (value < min) min = value; if (value > max) max = value; }
  return { min, max };
}

/** ソート済み配列に対する線形補間分位点（analysis-utils.quantile と同値だが再ソートしない）。 */
function quantileOf(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lower = Math.floor(pos); const upper = Math.ceil(pos);
  const left = sorted[lower]; const right = sorted[upper];
  if (left === undefined || right === undefined) return null;
  return left + (right - left) * (pos - lower);
}

/**
 * 選択された metric だけを計算する（遅延評価）。
 * 未選択の metric は一切評価せず、min/max のスプレッド展開とソートも必要なときだけ行う。
 */
function metricValues(values: readonly number[], rowCount: number, config: SummaryStatisticsConfig): Row {
  let range: { readonly min: number; readonly max: number } | null | undefined;
  const rangeOf = (): { readonly min: number; readonly max: number } | null => { if (range === undefined) range = extrema(values); return range; };
  let sorted: readonly number[] | undefined;
  const sortedOf = (): readonly number[] => { if (sorted === undefined) sorted = [...values].sort((a, b) => a - b); return sorted; };
  const result: Record<string, number | null> = {};
  for (const metric of config.metrics) {
    const q = QUANTILES[metric];
    if (q !== undefined) { result[metric] = quantileOf(sortedOf(), q); continue; }
    switch (metric) {
      case 'valid-count': result[metric] = values.length; break;
      case 'missing-count': result[metric] = rowCount - values.length; break;
      case 'unique-count': result[metric] = new Set(values).size; break;
      case 'sum': result[metric] = values.reduce((sum, value) => sum + value, 0); break;
      case 'mean': result[metric] = mean(values); break;
      case 'stddev': result[metric] = standardDeviation(values, config.variance); break;
      case 'min': result[metric] = rangeOf()?.min ?? null; break;
      default: result[metric] = rangeOf()?.max ?? null; break;
    }
  }
  return result;
}

export const summaryStatisticsNode: EtlNode<SummaryStatisticsConfig> = {
  type: 'summary-statistics', kind: 'analyze', inputArity: 1, validateConfig: validate,
  inferSchema(inputs, config): SchemaInference { const input = inputs[0] ?? { columns: [] }; const issues: SchemaIssue[] = [...existingColumns(input, config.groupBy, 'summary-statistics'), ...numericColumns(input, config.columns, 'summary-statistics'), ...conflictingColumns(input, config).map((name) => ({ severity: 'error' as const, message: conflictMessage(name), column: name }))]; return issues.length > 0 ? { schema: input, state: 'mismatch', issues } : { schema: outputSchema(input, config), state: 'confirmed', issues: [] }; },
  execute(inputs, config): Table {
    const input = inputs[0]; if (input === undefined) throw new ConfigError('summary-statistics requires one input'); requireColumns(input.schema, config.groupBy, 'summary-statistics'); requireNumbers(input.schema, config.columns, 'summary-statistics');
    const conflict = conflictingColumns(input.schema, config)[0]; if (conflict !== undefined) throw new SchemaError(conflictMessage(conflict));
    const groups = new Map<string, { values: Row; rows: Row[] }>();
    for (const row of input.rows) { const key = groupKey(row, config.groupBy); const current = groups.get(key); if (current === undefined) groups.set(key, { values: groupValues(row, config.groupBy), rows: [row] }); else current.rows.push(row); }
    if (groups.size === 0 && config.groupBy.length === 0) groups.set('[]', { values: {}, rows: [] });
    const rows: Row[] = [];
    for (const group of groups.values()) for (const column of config.columns) {
      const values: number[] = [];
      for (const row of group.rows) { const value = row[column]; if (typeof value === 'number' && Number.isFinite(value)) values.push(value); }
      rows.push({ ...group.values, column, rowCount: group.rows.length, ...metricValues(values, group.rows.length, config) });
    }
    return { schema: outputSchema(input.schema, config), rows };
  },
};
