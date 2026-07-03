import { z } from 'zod';
import type { Cell, Column, Row, Schema, Table } from '../../data/types';
import { ConfigError, SchemaError } from '../errors';
import type { EtlNode, NodeKind, SchemaInference, SchemaIssue } from '../node';
import { zodMessage } from './zod-error';

export interface AgentInputConfig {
  readonly schema: Schema;
  readonly sample: Row;
}

const cellSchema: z.ZodType<Cell> = z.union([
  z.string(), z.number(), z.boolean(), z.instanceof(Date), z.null(),
]);

const columnSchema: z.ZodType<Column> = z.object({
  name: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'date', 'null', 'unknown']),
  nullable: z.boolean(),
});

const configSchema = z.object({
  schema: z.object({ columns: z.array(columnSchema) }),
  sample: z.record(z.string(), cellSchema),
});

function cellMatches(value: Cell, column: Column): boolean {
  if (value === null) return column.nullable || column.type === 'null' || column.type === 'unknown';
  if (column.type === 'unknown') return true;
  if (column.type === 'date') {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    return typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
  }
  return typeof value === column.type;
}

function inspectSample(schema: Schema, sample: Row): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const names = new Set<string>();
  for (const column of schema.columns) {
    if (names.has(column.name)) {
      issues.push({ severity: 'error', message: `agent-input: duplicate column: ${column.name}`, column: column.name });
      continue;
    }
    names.add(column.name);
    const present = Object.prototype.hasOwnProperty.call(sample, column.name);
    if (!present && !column.nullable) {
      issues.push({ severity: 'error', message: `agent-input: required sample value missing: ${column.name}`, column: column.name });
      continue;
    }
    if (present && !cellMatches(sample[column.name] ?? null, column)) {
      issues.push({ severity: 'error', message: `agent-input: sample type mismatch for '${column.name}' (expected ${column.type})`, column: column.name });
    }
  }
  for (const key of Object.keys(sample)) {
    if (!names.has(key)) issues.push({ severity: 'warning', message: `agent-input: undeclared sample field ignored: ${key}`, column: key });
  }
  return issues;
}

class AgentInputNode implements EtlNode<AgentInputConfig> {
  readonly type = 'agent-input';
  readonly kind: NodeKind = 'source';
  readonly inputArity = 0 as const;

  validateConfig(config: unknown): AgentInputConfig {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new ConfigError(`agent-input: invalid config: ${zodMessage(parsed.error)}`);
    return parsed.data;
  }

  inferSchema(_inputs: readonly Schema[], config: AgentInputConfig): SchemaInference {
    const issues = inspectSample(config.schema, config.sample);
    return {
      schema: config.schema,
      state: issues.some((issue) => issue.severity === 'error') ? 'mismatch' : 'confirmed',
      issues,
    };
  }

  execute(_inputs: readonly Table[], config: AgentInputConfig): Table {
    const errors = inspectSample(config.schema, config.sample).filter((issue) => issue.severity === 'error');
    if (errors.length > 0) throw new SchemaError(errors.map((issue) => issue.message).join('; '));
    const row: Record<string, Cell> = {};
    for (const column of config.schema.columns) {
      const value = config.sample[column.name] ?? null;
      row[column.name] = column.type === 'date' && typeof value === 'string' ? new Date(value) : value;
    }
    return { schema: config.schema, rows: [row] };
  }
}

export const agentInputNode: EtlNode<AgentInputConfig> = new AgentInputNode();
