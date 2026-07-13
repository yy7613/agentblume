import { z } from 'zod';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';
import { existingColumns, groupKey, groupValues, mean, numericColumns, quantile, requireColumns, requireNumbers, standardDeviation } from './analysis-utils';

export const SUMMARY_METRICS = ['valid-count', 'missing-count', 'unique-count', 'sum', 'mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max'] as const;
export type SummaryMetric = (typeof SUMMARY_METRICS)[number];
export interface SummaryStatisticsConfig { readonly configVersion: 1; readonly columns: readonly string[]; readonly groupBy: readonly string[]; readonly metrics: readonly SummaryMetric[]; readonly variance: 'sample' | 'population'; }
const configSchema = z.object({ configVersion: z.literal(1).default(1), columns: z.array(z.string().min(1)).min(1), groupBy: z.array(z.string().min(1)).default([]), metrics: z.array(z.enum(SUMMARY_METRICS)).min(1).default(['valid-count', 'missing-count', 'mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max']), variance: z.enum(['sample', 'population']).default('sample') });
function validate(config: unknown): SummaryStatisticsConfig { const parsed = configSchema.safeParse(config); if (!parsed.success) throw new ConfigError(`summary-statistics: invalid config: ${zodMessage(parsed.error)}`); return parsed.data; }
function outputSchema(input: Schema, config: SummaryStatisticsConfig): Schema { return { columns: [...config.groupBy.map((name) => input.columns.find((column) => column.name === name)!), { name: 'column', type: 'string', nullable: false }, { name: 'rowCount', type: 'number', nullable: false }, ...config.metrics.map((name) => ({ name, type: 'number' as const, nullable: ['mean', 'stddev', 'min', 'q1', 'median', 'q3', 'max'].includes(name) }))] }; }
export const summaryStatisticsNode: EtlNode<SummaryStatisticsConfig> = {
  type: 'summary-statistics', kind: 'analyze', inputArity: 1, validateConfig: validate,
  inferSchema(inputs, config): SchemaInference { const input = inputs[0] ?? { columns: [] }; const issues: SchemaIssue[] = [...existingColumns(input, config.groupBy, 'summary-statistics'), ...numericColumns(input, config.columns, 'summary-statistics')]; return issues.length > 0 ? { schema: input, state: 'mismatch', issues } : { schema: outputSchema(input, config), state: 'confirmed', issues: [] }; },
  execute(inputs, config): Table {
    const input = inputs[0]; if (input === undefined) throw new ConfigError('summary-statistics requires one input'); requireColumns(input.schema, config.groupBy, 'summary-statistics'); requireNumbers(input.schema, config.columns, 'summary-statistics');
    const groups = new Map<string, { values: Row; rows: Row[] }>();
    for (const row of input.rows) { const key = groupKey(row, config.groupBy); const current = groups.get(key); if (current === undefined) groups.set(key, { values: groupValues(row, config.groupBy), rows: [row] }); else current.rows.push(row); }
    if (groups.size === 0 && config.groupBy.length === 0) groups.set('[]', { values: {}, rows: [] });
    const rows: Row[] = [];
    for (const group of groups.values()) for (const column of config.columns) {
      const values = group.rows.map((row) => row[column]).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      const metric: Record<string, number | null> = { 'valid-count': values.length, 'missing-count': group.rows.length - values.length, 'unique-count': new Set(values).size, sum: values.reduce((sum, value) => sum + value, 0), mean: mean(values), stddev: standardDeviation(values, config.variance), min: values.length === 0 ? null : Math.min(...values), q1: quantile(values, .25), median: quantile(values, .5), q3: quantile(values, .75), max: values.length === 0 ? null : Math.max(...values) };
      rows.push({ ...group.values, column, rowCount: group.rows.length, ...Object.fromEntries(config.metrics.map((name) => [name, metric[name]])) });
    }
    return { schema: outputSchema(input.schema, config), rows };
  },
};
