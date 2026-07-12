// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import type { PreviewResultDto, PropagationResultDto, SerializedToolDto } from '../api/types';
import { ToolBuilder } from './ToolBuilder';
import { useToolBuilderStore } from './store';

vi.mock('./FlowCanvas', () => ({ FlowCanvas: () => <div aria-label="ETL canvas" /> }));
vi.mock('./NodePalette', () => ({ NodePalette: () => <aside aria-label="Node palette" /> }));

const valid: PropagationResultDto = {
  order: ['source-1', 'filter-1'], hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
    'filter-1': { nodeId: 'filter-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'age', type: 'number', nullable: false }] } },
  },
};
const sample: PreviewResultDto = {
  terminalId: 'filter-1', output: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] },
  nodes: { 'filter-1': { nodeId: 'filter-1', truncated: false, table: { schema: { columns: [{ name: 'age', type: 'number', nullable: false }] }, rows: [{ age: 30 }] } } },
};

beforeEach(() => { useToolBuilderStore.getState().reset(); vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('ToolBuilder preview integration', () => {
  it('Agent context領域でAgent Inputの引数スキーマを編集できる', () => {
    useToolBuilderStore.getState().addNode('agent-input');
    const client = { inferDraft: vi.fn(), previewDraft: vi.fn() } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);
    expect(screen.getByRole('table', { name: 'Agent arguments' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Argument name 1'), { target: { value: 'minimumAge' } });
    fireEvent.change(screen.getByLabelText('Argument type minimumAge'), { target: { value: 'number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add argument' }));
    const input = useToolBuilderStore.getState().nodes.find((node) => node.data.nodeType === 'agent-input');
    expect((input?.data.config['schema'] as { columns: { name: string; type: string }[] }).columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'minimumAge', type: 'number' }), expect.objectContaining({ name: 'argument2', type: 'string' })]));
  });

  it('debounce infer→previewでsampleを描画し、次のissueではpreviewを抑止する', async () => {
    const invalid: PropagationResultDto = {
      ...valid, hasErrors: true,
      nodes: { ...valid.nodes, 'filter-1': { ...valid.nodes['filter-1']!, state: 'mismatch', issues: [{ severity: 'error', message: 'age is missing', column: 'age' }] } },
    };
    const client = {
      inferDraft: vi.fn().mockResolvedValueOnce(valid).mockResolvedValueOnce(invalid),
      previewDraft: vi.fn().mockResolvedValue(sample),
    } as unknown as ToolApiClient;
    render(<ToolBuilder client={client} />);

    expect(screen.queryByLabelText('Agent chat')).toBeNull();
    expect(screen.getByLabelText('Agent-facing name')).toBeTruthy();
    expect(screen.getByLabelText('Agent-facing description')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Agent-facing name'), { target: { value: 'find_adults' } });
    fireEvent.change(screen.getByLabelText('Agent-facing description'), { target: { value: 'Find adult customers by minimum age.' } });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'find_adults', agentDescription: 'Find adult customers by minimum age.' });

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getByRole('cell', { name: '30' })).toBeTruthy();
    expect(client.previewDraft).toHaveBeenCalledOnce();

    act(() => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'missing', op: 'eq', value: 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(screen.getAllByText('age is missing').length).toBeGreaterThan(0);
    expect(client.previewDraft).toHaveBeenCalledOnce();
  });

  it('2ソース→joinのグラフをtoInput付きでdraft APIへ流し、join結果の行を描画する', async () => {
    const joinColumns = [
      { name: 'id', type: 'number', nullable: false },
      { name: 'name', type: 'string', nullable: false },
      { name: 'score', type: 'number', nullable: false },
    ] as const;
    const joinPropagation: PropagationResultDto = {
      order: ['left-1', 'right-1', 'join-1'], hasErrors: false,
      nodes: {
        'left-1': { nodeId: 'left-1', state: 'inferred', issues: [], schema: { columns: [joinColumns[0], joinColumns[1]] } },
        'right-1': { nodeId: 'right-1', state: 'inferred', issues: [], schema: { columns: [joinColumns[0], joinColumns[2]] } },
        'join-1': { nodeId: 'join-1', state: 'confirmed', issues: [], schema: { columns: [...joinColumns] } },
      },
    };
    const joinPreview: PreviewResultDto = {
      terminalId: 'join-1',
      output: { schema: { columns: [...joinColumns] }, rows: [{ id: 1, name: 'Alice', score: 90 }] },
      nodes: { 'join-1': { nodeId: 'join-1', truncated: false, table: { schema: { columns: [...joinColumns] }, rows: [{ id: 1, name: 'Alice', score: 90 }] } } },
    };
    const inferDraft = vi.fn().mockResolvedValue(joinPropagation);
    const previewDraft = vi.fn().mockResolvedValue(joinPreview);
    const client = { inferDraft, previewDraft } as unknown as ToolApiClient;

    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'joined', workingName: 'w', displayName: 'Joined', publishName: 'joined', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'left-1', type: 'json-source', config: { rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] } },
          { id: 'right-1', type: 'json-source', config: { rows: [{ id: 1, score: 90 }] } },
          { id: 'join-1', type: 'join', config: { mode: 'inner', keys: [{ left: 'id', right: 'id' }], rightSuffix: '_right' } },
        ],
        edges: [{ from: 'left-1', to: 'join-1', toInput: 0 }, { from: 'right-1', to: 'join-1', toInput: 1 }],
      },
    } as SerializedToolDto);
    useToolBuilderStore.getState().selectNode('join-1');
    render(<ToolBuilder client={client} />);

    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    // joinノードと2本のtoInput付きedgeがそのままinfer-schema/previewへ渡る。
    const sentGraph = inferDraft.mock.calls[0]?.[0] as { nodes: { type: string }[]; edges: unknown[] };
    expect(sentGraph.nodes.map((node) => node.type)).toEqual(['json-source', 'json-source', 'join']);
    expect(sentGraph.edges).toEqual([
      { from: 'left-1', to: 'join-1', toInput: 0 },
      { from: 'right-1', to: 'join-1', toInput: 1 },
    ]);
    expect(previewDraft).toHaveBeenCalledWith(sentGraph, 100, expect.any(AbortSignal), { tenantId: 't', workspaceId: 'w' });

    // join結果の期待行が描画される。
    expect(screen.getByRole('cell', { name: 'Alice' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: '90' })).toBeTruthy();
  });
});
