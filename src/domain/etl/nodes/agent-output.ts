import { z } from 'zod';
import type { Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference } from '../node';

export const AGENT_OUTPUT_SHAPES = ['rows', 'first-row', 'single-value', 'summary'] as const;
export type AgentOutputShape = (typeof AGENT_OUTPUT_SHAPES)[number];
export const AGENT_OUTPUT_FORMATS = ['json', 'markdown-table', 'chartjs'] as const;
export type AgentOutputFormat = (typeof AGENT_OUTPUT_FORMATS)[number];

export interface AgentOutputConfig {
  readonly shape: AgentOutputShape;
  readonly format: AgentOutputFormat;
  readonly columns?: readonly string[];
  readonly valueColumn?: string;
  readonly maxRows: number;
  readonly maxBytes: number;
  readonly overflow: 'error' | 'store-and-reference';
}

const schema = z.object({
  shape: z.enum(AGENT_OUTPUT_SHAPES),
  format: z.enum(AGENT_OUTPUT_FORMATS),
  columns: z.array(z.string().min(1)).optional(),
  valueColumn: z.string().min(1).optional(),
  maxRows: z.number().int().min(1).max(10_000),
  maxBytes: z.number().int().min(1_024).max(1_048_576),
  overflow: z.enum(['error', 'store-and-reference']),
}).superRefine((value, ctx) => {
  if (value.shape === 'single-value' && value.valueColumn === undefined) {
    ctx.addIssue({ code: 'custom', path: ['valueColumn'], message: 'valueColumn is required for single-value output' });
  }
});

function validate(config: unknown): AgentOutputConfig {
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`agent-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

function infer(inputs: readonly import('../../data/types').Schema[], _config: AgentOutputConfig): SchemaInference {
  const input = inputs[0];
  if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'agent-output requires one input' }] };
  return { schema: input, state: 'confirmed', issues: [] };
}

export const agentOutputNode: EtlNode<AgentOutputConfig> = {
  type: 'agent-output',
  kind: 'sink',
  inputArity: 1,
  validateConfig: validate,
  inferSchema: infer,
  execute(inputs: readonly Table[]): Table {
    const input = inputs[0];
    if (input === undefined) throw new ConfigError('agent-output requires one input');
    return input;
  },
};
