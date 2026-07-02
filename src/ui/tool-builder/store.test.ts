import { beforeEach, describe, expect, it } from 'vitest';
import type { SerializedToolDto } from '../api/types';
import { currentGraph, flowToGraph, useToolBuilderStore } from './store';

beforeEach(() => useToolBuilderStore.getState().reset());

describe('tool builder store', () => {
  it('starter graphをwire DTOへ変換する', () => {
    const graph = currentGraph();
    expect(graph.nodes.map((node) => node.type)).toEqual(['json-source', 'filter']);
    expect(graph.edges).toEqual([{ from: 'source-1', to: 'filter-1' }]);
  });

  it('選択ノードの後ろへtransformを追加しconfigを不変更新する', () => {
    const before = useToolBuilderStore.getState().nodes;
    useToolBuilderStore.getState().addNode('select');
    const added = useToolBuilderStore.getState().nodes.at(-1);
    expect(added?.data.nodeType).toBe('select');
    expect(useToolBuilderStore.getState().edges.at(-1)).toMatchObject({ source: 'filter-1', target: added?.id });
    useToolBuilderStore.getState().updateNodeConfig(added?.id ?? '', { columns: ['name'] });
    expect(useToolBuilderStore.getState().nodes.at(-1)?.data.config).toEqual({ columns: ['name'] });
    expect(before).not.toBe(useToolBuilderStore.getState().nodes);
  });

  it('source追加は自動edgeを作らず、manual connectionを追加できる', () => {
    const edgeCount = useToolBuilderStore.getState().edges.length;
    useToolBuilderStore.getState().addNode('csv-source');
    const sourceId = useToolBuilderStore.getState().selectedNodeId;
    expect(useToolBuilderStore.getState().edges).toHaveLength(edgeCount);
    useToolBuilderStore.getState().onConnect({ source: sourceId ?? '', target: 'filter-1', sourceHandle: null, targetHandle: null });
    expect(useToolBuilderStore.getState().edges).toHaveLength(edgeCount + 1);
  });

  it('保存済みDTOをcanvas/metadataへ復元する', () => {
    useToolBuilderStore.getState().setVersions(['1.0.0', '1.0.1']);
    const tool = {
      metadata: { internalId: 'loaded', workingName: 'work', displayName: 'Loaded', publishName: 'loaded_tool', version: '1.0.1', owner: 'owner', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'write',
      graph: { nodes: [{ id: 'csv', type: 'csv-source', config: { text: 'a\n1' } }], edges: [] },
    } as SerializedToolDto;
    useToolBuilderStore.getState().loadTool(tool);
    const state = useToolBuilderStore.getState();
    expect(state.metadata).toMatchObject({ internalId: 'loaded', sideEffect: 'write' });
    expect(state.nodes[0]?.data.config).toEqual({ text: 'a\n1' });
    expect(state.currentVersion).toBe('1.0.1');
    expect(state.versions).toEqual(['1.0.0', '1.0.1']);
  });

  it('node/edge changeと非同期結果setterを適用する', () => {
    const state = useToolBuilderStore.getState();
    state.onNodesChange([{ type: 'select', id: 'source-1', selected: true }]);
    state.onEdgesChange([{ type: 'remove', id: 'source-1-filter-1' }]);
    state.setPreviewLoading(true);
    state.setError('broken');
    state.setSavedVersion('1.0.0', ['1.0.0']);
    expect(useToolBuilderStore.getState()).toMatchObject({ previewLoading: true, error: 'broken', currentVersion: '1.0.0' });
    expect(useToolBuilderStore.getState().edges).toEqual([]);
    expect(flowToGraph(useToolBuilderStore.getState().nodes, [])).toHaveProperty('edges', []);
  });
});
