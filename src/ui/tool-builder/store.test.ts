import { beforeEach, describe, expect, it } from 'vitest';
import type { SerializedToolDto } from '../api/types';
import { currentGraph, flowToGraph, missingRequiredMetadata, toolBuilderDraft, useToolBuilderStore } from './store';

beforeEach(() => useToolBuilderStore.getState().reset());

describe('tool builder store', () => {
  it('starter graphをwire DTOへ変換する', () => {
    const graph = currentGraph();
    expect(graph.nodes.map((node) => node.type)).toEqual(['json-source', 'filter']);
    expect(graph.edges).toEqual([{ from: 'source-1', to: 'filter-1' }]);
  });

  it('starterの固定IDと衝突しない番号まで進めてノードIDを採番する', () => {
    // starterは source-1 / filter-1 なので、filter追加は filter-1 を飛ばして filter-2 になる。
    useToolBuilderStore.getState().addNode('filter');
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-2');
    useToolBuilderStore.getState().addNode('filter');
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-3');

    const ids = useToolBuilderStore.getState().nodes.map((node) => node.id);
    expect(ids).toEqual(['source-1', 'filter-1', 'filter-2', 'filter-3']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('読み込んだToolのIDと衝突しない空き番号から採番を続ける', () => {
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'loaded', workingName: 'w', displayName: 'L', publishName: 'l', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [{ id: 'select-1', type: 'select', config: { columns: [] } }, { id: 'select-3', type: 'select', config: { columns: [] } }],
        edges: [],
      },
    } as SerializedToolDto);

    useToolBuilderStore.getState().addNode('select');
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('select-2');
    useToolBuilderStore.getState().addNode('select');
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('select-4');
  });

  it('手動整列したノード座標をDTOへ書き出し、保存済みDTOから復元する', () => {
    useToolBuilderStore.getState().onNodesChange([{ type: 'position', id: 'filter-1', position: { x: 500.4, y: 320.6 } }]);
    const graph = currentGraph();
    // 小数のドラッグ座標は丸めて保存する（保存payloadを座標のゆらぎで変えない）。
    expect(graph.nodes.map((node) => node.position)).toEqual([{ x: 80, y: 120 }, { x: 500, y: 321 }]);

    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'laid-out', workingName: 'w', displayName: 'L', publishName: 'l', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph,
    } as SerializedToolDto);
    expect(useToolBuilderStore.getState().nodes.map((node) => node.position)).toEqual([{ x: 80, y: 120 }, { x: 500, y: 321 }]);
  });

  it('position無しの保存済みDTOは従来の自動グリッドへ配置する（後方互換）', () => {
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'legacy', workingName: 'w', displayName: 'L', publishName: 'l', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'a', type: 'json-source', config: { rows: [] } },
          { id: 'b', type: 'filter', config: { column: 'age', op: 'gte', value: 1 } },
          { id: 'c', type: 'select', config: { columns: [] } },
        ],
        edges: [],
      },
    } as SerializedToolDto);
    expect(useToolBuilderStore.getState().nodes.map((node) => node.position)).toEqual([
      { x: 80, y: 120 }, { x: 360, y: 120 }, { x: 640, y: 120 },
    ]);
  });

  it('positionが一部だけのDTOでは保存済み座標を優先し、残りを重ならない位置へ退避する', () => {
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'mixed', workingName: 'w', displayName: 'M', publishName: 'm', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'a', type: 'json-source', config: { rows: [] } },
          { id: 'b', type: 'filter', config: { column: 'age', op: 'gte', value: 1 }, position: { x: 80, y: 120 } },
        ],
        edges: [],
      },
    } as SerializedToolDto);
    // 自動グリッドの既定位置(80,120)はbが占有済みなので、aは下方向へずれる。
    expect(useToolBuilderStore.getState().nodes.map((node) => node.position)).toEqual([{ x: 80, y: 260 }, { x: 80, y: 120 }]);
  });

  it('未選択のパレット追加は既存ノードと重ならない位置へ置く', () => {
    useToolBuilderStore.getState().selectNode(undefined);
    useToolBuilderStore.getState().addNode('csv-source');
    // 先頭列の起点(80,120)はsource-1が占有済みなので、下方向の空きへ置く。
    expect(useToolBuilderStore.getState().nodes.at(-1)?.position).toEqual({ x: 80, y: 260 });
  });

  it('選択ノードの右隣が占有済みなら下方向へずらして配置する', () => {
    useToolBuilderStore.getState().addNode('select'); // filter-1(390,120)の右隣 → (670,120)
    expect(useToolBuilderStore.getState().nodes.at(-1)?.position).toEqual({ x: 670, y: 120 });

    useToolBuilderStore.getState().selectNode('filter-1');
    useToolBuilderStore.getState().addNode('sort');
    expect(useToolBuilderStore.getState().nodes.at(-1)?.position).toEqual({ x: 670, y: 260 });
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

  it('graph-output追加時に上流スキーマの先頭2列を初期マッピングに使う', () => {
    useToolBuilderStore.getState().setPropagation({
      order: ['source-1', 'filter-1'], hasErrors: false,
      nodes: {
        'source-1': { nodeId: 'source-1', state: 'inferred', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
        'filter-1': { nodeId: 'filter-1', state: 'confirmed', issues: [], schema: { columns: [{ name: 'id', type: 'number', nullable: false }, { name: 'name', type: 'string', nullable: false }] } },
      },
    });

    useToolBuilderStore.getState().addNode('graph-output');

    const state = useToolBuilderStore.getState();
    const selected = state.nodes.find((node) => node.id === state.selectedNodeId);
    expect(selected?.data.config).toMatchObject({ graph: { sourceColumn: 'id', targetColumn: 'name' } });
    expect(state.metadata.sideEffect).toBe('session-write');
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
    state.setDraftIssue('broken');
    state.setSavedVersion('1.0.0', ['1.0.0']);
    expect(useToolBuilderStore.getState()).toMatchObject({ previewLoading: true, draftIssue: 'broken', currentVersion: '1.0.0' });
    expect(useToolBuilderStore.getState().edges).toEqual([]);
    expect(flowToGraph(useToolBuilderStore.getState().nodes, [])).toHaveProperty('edges', []);
  });

  it('保存失敗と自動検証の失敗を別stateで保持する', () => {
    useToolBuilderStore.getState().setSaveError('SaveTool: invalid metadata');
    useToolBuilderStore.getState().setDraftIssue('draft check failed');
    expect(useToolBuilderStore.getState()).toMatchObject({ saveError: 'SaveTool: invalid metadata', draftIssue: 'draft check failed' });
    // 自動検証がdraftIssueを消しても保存失敗メッセージは残る（読む前に消えない）。
    useToolBuilderStore.getState().setDraftIssue(undefined);
    expect(useToolBuilderStore.getState()).toMatchObject({ saveError: 'SaveTool: invalid metadata', draftIssue: undefined });
  });

  it('保存内容が変わると保存失敗メッセージを消し、選択だけの変更では残す', () => {
    const setSaveError = () => useToolBuilderStore.getState().setSaveError('failed');

    setSaveError();
    useToolBuilderStore.getState().onNodesChange([{ type: 'select', id: 'source-1', selected: true }]);
    expect(useToolBuilderStore.getState().saveError).toBe('failed');
    useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: 'source-1' }]);
    expect(useToolBuilderStore.getState().saveError).toBeUndefined();

    for (const change of [
      () => useToolBuilderStore.getState().setMetadata('owner', 'owner@example.com'),
      () => useToolBuilderStore.getState().addNode('select'),
      () => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 20 }),
      () => useToolBuilderStore.getState().onConnect({ source: 'filter-1', target: 'filter-1', sourceHandle: null, targetHandle: null }),
      () => useToolBuilderStore.getState().onEdgesChange([{ type: 'remove', id: 'source-1-filter-1' }]),
    ]) {
      setSaveError();
      change();
      expect(useToolBuilderStore.getState().saveError).toBeUndefined();
    }
  });

  it('保存済みDTOの読み込みで保存失敗と草案の問題を両方消す', () => {
    useToolBuilderStore.getState().setSaveError('failed');
    useToolBuilderStore.getState().setDraftIssue('draft issue');
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'loaded', workingName: 'w', displayName: 'Loaded', publishName: 'loaded', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] },
    } as SerializedToolDto);
    expect(useToolBuilderStore.getState()).toMatchObject({ saveError: undefined, draftIssue: undefined });
  });

  it('未入力の必須メタデータだけを保存前チェックとして返す', () => {
    expect(missingRequiredMetadata(useToolBuilderStore.getState().metadata)).toEqual(['internalId', 'workingName', 'displayName', 'publishName', 'owner']);
    for (const [key, value] of [['internalId', 'tool'], ['workingName', 'draft'], ['displayName', 'Tool'], ['publishName', 'tool_v1'], ['owner', ' ']] as const) {
      useToolBuilderStore.getState().setMetadata(key, value);
    }
    // 空白だけの入力は未入力として扱う。
    expect(missingRequiredMetadata(useToolBuilderStore.getState().metadata)).toEqual(['owner']);
    useToolBuilderStore.getState().setMetadata('owner', 'owner@example.com');
    expect(missingRequiredMetadata(useToolBuilderStore.getState().metadata)).toEqual([]);
  });

  it('Tool identity変更時は保存versionを引き継がない', () => {
    useToolBuilderStore.getState().setSavedVersion('1.0.0', ['1.0.0']);
    useToolBuilderStore.getState().setMetadata('internalId', 'another-tool');
    expect(useToolBuilderStore.getState()).toMatchObject({ currentVersion: undefined, versions: [] });
  });

  it('join追加は左(toInput:0)へ自動接続し、右(in-1)への手動接続をtoInput:1でDTO化する', () => {
    useToolBuilderStore.getState().addNode('join');
    const joinId = useToolBuilderStore.getState().selectedNodeId ?? '';
    expect(useToolBuilderStore.getState().edges.at(-1)).toMatchObject({ source: 'filter-1', target: joinId, targetHandle: 'in-0' });

    useToolBuilderStore.getState().addNode('csv-source');
    const csvId = useToolBuilderStore.getState().selectedNodeId ?? '';
    useToolBuilderStore.getState().onConnect({ source: csvId, target: joinId, sourceHandle: null, targetHandle: 'in-1' });

    const graph = currentGraph();
    expect(graph.edges).toContainEqual({ from: 'filter-1', to: joinId, toInput: 0 });
    expect(graph.edges).toContainEqual({ from: csvId, to: joinId, toInput: 1 });
    // 単一入力ノードへのedgeはtoInputなしのまま。
    expect(graph.edges).toContainEqual({ from: 'source-1', to: 'filter-1' });
  });

  it('同一入力ポートへの二重接続は既存単一入力と同じく許容し、arity検証はengine側に委ねる', () => {
    useToolBuilderStore.getState().addNode('union');
    const unionId = useToolBuilderStore.getState().selectedNodeId ?? '';
    useToolBuilderStore.getState().addNode('csv-source');
    const csvId = useToolBuilderStore.getState().selectedNodeId ?? '';
    const before = useToolBuilderStore.getState().edges.length;
    useToolBuilderStore.getState().onConnect({ source: csvId, target: unionId, sourceHandle: null, targetHandle: 'in-0' });
    expect(useToolBuilderStore.getState().edges).toHaveLength(before + 1);
    const graph = currentGraph();
    expect(graph.edges.filter((edge) => edge.to === unionId && edge.toInput === 0)).toHaveLength(2);
  });

  it('保存済みDTOのtoInputをtarget handleへ復元し、再serializeで維持する', () => {
    const tool = {
      metadata: { internalId: 'joined', workingName: 'w', displayName: 'Joined', publishName: 'joined', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: {
        nodes: [
          { id: 'left-1', type: 'json-source', config: { rows: [] } },
          { id: 'right-1', type: 'json-source', config: { rows: [] } },
          { id: 'join-1', type: 'join', config: { mode: 'inner', keys: [{ left: 'id', right: 'id' }], rightSuffix: '_right' } },
        ],
        edges: [
          { from: 'left-1', to: 'join-1', toInput: 0 },
          { from: 'right-1', to: 'join-1', toInput: 1 },
        ],
      },
    } as SerializedToolDto;
    useToolBuilderStore.getState().loadTool(tool);
    expect(useToolBuilderStore.getState().edges.map((edge) => edge.targetHandle)).toEqual(['in-0', 'in-1']);
    expect(currentGraph().edges).toEqual([
      { from: 'left-1', to: 'join-1', toInput: 0 },
      { from: 'right-1', to: 'join-1', toInput: 1 },
    ]);
  });

  it('下書きの切り出しと復元でmetadata・ノード・エッジが往復する', () => {
    const store = useToolBuilderStore.getState();
    store.setMetadata('internalId', 'draft-tool');
    store.setMetadata('displayName', 'Draft tool');
    useToolBuilderStore.getState().addNode('filter');
    const snapshot = JSON.parse(JSON.stringify(toolBuilderDraft(useToolBuilderStore.getState())));

    useToolBuilderStore.getState().reset();
    expect(useToolBuilderStore.getState().metadata.internalId).toBe('');

    useToolBuilderStore.getState().applyDraft(snapshot);
    const restored = useToolBuilderStore.getState();
    expect(restored.metadata.internalId).toBe('draft-tool');
    expect(restored.metadata.displayName).toBe('Draft tool');
    expect(restored.nodes.map((node) => node.id)).toEqual(snapshot.nodes.map((node: { id: string }) => node.id));
    expect(restored.edges.map((edge) => edge.id)).toEqual(snapshot.edges.map((edge: { id: string }) => edge.id));
    // 派生状態は捨てて自動プレビューに再計算させる。
    expect(restored.selectedNodeId).toBe(snapshot.nodes[0].id);
    expect(restored.propagation).toBeUndefined();
    expect(restored.preview).toBeUndefined();
    expect(restored.saveError).toBeUndefined();
  });
});
