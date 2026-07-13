import { z } from 'zod';
import type { Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference } from '../node';

/** 表の各行を property graph の edge として正規化するための列対応。 */
export interface GraphArtifactMapping {
  readonly sourceColumn: string;
  readonly targetColumn: string;
  readonly edgeLabelColumn?: string;
}

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
  graph: z.object({ sourceColumn: z.string().min(1), targetColumn: z.string().min(1), edgeLabelColumn: z.string().min(1).optional() }),
}).superRefine((value, ctx) => {
  if (value.graph.sourceColumn === value.graph.targetColumn) {
    ctx.addIssue({ code: 'custom', path: ['graph', 'targetColumn'], message: 'sourceColumn and targetColumn must be different' });
  }
});

function validate(config: unknown): GraphOutputConfig {
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`graph-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

function infer(inputs: readonly import('../../data/types').Schema[], _config: GraphOutputConfig): SchemaInference {
  const input = inputs[0];
  if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'graph-output requires one input' }] };
  return { schema: input, state: 'confirmed', issues: [] };
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
