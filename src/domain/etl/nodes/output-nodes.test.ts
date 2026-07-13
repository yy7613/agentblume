import { describe, expect, it } from 'vitest';
import { ConfigError } from '../errors';
import { agentOutputNode } from './agent-output';
import { chartOutputNode } from './chart-output';
import { graphOutputNode } from './graph-output';
import { workspaceOutputNode } from './workspace-output';

const table = { schema: { columns: [{ name: 'id', type: 'number' as const, nullable: false }] }, rows: [{ id: 1 }] };

describe('output sink nodes', () => {
  it('agent-output validates a bounded direct result configuration and passes input through', () => {
    const config = agentOutputNode.validateConfig({ shape: 'single-value', format: 'json', valueColumn: 'id', maxRows: 10, maxBytes: 1024, overflow: 'error' });
    expect(agentOutputNode.execute([table], config)).toEqual(table);
    expect(agentOutputNode.inferSchema([table.schema], config).schema).toEqual(table.schema);
  });

  it('agent-output rejects single-value without a value column', () => {
    expect(() => agentOutputNode.validateConfig({ shape: 'single-value', format: 'json', maxRows: 10, maxBytes: 1024, overflow: 'error' })).toThrow(ConfigError);
  });

  it('reports a missing input and rejects unsupported output settings', () => {
    const config = agentOutputNode.validateConfig({ shape: 'rows', format: 'chartjs', maxRows: 1, maxBytes: 1024, overflow: 'store-and-reference' });
    expect(agentOutputNode.inferSchema([], config)).toMatchObject({ state: 'unknown', issues: [{ severity: 'error' }] });
    expect(() => agentOutputNode.execute([], config)).toThrow(ConfigError);
    expect(() => agentOutputNode.validateConfig({ shape: 'rows', format: 'xml', maxRows: 1, maxBytes: 1024, overflow: 'error' })).toThrow(ConfigError);
  });

  it('workspace-output validates its session artifact policy and passes input through', () => {
    const config = workspaceOutputNode.validateConfig({ name: 'sales', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 5 });
    expect(workspaceOutputNode.execute([table], config)).toEqual(table);
    expect(workspaceOutputNode.inferSchema([table.schema], config)).toMatchObject({ state: 'confirmed', schema: table.schema });
    expect(workspaceOutputNode.inferSchema([], config)).toMatchObject({ state: 'unknown', issues: [{ severity: 'error' }] });
    expect(() => workspaceOutputNode.execute([], config)).toThrow(ConfigError);
    expect(() => workspaceOutputNode.validateConfig({ name: '', artifactKind: 'table', writeMode: 'append', onConflict: 'fail', previewRows: 101 })).toThrow(ConfigError);
  });

  it('graph-output requires distinct source and target column mappings', () => {
    const config = graphOutputNode.validateConfig({ name: 'network', writeMode: 'create', onConflict: 'new-revision', previewRows: 5, graph: { sourceColumn: 'from', targetColumn: 'to', edgeLabelColumn: 'kind' } });
    expect(config.graph).toMatchObject({ sourceColumn: 'from', targetColumn: 'to' });
    expect(graphOutputNode.execute([table], config)).toEqual(table);
    expect(() => graphOutputNode.validateConfig({ name: 'network', writeMode: 'create', onConflict: 'new-revision', previewRows: 5 })).toThrow(ConfigError);
    expect(() => graphOutputNode.validateConfig({ name: 'network', writeMode: 'create', onConflict: 'new-revision', previewRows: 5, graph: { sourceColumn: 'id', targetColumn: 'id' } })).toThrow(ConfigError);
    expect(workspaceOutputNode.validateConfig({ name: 'legacy-network', artifactKind: 'graph', writeMode: 'create', onConflict: 'new-revision', previewRows: 5, graph: { sourceColumn: 'from', targetColumn: 'to' } })).toMatchObject({ artifactKind: 'graph' });
    expect(() => workspaceOutputNode.validateConfig({ name: 'network', artifactKind: 'graph', writeMode: 'create', onConflict: 'new-revision', previewRows: 5 })).toThrow(ConfigError);
  });

  it('validates graph and chart mappings against the upstream schema before execution', () => {
    const graph = graphOutputNode.validateConfig({ name: 'network', writeMode: 'create', onConflict: 'new-revision', previewRows: 5, graph: { mode: 'correlation-network', columnX: 'left', columnY: 'right', coefficient: 'score', pairCount: 'pairs', minimumAbsoluteCoefficient: 0.2, minimumPairCount: 3 } });
    expect(graphOutputNode.inferSchema([table.schema], graph)).toMatchObject({ state: 'mismatch', issues: expect.arrayContaining([expect.objectContaining({ column: 'left' })]) });
    const chart = chartOutputNode.validateConfig({ configVersion: 1, name: 'scores', chartType: 'scatter', mapping: { xColumn: 'id', yColumn: 'missing' }, maxPoints: 50, downsample: 'lttb', writeMode: 'create', onConflict: 'new-revision', previewRows: 5 });
    expect(chartOutputNode.inferSchema([table.schema], chart)).toMatchObject({ state: 'mismatch', issues: expect.arrayContaining([expect.objectContaining({ column: 'missing' })]) });
    expect(chartOutputNode.inferSchema([table.schema], chartOutputNode.validateConfig({ ...chart, chartType: 'histogram', mapping: { valueColumn: 'id' } }))).toMatchObject({ state: 'confirmed' });
  });
});
