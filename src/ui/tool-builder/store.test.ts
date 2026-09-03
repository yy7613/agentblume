import { beforeEach, describe, expect, it } from 'vitest';
import type { SerializedToolDto } from '../api/types';
import { buildSaveDto, currentGraph, declaredInputSchema, effectiveFunctionName, flowToGraph, missingRequiredMetadata, requiresSessionWrite, saveBlocker, toolBuilderDraft, useToolBuilderStore } from './store';

const okPropagation = {
  order: ['source-1', 'filter-1'], terminalId: 'filter-1', hasErrors: false,
  nodes: {
    'source-1': { nodeId: 'source-1', state: 'inferred' as const, issues: [], schema: { columns: [{ name: 'age', type: 'number' as const, nullable: false }] } },
    'filter-1': { nodeId: 'filter-1', state: 'inferred' as const, issues: [], schema: { columns: [{ name: 'age', type: 'number' as const, nullable: false }] } },
  },
};

function fillMetadata(): void {
  const { setMetadata } = useToolBuilderStore.getState();
  setMetadata('internalId', 'customer-filter');
  setMetadata('workingName', 'Customer filter draft');
  setMetadata('displayName', 'Customer filter');
  setMetadata('publishName', 'adult_customers');
  setMetadata('owner', 'owner@example.com');
}

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
      order: ['source-1', 'filter-1'], terminalId: 'filter-1', hasErrors: false,
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
    expect(restored.propagationPending).toBe(true);
    expect(restored.diagnostics).toBeUndefined();
  });

  describe('sideEffect の自動繰り上げ（サーバーの hasSessionStorageSink と同じ集合）', () => {
    it('chart-output を追加すると read-only を session-write へ上げる', () => {
      useToolBuilderStore.getState().addNode('chart-output');
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');
    });

    it('agent-output は overflow を store-and-reference へ変えた時点で上げる（既定の error は直接返却）', () => {
      useToolBuilderStore.getState().addNode('agent-output');
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('read-only');
      const id = useToolBuilderStore.getState().selectedNodeId ?? '';
      useToolBuilderStore.getState().updateNodeConfig(id, { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'store-and-reference' });
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');
    });

    it('read-only より強い副作用は下げない', () => {
      useToolBuilderStore.getState().setMetadata('sideEffect', 'write');
      useToolBuilderStore.getState().addNode('workspace-output');
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('write');
    });

    it('書き込み終端を消しても副作用は下げない（下げるのは利用者の明示操作だけ）', () => {
      useToolBuilderStore.getState().addNode('chart-output');
      const chartId = useToolBuilderStore.getState().selectedNodeId ?? '';
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');
      useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: chartId }]);
      expect(useToolBuilderStore.getState().nodes.some((node) => node.id === chartId)).toBe(false);
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');

      // agent-output の overflow を error へ戻しても下げない。
      useToolBuilderStore.getState().addNode('agent-output');
      const outId = useToolBuilderStore.getState().selectedNodeId ?? '';
      useToolBuilderStore.getState().updateNodeConfig(outId, { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' });
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');
      // 利用者が read-only へ戻すのは通す（書き込み終端が無いので繰り上げも起きない）。
      useToolBuilderStore.getState().setMetadata('sideEffect', 'read-only');
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('read-only');
      // 再び store-and-reference にすると繰り上がる。
      useToolBuilderStore.getState().updateNodeConfig(outId, { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'store-and-reference' });
      expect(useToolBuilderStore.getState().metadata.sideEffect).toBe('session-write');
    });

    it('requiresSessionWrite は4種類の書き込み終端だけを対象にする', () => {
      const node = (id: string, nodeType: 'agent-output' | 'workspace-output' | 'graph-output' | 'chart-output' | 'select', config: Record<string, unknown>) =>
        ({ id, type: 'tool' as const, position: { x: 0, y: 0 }, data: { nodeType, label: id, config } });
      expect(requiresSessionWrite([node('a', 'select', { columns: [] }), node('b', 'agent-output', { overflow: 'error' })])).toBe(false);
      expect(requiresSessionWrite([node('a', 'agent-output', { overflow: 'store-and-reference' })])).toBe(true);
      expect(requiresSessionWrite([node('a', 'workspace-output', {})])).toBe(true);
      expect(requiresSessionWrite([node('a', 'graph-output', {})])).toBe(true);
      expect(requiresSessionWrite([node('a', 'chart-output', {})])).toBe(true);
    });
  });

  describe('検証待ち（propagationPending）', () => {
    it('初期状態と保存内容の変更で待ちになり、検証結果が届くと解除される', () => {
      expect(useToolBuilderStore.getState().propagationPending).toBe(true);
      useToolBuilderStore.getState().setPropagation(okPropagation);
      expect(useToolBuilderStore.getState().propagationPending).toBe(false);

      for (const change of [
        () => useToolBuilderStore.getState().addNode('select'),
        () => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 20 }),
        () => useToolBuilderStore.getState().onConnect({ source: 'source-1', target: 'filter-1', sourceHandle: null, targetHandle: null }),
        () => useToolBuilderStore.getState().onEdgesChange([{ type: 'remove', id: 'source-1-filter-1' }]),
        () => useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: 'source-1' }]),
      ]) {
        useToolBuilderStore.getState().setPropagation(okPropagation);
        change();
        expect(useToolBuilderStore.getState().propagationPending).toBe(true);
      }
    });

    it('Toolの読み込み・下書き復元・リセットではグラフが替わるので再び待ちになる', () => {
      useToolBuilderStore.getState().setPropagation(okPropagation);
      expect(useToolBuilderStore.getState().propagationPending).toBe(false);
      useToolBuilderStore.getState().loadTool({
        metadata: { internalId: 'loaded', workingName: 'w', displayName: 'L', publishName: 'l', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
        sideEffect: 'read-only', graph: { nodes: [{ id: 'a', type: 'json-source', config: { rows: [] } }], edges: [] },
      } as SerializedToolDto);
      expect(useToolBuilderStore.getState()).toMatchObject({ propagationPending: true, propagation: undefined });

      useToolBuilderStore.getState().setPropagation(okPropagation);
      useToolBuilderStore.getState().applyDraft(toolBuilderDraft(useToolBuilderStore.getState()));
      expect(useToolBuilderStore.getState()).toMatchObject({ propagationPending: true, propagation: undefined });

      useToolBuilderStore.getState().setPropagation(okPropagation);
      useToolBuilderStore.getState().reset();
      expect(useToolBuilderStore.getState()).toMatchObject({ propagationPending: true, propagation: undefined, previewLoading: false });
    });

    it('選択・移動だけでは待ちにならず、理由付きの失敗は「検証済み」と見なす', () => {
      useToolBuilderStore.getState().setPropagation(okPropagation);
      useToolBuilderStore.getState().onNodesChange([{ type: 'select', id: 'source-1', selected: true }, { type: 'position', id: 'filter-1', position: { x: 1, y: 2 } }]);
      expect(useToolBuilderStore.getState().propagationPending).toBe(false);

      useToolBuilderStore.getState().addNode('select');
      // 要求開始時の draftIssue クリアでは解除しない。
      useToolBuilderStore.getState().setDraftIssue(undefined);
      expect(useToolBuilderStore.getState().propagationPending).toBe(true);
      useToolBuilderStore.getState().setDraftIssue('Configuration is incomplete: x');
      expect(useToolBuilderStore.getState().propagationPending).toBe(false);
    });
  });

  describe('保存前ガード（saveBlocker）', () => {
    const state = () => useToolBuilderStore.getState();

    it('必須メタデータ → function 名 → Agent Input の衝突 → 検証待ち → グラフエラーの順に理由を返す', () => {
      expect(saveBlocker(state())).toEqual({ kind: 'missing-metadata', keys: ['internalId', 'workingName', 'displayName', 'publishName', 'owner'] });
      fillMetadata();
      state().setMetadata('publishName', 'adult customers');
      expect(saveBlocker(state())).toEqual({ kind: 'invalid-function-name', name: 'adult customers' });
      state().setMetadata('publishName', 'adult_customers');

      state().addNode('agent-input');
      state().addNode('agent-input');
      const inputs = state().nodes.filter((node) => node.data.nodeType === 'agent-input');
      state().updateNodeConfig(inputs[1]!.id, { schema: { columns: [{ name: 'other', type: 'string', nullable: true }] }, sample: {} });
      expect(saveBlocker(state())).toEqual({ kind: 'agent-input-conflict' });
      state().updateNodeConfig(inputs[1]!.id, inputs[0]!.data.config);

      expect(saveBlocker(state())).toEqual({ kind: 'validation-pending' });
      state().setPropagation({ ...okPropagation, hasErrors: true });
      expect(saveBlocker(state())).toEqual({ kind: 'graph-errors' });
      state().setPropagation(okPropagation);
      expect(saveBlocker(state())).toBeUndefined();
    });

    it('agentTool（名前 + 説明）があればその名前を function 名として検証する', () => {
      fillMetadata();
      state().setMetadata('agentName', 'bad name');
      // 説明が無い間は agentTool を送らないので publishName で判定する。
      expect(effectiveFunctionName(state().metadata)).toBe('adult_customers');
      state().setMetadata('agentDescription', 'desc');
      expect(effectiveFunctionName(state().metadata)).toBe('bad name');
      state().setPropagation(okPropagation);
      expect(saveBlocker(state())).toEqual({ kind: 'invalid-function-name', name: 'bad name' });
    });

    it('自動検証の失敗（draftIssue）や実行中（previewLoading）も保存を止める', () => {
      fillMetadata();
      state().setPropagation(okPropagation);
      state().setPreviewLoading(true);
      expect(saveBlocker(state())).toEqual({ kind: 'validation-pending' });
      state().setPreviewLoading(false);
      state().setDraftIssue('offline');
      expect(saveBlocker(state())).toEqual({ kind: 'graph-errors' });
    });

    it('理由が同時に複数あれば優先順の先頭だけを返す（未入力 > function 名 > 衝突 > 検証待ち）', () => {
      // 必須メタデータの未入力と無効な function 名: 未入力を先に伝える（keys から publishName は外れる）。
      state().setMetadata('publishName', 'bad name');
      expect(saveBlocker(state())).toEqual({ kind: 'missing-metadata', keys: ['internalId', 'workingName', 'displayName', 'owner'] });
      // 無効な function 名と Agent Input の衝突と検証待ち: function 名を先に伝える。
      fillMetadata();
      state().setMetadata('publishName', 'bad name');
      state().addNode('agent-input');
      state().addNode('agent-input');
      const second = state().nodes.filter((node) => node.data.nodeType === 'agent-input')[1];
      state().updateNodeConfig(second!.id, { schema: { columns: [] }, sample: {} });
      expect(state().propagationPending).toBe(true);
      expect(saveBlocker(state())).toEqual({ kind: 'invalid-function-name', name: 'bad name' });
      // 衝突と検証待ちと draftIssue: 衝突を先に伝える。
      state().setMetadata('publishName', 'good_name');
      state().setDraftIssue('offline');
      expect(saveBlocker(state())).toEqual({ kind: 'agent-input-conflict' });
    });

    it('function 名は64文字まで許し、65文字で止める（publishName でも agentTool 名でも同じ上限）', () => {
      fillMetadata();
      state().setPropagation(okPropagation);
      state().setMetadata('publishName', 'a'.repeat(64));
      expect(saveBlocker(state())).toBeUndefined();
      state().setMetadata('publishName', 'a'.repeat(65));
      expect(saveBlocker(state())).toEqual({ kind: 'invalid-function-name', name: 'a'.repeat(65) });

      state().setMetadata('publishName', 'adult_customers');
      state().setMetadata('agentName', 'b'.repeat(64));
      state().setMetadata('agentDescription', 'desc');
      expect(saveBlocker(state())).toBeUndefined();
      state().setMetadata('agentName', 'b'.repeat(65));
      expect(saveBlocker(state())).toEqual({ kind: 'invalid-function-name', name: 'b'.repeat(65) });
      // 空白だけの agentName は agentTool 無しと同じで publishName で判定する。
      state().setMetadata('agentName', '   ');
      expect(saveBlocker(state())).toBeUndefined();
    });
  });

  describe('buildSaveDto', () => {
    it('agentTool・inputSchema・outputSchema を揃っているときだけ載せ、グラフは座標付きで書き出す', () => {
      fillMetadata();
      expect(buildSaveDto()).toEqual({
        scope: { tenantId: 'local', workspaceId: 'default' },
        internalId: 'customer-filter', workingName: 'Customer filter draft', displayName: 'Customer filter', publishName: 'adult_customers',
        owner: 'owner@example.com', sideEffect: 'read-only', graph: currentGraph(),
      });

      useToolBuilderStore.getState().setMetadata('agentName', 'find_adults');
      useToolBuilderStore.getState().setMetadata('agentDescription', 'Find adults.');
      useToolBuilderStore.getState().addNode('agent-input');
      useToolBuilderStore.getState().setPropagation(okPropagation);
      const dto = buildSaveDto();
      expect(dto.agentTool).toEqual({ name: 'find_adults', description: 'Find adults.' });
      expect(dto.inputSchema).toEqual({ columns: [{ name: 'query', type: 'string', nullable: false }] });
      // 出力は終端（terminalId）の推論結果。order の末尾ではない。
      expect(dto.outputSchema).toEqual(okPropagation.nodes['filter-1'].schema);
    });

    it('agentTool は名前と説明の片方だけ（空白だけを含む）では載せない', () => {
      fillMetadata();
      useToolBuilderStore.getState().setMetadata('agentName', 'find_adults');
      expect(buildSaveDto()).not.toHaveProperty('agentTool');
      useToolBuilderStore.getState().setMetadata('agentName', '');
      useToolBuilderStore.getState().setMetadata('agentDescription', 'Find adults.');
      expect(buildSaveDto()).not.toHaveProperty('agentTool');
      useToolBuilderStore.getState().setMetadata('agentName', '   ');
      expect(buildSaveDto()).not.toHaveProperty('agentTool');
      useToolBuilderStore.getState().setMetadata('agentName', 'find_adults');
      expect(buildSaveDto().agentTool).toEqual({ name: 'find_adults', description: 'Find adults.' });
    });

    it('outputSchema は order の末尾ではなく terminalId の推論結果で、終端が結果に無ければ載せない', () => {
      fillMetadata();
      // agent-input（引数宣言）は流れに乗らないので order の末尾に来うる。終端は filter-1。
      useToolBuilderStore.getState().addNode('agent-input');
      const args = useToolBuilderStore.getState().selectedNodeId ?? '';
      const argsSchema = { columns: [{ name: 'query', type: 'string' as const, nullable: false }] };
      useToolBuilderStore.getState().setPropagation({
        order: ['source-1', 'filter-1', args], terminalId: 'filter-1', hasErrors: false,
        nodes: { ...okPropagation.nodes, [args]: { nodeId: args, state: 'confirmed', issues: [], schema: argsSchema } },
      });
      expect(buildSaveDto().outputSchema).toEqual(okPropagation.nodes['filter-1'].schema);
      expect(buildSaveDto().inputSchema).toEqual(argsSchema);

      useToolBuilderStore.getState().setPropagation({ ...okPropagation, terminalId: 'ghost' });
      expect(buildSaveDto()).not.toHaveProperty('outputSchema');
      useToolBuilderStore.getState().setPropagation(undefined);
      expect(buildSaveDto()).not.toHaveProperty('outputSchema');
    });

    it('declaredInputSchema は先頭の宣言を返し、食い違う宣言があれば衝突と報告する', () => {
      expect(declaredInputSchema(useToolBuilderStore.getState().nodes)).toEqual({ conflict: false });
      useToolBuilderStore.getState().addNode('agent-input');
      useToolBuilderStore.getState().addNode('agent-input');
      const first = useToolBuilderStore.getState().nodes.find((node) => node.data.nodeType === 'agent-input');
      expect(declaredInputSchema(useToolBuilderStore.getState().nodes)).toEqual({ schema: first?.data.config['schema'], conflict: false });
      const second = useToolBuilderStore.getState().nodes.filter((node) => node.data.nodeType === 'agent-input')[1];
      useToolBuilderStore.getState().updateNodeConfig(second!.id, { schema: { columns: [] }, sample: {} });
      expect(declaredInputSchema(useToolBuilderStore.getState().nodes)).toEqual({ schema: first?.data.config['schema'], conflict: true });
    });
  });

  it('呼び出し診断の結果は保持し、Toolの読み込み・下書き復元・リセットで消す', () => {
    const result = { internalId: 't', version: 'draft', source: 'direct' as const, status: 'ok' as const, checks: [] };
    useToolBuilderStore.getState().setDiagnostics(result);
    useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 20 });
    expect(useToolBuilderStore.getState().diagnostics).toEqual(result);
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'loaded', workingName: 'w', displayName: 'Loaded', publishName: 'loaded', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only', graph: { nodes: [], edges: [] },
    } as SerializedToolDto);
    expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();
    useToolBuilderStore.getState().setDiagnostics('loading');
    useToolBuilderStore.getState().reset();
    expect(useToolBuilderStore.getState().diagnostics).toBeUndefined();
  });
});
