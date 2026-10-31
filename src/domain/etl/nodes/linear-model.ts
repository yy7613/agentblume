import { z } from 'zod';
import type { Row, Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, SchemaIssue } from '../node';
import { existingColumns, groupKey, groupValues, mean, numberValue, numericColumns, requireColumns, requireNumbers } from './analysis-utils';
import { zodMessage } from './zod-error';

export interface LinearModelConfig {
  readonly x: string;
  readonly y: string;
  readonly groupBy: readonly string[];
  readonly intercept: 'include' | 'zero';
  readonly predictAt?: number | null;
  /** One-based row ordinal within the filtered group; fitting always uses all valid pairs. */
  readonly observationIndex?: number | null;
  readonly observationBinding?: { readonly source: 'agent-input'; readonly field: string };
  readonly predictionBinding?: { readonly source: 'agent-input'; readonly field: string };
}
const configSchema = z.object({ x: z.string().min(1), y: z.string().min(1), groupBy: z.array(z.string().min(1)).max(10).default([]), intercept: z.enum(['include', 'zero']).default('include'), predictAt: z.number().finite().nullable().optional(), observationIndex: z.number().int().positive().nullable().optional(), observationBinding: z.object({ source: z.literal('agent-input'), field: z.string().min(1) }).optional(), predictionBinding: z.object({ source: z.literal('agent-input'), field: z.string().min(1) }).optional() });
const NUMBERS = ['n', 'missingPairs', 'meanX', 'meanY', 'sampleVarianceX', 'sampleVarianceY', 'sampleCovariance', 'correlation', 'intercept', 'slope', 'sse', 'df', 'residualStddev', 'r2', 'centeredR2', 'uncenteredR2', 'predictionX', 'prediction', 'observationIndex', 'observationX', 'observationY', 'fitted', 'residual'] as const;
const OBSERVATION_NUMBERS = ['observationIndex', 'observationX', 'observationY', 'fitted', 'residual'] as const;
const hasObservation = (config: LinearModelConfig): boolean => config.observationIndex !== undefined || config.observationBinding !== undefined;
const numberNames = (config: LinearModelConfig) => hasObservation(config) ? NUMBERS : NUMBERS.filter(name => !(OBSERVATION_NUMBERS as readonly string[]).includes(name));
const labelNames = (config: LinearModelConfig) => hasObservation(config) ? LABELS : LABELS.filter(name => name !== 'observationStatus');
const LABELS = ['xColumn', 'yColumn', 'interceptMode', 'status', 'observationStatus'] as const;
function validate(config: unknown): LinearModelConfig {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`linear-model: invalid config: ${zodMessage(parsed.error)}`);
  if (new Set(parsed.data.groupBy).size !== parsed.data.groupBy.length) throw new ConfigError('linear-model: duplicate groupBy column');
  return parsed.data;
}
function schema(input: Schema, config: LinearModelConfig): Schema {
  return { columns: [...config.groupBy.map(name => input.columns.find(column => column.name === name)!),
    ...labelNames(config).map(name => ({ name, type: 'string' as const, nullable: false })),
    ...numberNames(config).map(name => ({ name, type: 'number' as const, nullable: name !== 'n' && name !== 'missingPairs' && name !== 'df' }))] };
}
function conflicts(config: LinearModelConfig): string[] { const generated = new Set<string>([...numberNames(config), ...labelNames(config)]); return config.groupBy.filter(name => generated.has(name)); }
function statistics(rows: readonly Row[], config: LinearModelConfig): Row {
  const pairs = rows.flatMap(row => {
    const x = numberValue(row, config.x), y = numberValue(row, config.y);
    return x === undefined || y === undefined ? [] : [{ x, y }];
  });
  const n = pairs.length, meanX = mean(pairs.map(pair => pair.x)), meanY = mean(pairs.map(pair => pair.y));
  let sxx = 0, syy = 0, sxy = 0, xx = 0, yy = 0, xy = 0;
  for (const { x, y } of pairs) {
    const dx = x - (meanX ?? 0), dy = y - (meanY ?? 0);
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    xx += x * x; yy += y * y; xy += x * y;
  }
  const include = config.intercept === 'include', denominator = include ? sxx : xx;
  const identifiable = n >= (include ? 2 : 1) && denominator > 0 && Number.isFinite(denominator);
  const slope = identifiable ? (include ? sxy : xy) / denominator : null;
  const intercept = slope === null ? null : include ? meanY! - slope * meanX! : 0;
  const sse = slope === null || intercept === null ? null : pairs.reduce((sum, { x, y }) => sum + (y - (intercept + slope * x)) ** 2, 0);
  const df = Math.max(0, n - (include ? 2 : 1));
  const centeredR2 = sse === null || syy === 0 ? null : 1 - sse / syy;
  const uncenteredR2 = sse === null || yy === 0 ? null : 1 - sse / yy;
  const observation = config.observationIndex == null ? undefined : rows[config.observationIndex - 1];
  const observationX = observation ? numberValue(observation, config.x) ?? null : null;
  const observationY = observation ? numberValue(observation, config.y) ?? null : null;
  const fitted = observationX === null || slope === null || intercept === null ? null : intercept + slope * observationX;
  const residual = fitted === null || observationY === null ? null : observationY - fitted;
  const observationStatus = config.observationIndex == null ? 'not_requested' : !observation ? 'not_found' : observationX === null || observationY === null ? 'missing' : fitted === null || residual === null || !Number.isFinite(fitted) || !Number.isFinite(residual) ? 'not_identifiable' : 'ok';
  const values: Record<string, number | null> = {
    observationIndex: config.observationIndex ?? null, observationX, observationY, fitted, residual,
    n, missingPairs: rows.length - n, meanX, meanY,
    sampleVarianceX: n > 1 ? sxx / (n - 1) : null,
    sampleVarianceY: n > 1 ? syy / (n - 1) : null,
    sampleCovariance: n > 1 ? sxy / (n - 1) : null,
    correlation: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx) / Math.sqrt(syy) : null,
    slope, intercept, sse, df, residualStddev: sse !== null && df > 0 ? Math.sqrt(sse / df) : null,
    centeredR2, uncenteredR2, r2: include ? centeredR2 : uncenteredR2,
    predictionX: config.predictAt ?? null,
    prediction: config.predictAt == null || slope === null || intercept === null ? null : intercept + slope * config.predictAt,
  };
  if (!hasObservation(config)) for (const key of OBSERVATION_NUMBERS) delete values[key];
  const finite = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value !== null && !Number.isFinite(value) ? null : value]));
  return { xColumn: config.x, yColumn: config.y, interceptMode: config.intercept,
    ...(hasObservation(config) ? { observationStatus } : {}), status: finite['slope'] === null || finite['intercept'] === null || finite['sse'] === null ? 'not_identifiable' : 'ok', ...finite };
}

/** Ordinary least squares for one numeric predictor, with pairwise missing-value exclusion and explicit R² conventions. */
export const linearModelNode: EtlNode<LinearModelConfig> = {
  type: 'linear-model', kind: 'analyze', inputArity: 1, validateConfig: validate,
  inferSchema(inputs, config) {
    const input = inputs[0] ?? { columns: [] };
    const issues: SchemaIssue[] = [...existingColumns(input, config.groupBy, 'linear-model'), ...numericColumns(input, [config.x, config.y], 'linear-model'),
      ...conflicts(config).map(column => ({ severity: 'error' as const, column, message: `linear-model: group column '${column}' conflicts with generated output` }))];
    return issues.length ? { schema: input, state: 'mismatch', issues } : { schema: schema(input, config), state: 'confirmed', issues: [] };
  },
  execute(inputs, config): Table {
    const input = inputs[0];
    if (input === undefined) throw new ConfigError('linear-model requires one input');
    requireColumns(input.schema, config.groupBy, 'linear-model'); requireNumbers(input.schema, [config.x, config.y], 'linear-model');
    if (conflicts(config).length) throw new SchemaError('linear-model: group column conflicts with generated output');
    const groups = new Map<string, { values: Row; rows: Row[] }>();
    for (const row of input.rows) {
      const key = groupKey(row, config.groupBy), group = groups.get(key);
      if (group === undefined) groups.set(key, { values: groupValues(row, config.groupBy), rows: [row] }); else group.rows.push(row);
    }
    if (!groups.size && !config.groupBy.length) groups.set('[]', { values: {}, rows: [] });
    return { schema: schema(input.schema, config), rows: [...groups.values()].map(group => ({ ...group.values, ...statistics(group.rows, config) })) };
  },
};
