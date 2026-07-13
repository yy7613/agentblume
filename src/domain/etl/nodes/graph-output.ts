import { z } from 'zod';
import { findColumn } from '../../data/schema';
import type { Schema, Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference } from '../node';

/** 表の各行を property graph の edge として正規化するための列対応。 */
export interface EdgeListGraphArtifactMapping {
  readonly mode?: 'edge-list';
  readonly sourceColumn: string;
  readonly targetColumn: string;
  readonly edgeLabelColumn?: string;
}
export interface CorrelationNetworkGraphArtifactMapping {
  readonly mode: 'correlation-network';
  readonly columnX: string;
  readonly columnY: string;
  readonly coefficient: string;
  readonly pairCount: string;
  readonly minimumAbsoluteCoefficient: number;
  readonly minimumPairCount: number;
}
export type GraphArtifactMapping = EdgeListGraphArtifactMapping | CorrelationNetworkGraphArtifactMapping;

/** セッションワークスペースに property graph を保存する専用終端ノードの設定。 */
export interface GraphOutputConfig {
  readonly name: string;
  readonly writeMode: 'create' | 'replace';
  readonly onConflict: 'fail' | 'new-revision';
  readonly previewRows: number;
  readonly graph: GraphArtifactMapping;
}

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  writeMode: z.enum(['create', 'replace']),
  onConflict: z.enum(['fail', 'new-revision']),
  previewRows: z.number().int().min(0).max(100),
  graph: z.union([
    z.object({ mode: z.literal('edge-list').optional(), sourceColumn: z.string().min(1), targetColumn: z.string().min(1), edgeLabelColumn: z.string().min(1).optional() }),
    z.object({ mode: z.literal('correlation-network'), columnX: z.string().min(1), columnY: z.string().min(1), coefficient: z.string().min(1), pairCount: z.string().min(1), minimumAbsoluteCoefficient: z.number().min(0).max(1).default(0), minimumPairCount: z.number().int().min(0).default(2) }),
  ]),
}).superRefine((value, ctx) => {
  if (value.graph.mode !== 'correlation-network' && value.graph.sourceColumn === value.graph.targetColumn) {
    ctx.addIssue({ code: 'custom', path: ['graph', 'targetColumn'], message: 'sourceColumn and targetColumn must be different' });
  }
});

function validate(config: unknown): GraphOutputConfig {
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`graph-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

function columnIssues(schema: Schema, names: readonly string[], node: string): import('../node').SchemaIssue[] {
  return names.flatMap((name) => findColumn(schema, name) === undefined ? [{ severity: 'error' as const, message: `${node}: column not found: ${name}`, column: name }] : []);
}

function infer(inputs: readonly Schema[], config: GraphOutputConfig): SchemaInference {
  const input = inputs[0];
  if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'graph-output requires one input' }] };
  const graph = config.graph;
  const issues = graph.mode === 'correlation-network'
    ? columnIssues(input, [graph.columnX, graph.columnY, graph.coefficient, graph.pairCount], 'graph-output')
    : columnIssues(input, [graph.sourceColumn, graph.targetColumn, ...(graph.edgeLabelColumn === undefined ? [] : [graph.edgeLabelColumn])], 'graph-output');
  if (graph.mode === 'correlation-network') {
    for (const name of [graph.coefficient, graph.pairCount]) {
      const column = findColumn(input, name);
      if (column !== undefined && column.type !== 'number') issues.push({ severity: 'error', message: `graph-output: column '${name}' must be number`, column: name });
    }
  }
  return issues.length === 0 ? { schema: input, state: 'confirmed', issues } : { schema: input, state: 'mismatch', issues };
}

export const graphOutputNode: EtlNode<GraphOutputConfig> = {
  type: 'graph-output',
  kind: 'sink',
  inputArity: 1,
  validateConfig: validate,
  inferSchema: infer,
  execute(inputs: readonly Table[]): Table {
    const input = inputs[0];
    if (input === undefined) throw new ConfigError('graph-output requires one input');
    return input;
  },
};
