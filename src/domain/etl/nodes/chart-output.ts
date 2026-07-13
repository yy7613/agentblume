import { z } from 'zod';
import { findColumn } from '../../data/schema';
import type { DataType, Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference, SchemaIssue } from '../node';

export const CHART_TYPES = ['histogram', 'box-plot', 'scatter', 'correlation-heatmap', 'time-series', 'outlier-overlay'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export interface ChartOutputConfig { readonly configVersion: 1; readonly name: string; readonly chartType: ChartType; readonly mapping: Readonly<Record<string, string | number>>; readonly title?: string; readonly maxPoints: number; readonly downsample: 'none' | 'lttb'; readonly writeMode: 'create' | 'replace'; readonly onConflict: 'fail' | 'new-revision'; readonly previewRows: number; }
const configSchema = z.object({ configVersion: z.literal(1).default(1), name: z.string().trim().min(1).max(120), chartType: z.enum(CHART_TYPES), mapping: z.record(z.string(), z.union([z.string().min(1), z.number().int().positive()])).default({}), title: z.string().trim().min(1).max(200).optional(), maxPoints: z.number().int().min(1).max(5000).default(1000), downsample: z.enum(['none', 'lttb']).default('none'), writeMode: z.enum(['create', 'replace']).default('create'), onConflict: z.enum(['fail', 'new-revision']).default('new-revision'), previewRows: z.number().int().min(0).max(100).default(10) });
function validate(config: unknown): ChartOutputConfig { const parsed = configSchema.safeParse(config); if (!parsed.success) throw new ConfigError(`chart-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`); return parsed.data; }

function mappingIssue(schema: Schema, mapping: ChartOutputConfig['mapping'], key: string, types?: readonly DataType[]): SchemaIssue[] {
  const value = mapping[key];
  if (typeof value !== 'string') return [{ severity: 'error', message: `chart-output: mapping '${key}' is required`, column: key }];
  const column = findColumn(schema, value);
  if (column === undefined) return [{ severity: 'error', message: `chart-output: column not found: ${value}`, column: value }];
  if (types !== undefined && !types.includes(column.type)) return [{ severity: 'error', message: `chart-output: column '${value}' must be ${types.join(' or ')}`, column: value }];
  return [];
}

function mappingIssues(schema: Schema, config: ChartOutputConfig): SchemaIssue[] {
  switch (config.chartType) {
    case 'histogram': return mappingIssue(schema, config.mapping, 'valueColumn', ['number']);
    case 'box-plot': return mappingIssue(schema, config.mapping, 'valueColumn', ['number']);
    case 'scatter': return [...mappingIssue(schema, config.mapping, 'xColumn', ['number', 'date']), ...mappingIssue(schema, config.mapping, 'yColumn', ['number'])];
    case 'correlation-heatmap': return [...mappingIssue(schema, config.mapping, 'xColumn'), ...mappingIssue(schema, config.mapping, 'yColumn'), ...mappingIssue(schema, config.mapping, 'coefficientColumn', ['number'])];
    case 'time-series': return [...mappingIssue(schema, config.mapping, 'timeColumn', ['date']), ...mappingIssue(schema, config.mapping, 'valueColumn', ['number'])];
    case 'outlier-overlay': return [...mappingIssue(schema, config.mapping, 'xColumn', ['number', 'date']), ...mappingIssue(schema, config.mapping, 'valueColumn', ['number']), ...mappingIssue(schema, config.mapping, 'outlierColumn', ['boolean'])];
  }
}

export const chartOutputNode: EtlNode<ChartOutputConfig> = { type: 'chart-output', kind: 'sink', inputArity: 1, validateConfig: validate, inferSchema(inputs, config): SchemaInference { const input = inputs[0]; if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'chart-output requires one input' }] }; const issues = mappingIssues(input, config); return issues.length === 0 ? { schema: input, state: 'confirmed', issues } : { schema: input, state: 'mismatch', issues }; }, execute(inputs): Table { const input = inputs[0]; if (input === undefined) throw new ConfigError('chart-output requires one input'); return input; } };
