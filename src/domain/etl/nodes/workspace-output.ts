import { z } from 'zod';
import type { Table } from '../../data/types';
import { ConfigError } from '../errors';
import type { EtlNode, SchemaInference } from '../node';

export const WORKSPACE_ARTIFACT_KINDS = ['table', 'json', 'chart', 'blob'] as const;
export type WorkspaceArtifactKind = (typeof WORKSPACE_ARTIFACT_KINDS)[number];

interface WorkspaceOutputBaseConfig {
  readonly name: string;
  readonly writeMode: 'create' | 'replace';
  readonly onConflict: 'fail' | 'new-revision';
  readonly previewRows: number;
}

export interface WorkspaceOutputConfig extends WorkspaceOutputBaseConfig {
  readonly artifactKind: WorkspaceArtifactKind;
}

/** 既存定義を実行可能に保つためだけに受理する旧形式。新規UIではgraph-outputを使う。 */
export interface LegacyGraphWorkspaceOutputConfig extends WorkspaceOutputBaseConfig {
  readonly artifactKind: 'graph';
  readonly graph: { readonly sourceColumn: string; readonly targetColumn: string; readonly edgeLabelColumn?: string };
}

export type CompatibleWorkspaceOutputConfig = WorkspaceOutputConfig | LegacyGraphWorkspaceOutputConfig;

const schema = z.object({
  name: z.string().trim().min(1).max(120),
  artifactKind: z.enum(WORKSPACE_ARTIFACT_KINDS),
  writeMode: z.enum(['create', 'replace']),
  onConflict: z.enum(['fail', 'new-revision']),
  previewRows: z.number().int().min(0).max(100),
});
const legacyGraphSchema = z.object({
  name: z.string().trim().min(1).max(120),
  artifactKind: z.literal('graph'),
  writeMode: z.enum(['create', 'replace']),
  onConflict: z.enum(['fail', 'new-revision']),
  previewRows: z.number().int().min(0).max(100),
  graph: z.object({ sourceColumn: z.string().min(1), targetColumn: z.string().min(1), edgeLabelColumn: z.string().min(1).optional() }),
}).superRefine((value, ctx) => {
  if (value.graph.sourceColumn === value.graph.targetColumn) {
    ctx.addIssue({ code: 'custom', path: ['graph', 'targetColumn'], message: 'sourceColumn and targetColumn must be different' });
  }
});

function validate(config: unknown): CompatibleWorkspaceOutputConfig {
  const parsed = z.union([schema, legacyGraphSchema]).safeParse(config);
  if (!parsed.success) throw new ConfigError(`workspace-output: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  return parsed.data;
}

function infer(inputs: readonly import('../../data/types').Schema[], _config: CompatibleWorkspaceOutputConfig): SchemaInference {
  const input = inputs[0];
  if (input === undefined) return { schema: { columns: [] }, state: 'unknown', issues: [{ severity: 'error', message: 'workspace-output requires one input' }] };
  return { schema: input, state: 'confirmed', issues: [] };
}

export const workspaceOutputNode: EtlNode<CompatibleWorkspaceOutputConfig> = {
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
