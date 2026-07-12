import { z } from 'zod';
import type { Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference } from '../node';

export const WORKSPACE_ARTIFACT_KINDS = ['table', 'json', 'chart', 'graph', 'blob'] as const;
export type WorkspaceArtifactKind = (typeof WORKSPACE_ARTIFACT_KINDS)[number];

/** 表の各行をproperty graphのedgeとして正規化するための列対応。 */
export interface GraphArtifactMapping {
  readonly sourceColumn: string;
  readonly targetColumn: string;
  readonly edgeLabelColumn?: string;
}

export interface WorkspaceOutputConfig {
  readonly name: string;
  readonly artifactKind: WorkspaceArtifactKind;
  readonly writeMode: 'create' | 'replace';
  readonly onConflict: 'fail' | 'new-revision';
  readonly previewRows: number;
  readonly graph?: GraphArtifactMapping;
}

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  artifactKind: z.enum(WORKSPACE_ARTIFACT_KINDS),
  writeMode: z.enum(['create', 'replace']),
  onConflict: z.enum(['fail', 'new-revision']),
  previewRows: z.number().int().min(0).max(100),
  graph: z.object({ sourceColumn: z.string().min(1), targetColumn: z.string().min(1), edgeLabelColumn: z.string().min(1).optional() }).optional(),
}).superRefine((value, ctx) => {
  if (value.artifactKind === 'graph' && value.graph === undefined) {
    ctx.addIssue({ code: 'custom', path: ['graph'], message: 'graph mapping is required for graph artifacts' });
  }
  if (value.graph !== undefined && value.graph.sourceColumn === value.graph.targetColumn) {
    ctx.addIssue({ code: 'custom', path: ['graph', 'targetColumn'], message: 'sourceColumn and targetColumn must be different' });
  }
});

function validate(config: unknown): WorkspaceOutputConfig {
  const parsed = schema.safeParse(config);
  if (!parsed.success) throw new ConfigError(`workspace-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

function infer(inputs: readonly import('../../data/types').Schema[], _config: WorkspaceOutputConfig): SchemaInference {
  const input = inputs[0];
  if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'workspace-output requires one input' }] };
  return { schema: input, state: 'confirmed', issues: [] };
}

export const workspaceOutputNode: EtlNode<WorkspaceOutputConfig> = {
  type: 'workspace-output',
  kind: 'sink',
  inputArity: 1,
  validateConfig: validate,
  inferSchema: infer,
  execute(inputs: readonly Table[]): Table {
    const input = inputs[0];
    if (input === undefined) throw new ConfigError('workspace-output requires one input');
    return input;
  },
};
