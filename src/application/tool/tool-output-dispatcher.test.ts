import { describe, expect, it } from 'vitest';
import { InMemorySessionArtifactRepository } from '../../adapters/storage/in-memory-session-artifact-repository';
import { createAgentSession } from '../../domain/session/agent-session';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { ToolOutputDispatcher } from './tool-output-dispatcher';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const table = { schema: { columns: [{ name: 'id', type: 'number' as const, nullable: false }, { name: 'name', type: 'string' as const, nullable: false }] }, rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] };
const session = createAgentSession({ id: 'session', scope, rootAgent: { internalId: 'agent', version: '1.0.0' }, createdAt: '2026-07-11T00:00:00.000Z', lastAccessedAt: '2026-07-11T00:00:00.000Z', expiresAt: '2026-07-12T00:00:00.000Z' });
function tool(type: string, config: unknown) {
  return createTool({ metadata: { internalId: 'tool', workingName: 'tool', displayName: 'Tool', publishName: 'tool', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, sideEffect: type === 'workspace-output' ? 'session-write' : 'read-only', graph: { nodes: [{ id: 'sink', type, config }], edges: [] } });
}

describe('ToolOutputDispatcher', () => {
  it('returns a selected, bounded inline value for agent-output', async () => {
    const dispatcher = new ToolOutputDispatcher();
    const result = await dispatcher.dispatch({ tool: tool('agent-output', { shape: 'single-value', format: 'json', valueColumn: 'name', maxRows: 10, maxBytes: 1024, overflow: 'error' }), table, runId: 'run', toolCallId: 'call' });
    expect(result).toMatchObject({ delivery: 'agent', value: 'Alice' });
  });

  it('stores workspace output as an artifact descriptor without putting the payload in the Tool result', async () => {
    const artifacts = new InMemorySessionArtifactRepository();
    const dispatcher = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'artifact');
    const result = await dispatcher.dispatch({ tool: tool('workspace-output', { name: 'people', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 }), table, session, runId: 'run', toolCallId: 'call', agentId: 'agent' });
    expect(result.delivery).toBe('session-workspace');
    if (result.delivery !== 'session-workspace') return;
    expect(result.content).not.toContain('Bob');
    expect(result.artifact).toMatchObject({ id: 'artifact', name: 'people', counts: { rows: 2 } });
    expect(await artifacts.find(scope, 'session', 'artifact')).toMatchObject({ payload: { rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] } });
  });

  it('formats markdown, rejects direct overflow, and can spill an oversized inline result into the session', async () => {
    const dispatcher = new ToolOutputDispatcher();
    const large = { ...table, rows: [{ id: 1, name: 'x'.repeat(2_000) }] };
    const markdown = await dispatcher.dispatch({ tool: tool('agent-output', { shape: 'rows', format: 'markdown-table', maxRows: 2, maxBytes: 1024, overflow: 'error' }), table, runId: 'run', toolCallId: 'markdown' });
    expect(markdown).toMatchObject({ delivery: 'agent', content: expect.stringContaining('| id | name |') });
    await expect(dispatcher.dispatch({ tool: tool('agent-output', { shape: 'rows', format: 'json', maxRows: 2, maxBytes: 1024, overflow: 'error' }), table: large, runId: 'run', toolCallId: 'overflow' })).rejects.toThrow(/maxBytes/);
    const artifacts = new InMemorySessionArtifactRepository();
    const spilling = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'spill');
    const spilled = await spilling.dispatch({ tool: tool('agent-output', { shape: 'rows', format: 'json', maxRows: 2, maxBytes: 1024, overflow: 'store-and-reference' }), table: large, session, runId: 'run', toolCallId: 'overflow' });
    expect(spilled).toMatchObject({ delivery: 'session-workspace', artifact: { id: 'spill' } });
    await expect(spilling.dispatch({ tool: tool('workspace-output', { name: 'tool-output', artifactKind: 'table', writeMode: 'create', onConflict: 'fail', previewRows: 1 }), table, session, runId: 'next', toolCallId: 'conflict' })).rejects.toThrow(/already exists/);
  });

  it('formats summary and chart data, normalizes dates, and reuses an idempotent artifact', async () => {
    const dispatcher = new ToolOutputDispatcher();
    const dated = { schema: { columns: [{ name: 'when', type: 'date' as const, nullable: false }, { name: 'value', type: 'number' as const, nullable: false }] }, rows: [{ when: new Date('2026-07-11T00:00:00.000Z'), value: 3 }] };
    const summary = await dispatcher.dispatch({ tool: tool('agent-output', { shape: 'summary', format: 'json', maxRows: 10, maxBytes: 1024, overflow: 'error' }), table: dated, runId: 'summary', toolCallId: 'call' });
    expect(summary).toMatchObject({ delivery: 'agent', value: { rowCount: 1, preview: [{ when: '2026-07-11T00:00:00.000Z', value: 3 }] } });
    const chart = await dispatcher.dispatch({ tool: tool('agent-output', { shape: 'rows', format: 'chartjs', columns: ['value'], maxRows: 10, maxBytes: 1024, overflow: 'error' }), table: dated, runId: 'chart', toolCallId: 'call' });
    expect(chart).toMatchObject({ value: { labels: ['1'], datasets: [{ label: 'value', data: [3] }] } });

    const artifacts = new InMemorySessionArtifactRepository();
    let ids = 0;
    const storing = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => `artifact-${ids += 1}`);
    const input = { tool: tool('workspace-output', { name: 'date', artifactKind: 'json', writeMode: 'replace', onConflict: 'new-revision', previewRows: 0 }), table: dated, session, runId: 'same-run', toolCallId: 'same-call' };
    const first = await storing.dispatch(input);
    const second = await storing.dispatch(input);
    expect(first).toMatchObject({ delivery: 'session-workspace', artifact: { id: 'artifact-1', preview: { rows: [] } } });
    expect(second).toMatchObject({ delivery: 'session-workspace', artifact: { id: 'artifact-1' } });
    expect(await artifacts.usage(scope, session.id)).toEqual({ count: 1, bytes: expect.any(Number) });
  });

  it('normalizes mapped table rows into a bounded property graph Artifact', async () => {
    const artifacts = new InMemorySessionArtifactRepository();
    const dispatcher = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'graph-artifact');
    const graphTool = tool('graph-output', { name: 'relations', writeMode: 'create', onConflict: 'new-revision', previewRows: 1, graph: { sourceColumn: 'id', targetColumn: 'name' } });
    const result = await dispatcher.dispatch({ tool: graphTool, table, session, runId: 'graph-run', toolCallId: 'graph-call' });
    expect(result).toMatchObject({ delivery: 'session-workspace', artifact: { kind: 'graph', contentType: 'application/vnd.agentblume.property-graph+json', counts: { nodes: 4, edges: 2 }, preview: { nodes: [{ id: '1' }], edges: [{ source: '1', target: 'Alice' }] } } });
    expect(await artifacts.read(scope, session.id, 'graph-artifact', { section: 'edges', limit: 1 })).toMatchObject({ payload: { edges: [{ source: '1', target: 'Alice' }], page: { section: 'edges', nextOffset: 1 } } });
  });

  it('stores a typed bounded chart Artifact instead of returning chart rows to the agent', async () => {
    const artifacts = new InMemorySessionArtifactRepository();
    const dispatcher = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'chart-artifact');
    const chartTool = tool('chart-output', { configVersion: 1, name: 'people-chart', chartType: 'scatter', mapping: { xColumn: 'id', yColumn: 'id' }, maxPoints: 1, downsample: 'none', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 });
    const result = await dispatcher.dispatch({ tool: chartTool, table, session, runId: 'chart-run', toolCallId: 'chart-call' });
    expect(result).toMatchObject({ delivery: 'session-workspace', artifact: { kind: 'chart', name: 'people-chart', preview: { chartType: 'scatter', sourceRowCount: 2, sampled: true, rows: [{ id: 1 }] } } });
    expect(await artifacts.find(scope, session.id, 'chart-artifact')).toMatchObject({ payload: { specVersion: 1, chartType: 'scatter', rows: [{ id: 1 }] } });
  });

  it('uses LTTB sampling for numeric and time-series chart mappings while preserving endpoints', async () => {
    const artifacts = new InMemorySessionArtifactRepository();
    const dispatcher = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'lttb-chart');
    const trend = { schema: { columns: [{ name: 'at', type: 'date' as const, nullable: false }, { name: 'value', type: 'number' as const, nullable: false }] }, rows: Array.from({ length: 12 }, (_, index) => ({ at: new Date(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`), value: index === 6 ? 100 : index })) };
    const chartTool = tool('chart-output', { configVersion: 1, name: 'trend', chartType: 'time-series', mapping: { timeColumn: 'at', valueColumn: 'value' }, maxPoints: 4, downsample: 'lttb', writeMode: 'create', onConflict: 'new-revision', previewRows: 4 });
    await dispatcher.dispatch({ tool: chartTool, table: trend, session, runId: 'lttb-run', toolCallId: 'lttb-call' });
    const stored = await artifacts.find(scope, session.id, 'lttb-chart');
    expect(stored).toMatchObject({ payload: { sampled: true, sourceRowCount: 12 } });
    const rows = (stored?.payload as { rows: readonly { value: number }[] }).rows;
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ value: 0 });
    expect(rows.at(-1)).toMatchObject({ value: 11 });
    expect(rows.some((row) => row.value === 100)).toBe(true);
  });

  it('turns correlation pairs into an undirected property graph without diagonal or symmetric duplicates', async () => {
    const artifacts = new InMemorySessionArtifactRepository();
    const dispatcher = new ToolOutputDispatcher(artifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'correlation-graph');
    const correlations = { schema: { columns: [{ name: 'columnX', type: 'string' as const, nullable: false }, { name: 'columnY', type: 'string' as const, nullable: false }, { name: 'coefficient', type: 'number' as const, nullable: true }, { name: 'pairCount', type: 'number' as const, nullable: false }] }, rows: [{ columnX: 'sales', columnY: 'profit', coefficient: 0.8, pairCount: 20 }, { columnX: 'profit', columnY: 'sales', coefficient: 0.8, pairCount: 20 }, { columnX: 'sales', columnY: 'sales', coefficient: 1, pairCount: 20 }, { columnX: 'sales', columnY: 'cost', coefficient: 0.1, pairCount: 20 }] };
    const graphTool = tool('graph-output', { name: 'correlations', writeMode: 'create', onConflict: 'new-revision', previewRows: 3, graph: { mode: 'correlation-network', columnX: 'columnX', columnY: 'columnY', coefficient: 'coefficient', pairCount: 'pairCount', minimumAbsoluteCoefficient: 0.5, minimumPairCount: 10 } });
    const result = await dispatcher.dispatch({ tool: graphTool, table: correlations, session, runId: 'correlation-run', toolCallId: 'correlation-call' });
    expect(result).toMatchObject({ artifact: { kind: 'graph', counts: { nodes: 2, edges: 1 }, preview: { edges: [expect.objectContaining({ source: 'sales', target: 'profit', properties: expect.objectContaining({ absoluteCoefficient: 0.8 }) })] } } });
  });

  it('covers empty inline forms, graph labels, duplicate nodes, and workspace limits', async () => {
    const empty = { ...table, rows: [] };
    const dispatcher = new ToolOutputDispatcher();
    await expect(dispatcher.dispatch({ tool: tool('agent-output', { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 1024, overflow: 'error' }), table: empty, runId: 'empty', toolCallId: 'first' })).resolves.toMatchObject({ value: null });
    await expect(dispatcher.dispatch({ tool: tool('agent-output', { shape: 'rows', format: 'markdown-table', maxRows: 1, maxBytes: 1024, overflow: 'error' }), table: empty, runId: 'empty', toolCallId: 'markdown' })).resolves.toMatchObject({ content: '"(no rows)"' });
    await expect(dispatcher.dispatch({ tool: tool('workspace-output', { name: 'needs-session', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 }), table, runId: 'missing-session', toolCallId: 'write' })).rejects.toThrow(/active agent session/);
    const tinySession = { ...session, quota: { ...session.quota, maxArtifactBytes: 1 } };
    await expect(new ToolOutputDispatcher(new InMemorySessionArtifactRepository()).dispatch({ tool: tool('workspace-output', { name: 'too-large', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 1 }), table, session: tinySession, runId: 'quota', toolCallId: 'write' })).rejects.toThrow(/maxArtifactBytes/);

    const edges = { schema: { columns: [{ name: 'source', type: 'string' as const, nullable: true }, { name: 'target', type: 'string' as const, nullable: false }, { name: 'kind', type: 'string' as const, nullable: false }] }, rows: [{ source: 'alice', target: 'bob', kind: 'knows' }, { source: 'alice', target: 'bob', kind: 'knows' }] };
    const graphArtifacts = new InMemorySessionArtifactRepository();
    const graph = await new ToolOutputDispatcher(graphArtifacts, () => new Date('2026-07-11T01:00:00.000Z'), () => 'labeled-graph').dispatch({ tool: tool('graph-output', { name: 'labeled', writeMode: 'create', onConflict: 'new-revision', previewRows: 1, graph: { sourceColumn: 'source', targetColumn: 'target', edgeLabelColumn: 'kind' } }), table: edges, session, runId: 'labels', toolCallId: 'write' });
    expect(graph).toMatchObject({ artifact: { counts: { nodes: 2, edges: 2 }, preview: { edges: [{ label: 'knows' }] } } });
    await expect(new ToolOutputDispatcher(graphArtifacts).dispatch({ tool: tool('graph-output', { name: 'invalid', writeMode: 'create', onConflict: 'new-revision', previewRows: 1, graph: { sourceColumn: 'source', targetColumn: 'target' } }), table: { ...edges, rows: [{ source: null, target: 'bob', kind: 'knows' }] }, session, runId: 'invalid', toolCallId: 'write' })).rejects.toThrow(/empty value/);
  });
});
