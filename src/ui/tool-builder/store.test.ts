import { beforeEach, describe, expect, it } from 'vitest';
import type { SerializedToolDto } from '../api/types';
import type { InstantiatedTemplateDto } from '../api/types';
import type { DesignChatResultDto, ToolGraphDto } from '../api/types';
import { buildSaveDto, currentGraph, designChatTranscript, declaredInputSchema, effectiveFunctionName, flowToGraph, missingRequiredMetadata, requiresSessionWrite, saveBlocker, toolBuilderDraft, useToolBuilderStore, type DesignChatTurn } from './store';

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
    // v52: owner は入力必須から外れた（未入力・空白のみでも missing に出ない）。
    expect(missingRequiredMetadata(useToolBuilderStore.getState().metadata)).toEqual(['internalId', 'workingName', 'displayName', 'publishName']);
    for (const [key, value] of [['internalId', 'tool'], ['workingName', 'draft'], ['displayName', 'Tool'], ['publishName', 'tool_v1'], ['owner', ' ']] as const) {
      useToolBuilderStore.getState().setMetadata(key, value);
    }
    expect(missingRequiredMetadata(useToolBuilderStore.getState().metadata)).toEqual([]);
  });

  it('正常: 所有者(owner)が空でも他の必須項目さえ埋まれば missing に出ない', () => {
    const { setMetadata } = useToolBuilderStore.getState();
    setMetadata('internalId', 'tool'); setMetadata('workingName', 'draft'); setMetadata('displayName', 'Tool'); setMetadata('publishName', 'tool_v1');
    expect(useToolBuilderStore.getState().metadata.owner).toBe('');
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
      // v52: owner は必須キーから外れた。
      expect(saveBlocker(state())).toEqual({ kind: 'missing-metadata', keys: ['internalId', 'workingName', 'displayName', 'publishName'] });
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
      // v52: owner は必須キーから外れた。
      expect(saveBlocker(state())).toEqual({ kind: 'missing-metadata', keys: ['internalId', 'workingName', 'displayName'] });
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

describe('loadTemplate', () => {
  const instantiated: InstantiatedTemplateDto = {
    template: { id: 'period-series', version: '1.0.0' },
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-a' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'granularity', type: 'string', nullable: false }] }, sample: { granularity: 'year' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 10, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'period-series', description: '推移を返します。' },
    pendingExpressions: [],
  };

  beforeEach(() => useToolBuilderStore.getState().reset());

  it('正常: 新しい下書きとして展開し、メタデータと Agent Tool 契約を埋める（版は付けない）', () => {
    useToolBuilderStore.getState().loadTemplate(instantiated, '時系列の取り出し');
    const state = useToolBuilderStore.getState();
    expect(state.metadata).toMatchObject({
      internalId: 'period-series', workingName: '時系列の取り出し', displayName: '時系列の取り出し',
      publishName: 'period-series', agentName: 'period-series', agentDescription: '推移を返します。', owner: '',
    });
    expect(state.currentVersion).toBeUndefined();
    expect(state.versions).toEqual([]);
    expect(state.createdFromTemplate).toBe('period-series@1.0.0');
    // 引数は agent-input ノードの宣言から保存 DTO へ渡る（保存済み Tool を開いたときと同じ経路）。
    expect(declaredInputSchema(state.nodes).schema?.columns.map((column) => column.name)).toEqual(['granularity']);
  });

  it('正常: 展開直後は検証待ちで、前の推論結果・プレビュー・失敗は残さない', () => {
    useToolBuilderStore.getState().setPropagation(okPropagation);
    useToolBuilderStore.getState().setSaveError('前の失敗');
    useToolBuilderStore.getState().loadTemplate(instantiated, 'x');
    const state = useToolBuilderStore.getState();
    expect(state.propagation).toBeUndefined();
    expect(state.propagationPending).toBe(true);
    expect(state.saveError).toBeUndefined();
  });

  it('正常: 式が空の calculate があれば、そのノードを選び意図文を預ける', () => {
    useToolBuilderStore.getState().loadTemplate({
      ...instantiated,
      graph: { nodes: [...instantiated.graph.nodes, { id: 'calc', type: 'calculate', config: { expression: '' } }], edges: instantiated.graph.edges },
      pendingExpressions: [{ nodeId: 'calc', intent: '人口を千で割る' }],
    }, 'x');
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('calc');
    expect(useToolBuilderStore.getState().pendingCalculateIntent).toEqual({ nodeId: 'calc', intent: '人口を千で割る' });
  });

  it('境界: 意図文は同じノードで 1 度だけ返る', () => {
    useToolBuilderStore.getState().loadTemplate({
      ...instantiated,
      graph: { nodes: [...instantiated.graph.nodes, { id: 'calc', type: 'calculate', config: { expression: '' } }], edges: instantiated.graph.edges },
      pendingExpressions: [{ nodeId: 'calc', intent: '人口を千で割る' }],
    }, 'x');
    expect(useToolBuilderStore.getState().consumePendingCalculateIntent('calc')).toBe('人口を千で割る');
    expect(useToolBuilderStore.getState().consumePendingCalculateIntent('calc')).toBeUndefined();
  });

  it('異常: 別のノードを名指しても意図文は渡さない', () => {
    useToolBuilderStore.getState().loadTemplate({ ...instantiated, pendingExpressions: [{ nodeId: 'calc', intent: 'x' }] }, 'x');
    expect(useToolBuilderStore.getState().consumePendingCalculateIntent('src')).toBeUndefined();
    expect(useToolBuilderStore.getState().pendingCalculateIntent).toEqual({ nodeId: 'calc', intent: 'x' });
  });

  it('従来どおり: reset はテンプレート由来の状態も消す', () => {
    useToolBuilderStore.getState().loadTemplate(instantiated, 'x');
    useToolBuilderStore.getState().reset();
    expect(useToolBuilderStore.getState().createdFromTemplate).toBeUndefined();
    expect(useToolBuilderStore.getState().pendingCalculateIntent).toBeUndefined();
  });
});

/**
 * 設計アシスタント（v47 / ADR-0051）。
 *
 * ストア側の責務は「応答をキャンバスへ当てる」ことと「1 手で元へ戻せる」こと。
 * starter グラフは source-1 (80,120) → filter-1 (390,120) の 2 ノード。
 */
describe('designChat', () => {
  /** サーバーは変えなかったノードの position を写して返す（契約 §3）。 */
  const keptNodes = [
    { id: 'source-1', type: 'json-source', config: { rows: [] }, position: { x: 80, y: 120 } },
    { id: 'filter-1', type: 'filter', config: { column: 'age', op: 'gte', value: 18 }, position: { x: 390, y: 120 } },
  ];
  const withSort: ToolGraphDto = {
    nodes: [...keptNodes, { id: 'sort-1', type: 'sort', config: { by: 'age' } }],
    edges: [{ from: 'source-1', to: 'filter-1' }, { from: 'filter-1', to: 'sort-1' }],
  };
  const sortResult: DesignChatResultDto = {
    message: '並べ替えを足しました。',
    graph: withSort,
    changes: [{ op: 'add-node', nodeId: 'sort-1', summary: 'sort を追加' }, { op: 'set-config', nodeId: 'filter-1', summary: 'filter を age >= 20 へ' }],
    problems: [],
  };

  /** 1 往復を丸ごと進める（送って応答を受け取る）。 */
  function exchange(instruction: string, result: DesignChatResultDto): string {
    const id = useToolBuilderStore.getState().startDesignChatTurn(instruction);
    useToolBuilderStore.getState().completeDesignChatTurn(id, result);
    return id;
  }
  function turnAt(index: number): DesignChatTurn {
    return useToolBuilderStore.getState().designChat.turns[index] as DesignChatTurn;
  }

  beforeEach(() => useToolBuilderStore.getState().reset());

  it('正常: 指示を送ると会話へ積まれ、送信中になる', () => {
    const id = useToolBuilderStore.getState().startDesignChatTurn('年次に絞って');
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat.busy).toBe(true);
    expect(designChat.turns).toHaveLength(1);
    expect(turnAt(0)).toMatchObject({ id, user: '年次に絞って', changes: [], problems: [], reverted: false });
    expect(turnAt(0).assistant).toBeUndefined();
  });

  it('正常: 返答のグラフを即座にキャンバスへ当て、変えなかったノードの配置を保つ', () => {
    exchange('多い順に並べて', sortResult);
    const state = useToolBuilderStore.getState();
    expect(state.designChat.busy).toBe(false);
    expect(state.nodes.map((node) => node.id)).toEqual(['source-1', 'filter-1', 'sort-1']);
    expect(state.nodes.find((node) => node.id === 'filter-1')?.position).toEqual({ x: 390, y: 120 });
    expect(state.edges.map((edge) => [edge.source, edge.target])).toEqual([['source-1', 'filter-1'], ['filter-1', 'sort-1']]);
    // 会話は下書き（保存対象）には入らない。
    expect(Object.keys(toolBuilderDraft(state))).toEqual(['metadata', 'nodes', 'edges']);
  });

  it('正常: 新しいノードは上流ノードの右 220px へ置く', () => {
    exchange('多い順に並べて', sortResult);
    expect(useToolBuilderStore.getState().nodes.find((node) => node.id === 'sort-1')?.position).toEqual({ x: 610, y: 120 });
  });

  it('境界: 上流が無い新しいノードは、既存の最右列のさらに右へ縦に並べる', () => {
    // データソースを 2 本足しただけで、まだどこへも繋いでいない状態（契約 §4 の孤立ノード）。
    exchange('CSV を 2 つ読み込んで', {
      message: '2 つ足しました。',
      graph: {
        nodes: [...keptNodes, { id: 'csv-1', type: 'csv-source', config: {} }, { id: 'csv-2', type: 'csv-source', config: {} }],
        edges: [{ from: 'source-1', to: 'filter-1' }],
      },
      changes: [{ op: 'add-node', nodeId: 'csv-1', summary: 'csv-source を追加' }, { op: 'add-node', nodeId: 'csv-2', summary: 'csv-source を追加' }],
    });
    const at = (id: string) => useToolBuilderStore.getState().nodes.find((node) => node.id === id)?.position;
    // 最右は filter-1 (390)。その右の列（670）へ、重ならないよう縦に積む。
    expect(at('csv-1')).toEqual({ x: 670, y: 120 });
    expect(at('csv-2')?.x).toBe(670);
    expect(at('csv-2')?.y).toBeGreaterThan(120);
  });

  it('正常: 追加・変更したノードを強調し、最初の変更ノードを選択する', () => {
    exchange('多い順に並べて', sortResult);
    expect(useToolBuilderStore.getState().designChat.highlight).toEqual(['sort-1', 'filter-1']);
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('sort-1');
    useToolBuilderStore.getState().clearDesignChatHighlight();
    expect(useToolBuilderStore.getState().designChat.highlight).toEqual([]);
  });

  it('異常: 消えたノードを指す変更では強調も選択も動かさない', () => {
    useToolBuilderStore.getState().selectNode('filter-1');
    exchange('distinct を外して', {
      message: '外しました。',
      graph: { nodes: keptNodes, edges: [{ from: 'source-1', to: 'filter-1' }] },
      changes: [{ op: 'remove-node', nodeId: 'distinct-1', summary: 'distinct を削除' }],
    });
    expect(useToolBuilderStore.getState().designChat.highlight).toEqual([]);
    expect(useToolBuilderStore.getState().selectedNodeId).toBe('filter-1');
  });

  it('正常: 変更が無い返答（質問への回答）ではキャンバスを触らない', () => {
    const before = currentGraph();
    exchange('この結合のキーは足りている？', { message: '足りています。', changes: [], problems: [] });
    expect(currentGraph()).toEqual(before);
    expect(turnAt(0).assistant).toBe('足りています。');
    expect(turnAt(0).before).toBeUndefined();
  });

  it('異常: problems 付きの返答は理由だけ残し、キャンバスを変えない', () => {
    const before = currentGraph();
    exchange('無理な指示', { message: '適用できませんでした。', changes: [], problems: ['sort: column(s) not found: population'] });
    expect(currentGraph()).toEqual(before);
    expect(turnAt(0).problems).toEqual(['sort: column(s) not found: population']);
    expect(turnAt(0).before).toBeUndefined();
  });

  it('正常: 取り消すと適用前のキャンバスへ戻り、以後のターンにも取り消し済みが付く', () => {
    const before = currentGraph();
    const first = exchange('多い順に並べて', sortResult);
    exchange('10 件に絞って', {
      message: '絞りました。',
      graph: {
        nodes: [...withSort.nodes.map((node) => ({ ...node, position: node.position ?? { x: 610, y: 120 } })), { id: 'limit-1', type: 'limit', config: { count: 10 } }],
        edges: [...withSort.edges, { from: 'sort-1', to: 'limit-1' }],
      },
      changes: [{ op: 'add-node', nodeId: 'limit-1', summary: 'limit を追加' }],
    });
    expect(useToolBuilderStore.getState().nodes).toHaveLength(4);

    useToolBuilderStore.getState().revertDesignChatTurn(first);
    expect(currentGraph()).toEqual(before);
    // 会話そのものは残す（何を頼んだかは読める）。
    expect(useToolBuilderStore.getState().designChat.turns).toHaveLength(2);
    expect(turnAt(0).reverted).toBe(true);
    expect(turnAt(1).reverted).toBe(true);
  });

  it('境界: 取り消しは 1 度だけ効き、2 度目は同じキャンバスのまま', () => {
    const before = currentGraph();
    const first = exchange('多い順に並べて', sortResult);
    useToolBuilderStore.getState().revertDesignChatTurn(first);
    useToolBuilderStore.getState().revertDesignChatTurn(first);
    expect(currentGraph()).toEqual(before);
  });

  it('異常: キャンバスを変えていないターンは取り消せない（戻り先が無い）', () => {
    const id = exchange('この結合のキーは足りている？', { message: '足りています。', changes: [] });
    const before = currentGraph();
    useToolBuilderStore.getState().revertDesignChatTurn(id);
    expect(currentGraph()).toEqual(before);
    expect(turnAt(0).reverted).toBe(false);
  });

  it('異常: 応答が受け取れなければ理由を出し、送信中を解く（キャンバスはそのまま）', () => {
    const before = currentGraph();
    const id = useToolBuilderStore.getState().startDesignChatTurn('年次に絞って');
    useToolBuilderStore.getState().failDesignChatTurn(id, 'Network error');
    expect(useToolBuilderStore.getState().designChat).toMatchObject({ busy: false, error: 'Network error' });
    expect(useToolBuilderStore.getState().designChat.turns).toHaveLength(1);
    expect(currentGraph()).toEqual(before);
  });

  it('例外: 会話が消えた後に届いた応答はキャンバスへ当てない', () => {
    const id = useToolBuilderStore.getState().startDesignChatTurn('年次に絞って');
    useToolBuilderStore.getState().reset();
    const before = currentGraph();
    useToolBuilderStore.getState().completeDesignChatTurn(id, sortResult);
    useToolBuilderStore.getState().failDesignChatTurn(id, 'Network error');
    expect(currentGraph()).toEqual(before);
    expect(useToolBuilderStore.getState().designChat.turns).toEqual([]);
    expect(useToolBuilderStore.getState().designChat.error).toBeUndefined();
  });

  it('正常: 新規作成・別のツールを開く・テンプレートから作るで会話は消え、開閉は残る', () => {
    const openAndTalk = () => { useToolBuilderStore.getState().setDesignChatOpen(true); exchange('多い順に並べて', sortResult); };
    const clearedButOpen = () => {
      expect(useToolBuilderStore.getState().designChat.turns).toEqual([]);
      expect(useToolBuilderStore.getState().designChat.open).toBe(true);
    };

    openAndTalk();
    useToolBuilderStore.getState().reset();
    clearedButOpen();

    openAndTalk();
    useToolBuilderStore.getState().loadTool({
      metadata: { internalId: 'other', workingName: 'w', displayName: 'O', publishName: 'o', version: '1.0.0', owner: 'o', state: 'draft', tenant: { tenantId: 't', workspaceId: 'w' } },
      sideEffect: 'read-only',
      graph: { nodes: [{ id: 'a', type: 'json-source', config: { rows: [] } }], edges: [] },
    } as SerializedToolDto);
    clearedButOpen();

    openAndTalk();
    useToolBuilderStore.getState().loadTemplate({
      template: { id: 'period-series', version: '1.0.0' },
      graph: { nodes: [{ id: 'src', type: 'csv-source', config: {} }], edges: [] },
      agentTool: { name: 'period-series', description: 'd' },
      pendingExpressions: [],
    }, 'x');
    clearedButOpen();
  });

  // --- v49: 文脈の消費・履歴の圧縮とクリア・Tool Calling 契約の説明 ---------------------------

  /** グラフを変えない往復を count 回積む（圧縮の材料づくり）。 */
  function talk(count: number, offset = 0): void {
    for (let index = offset; index < offset + count; index += 1) {
      exchange(`指示${index}`, { message: `返答${index}`, changes: [{ op: 'set-config', nodeId: 'filter-1', summary: `変更${index}` }] });
    }
  }

  it('正常: 直前の応答の消費を持ち、消費を返さない応答では捨てる', () => {
    exchange('多い順に並べて', { ...sortResult, usage: { promptTokens: 6812, completionTokens: 240, contextWindow: 200192 } });
    expect(useToolBuilderStore.getState().designChat.usage).toEqual({ promptTokens: 6812, completionTokens: 240, contextWindow: 200192 });
    // メーターは「直前の応答」だけを映す。数えられなかった応答の後に古い値を残すと嘘になる。
    exchange('この結合のキーは足りている？', { message: '足りています。', changes: [] });
    expect(useToolBuilderStore.getState().designChat.usage).toBeUndefined();
  });

  it('正常: 応答の agentTool を Tool Calling 契約へ反映し、取り消しで戻す', () => {
    useToolBuilderStore.getState().setMetadata('agentName', 'population_top');
    useToolBuilderStore.getState().setMetadata('agentDescription', '古い説明');
    const id = exchange('説明文に日付の渡し方を書いて', {
      ...sortResult,
      agentTool: { name: 'population_all', description: '都道府県別の総人口を返す。date は ISO（期間の開始日）。' },
      changes: [{ op: 'set-agent-tool', nodeId: 'agent-tool', summary: 'set the tool description for the agent' }],
    });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'population_all', agentDescription: '都道府県別の総人口を返す。date は ISO（期間の開始日）。' });

    useToolBuilderStore.getState().revertDesignChatTurn(id);
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'population_top', agentDescription: '古い説明' });
  });

  it('境界: name を返さない応答では説明だけを更新する', () => {
    useToolBuilderStore.getState().setMetadata('agentName', 'population_top');
    exchange('説明を直して', { message: '直しました。', changes: [], agentTool: { description: '新しい説明' } });
    expect(useToolBuilderStore.getState().metadata).toMatchObject({ agentName: 'population_top', agentDescription: '新しい説明' });
  });

  it('正常: グラフを変えないターンでも、説明を変えたなら取り消せる', () => {
    useToolBuilderStore.getState().setMetadata('agentDescription', '古い説明');
    const before = currentGraph();
    const id = exchange('説明だけ直して', { message: '直しました。', changes: [], agentTool: { description: '新しい説明' } });
    expect(turnAt(0).before).toBeDefined();

    useToolBuilderStore.getState().revertDesignChatTurn(id);
    expect(useToolBuilderStore.getState().metadata.agentDescription).toBe('古い説明');
    expect(currentGraph()).toEqual(before);
    expect(turnAt(0).reverted).toBe(true);
  });

  it('正常: 要約が返ると古いターンが消え、直近 4 ターンと覚え書きが残る', () => {
    talk(6);
    useToolBuilderStore.getState().startDesignChatCompact();
    useToolBuilderStore.getState().completeDesignChatCompact(2, '- 地域は引数にする / 全国は除く');
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat.turns.map((turn) => turn.user)).toEqual(['指示2', '指示3', '指示4', '指示5']);
    expect(designChat.summary).toBe('- 地域は引数にする / 全国は除く');
    expect(designChat).toMatchObject({ compacted: 2, compacting: false });
  });

  it('境界: 要約を待つ間は送信を止め、会話はまだ畳まない', () => {
    talk(5);
    useToolBuilderStore.getState().startDesignChatCompact();
    expect(useToolBuilderStore.getState().designChat).toMatchObject({ compacting: true });
    expect(useToolBuilderStore.getState().designChat.turns).toHaveLength(5);
  });

  it('正常: 2 回目の圧縮では覚え書きを置き換える（前回分は材料として渡してある）', () => {
    talk(6);
    useToolBuilderStore.getState().completeDesignChatCompact(2, '1 回目の覚え書き');
    talk(3, 6);
    useToolBuilderStore.getState().completeDesignChatCompact(3, '1 回目と 2 回目をまとめた覚え書き');
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat.summary).toBe('1 回目と 2 回目をまとめた覚え書き');
    expect(designChat.compacted).toBe(5);
    expect(designChat.turns).toHaveLength(4);
  });

  it('異常: 要約できなければ会話も覚え書きも変えず、理由だけ出す', () => {
    talk(5);
    useToolBuilderStore.getState().startDesignChatCompact();
    useToolBuilderStore.getState().failDesignChatCompact('model is not configured');
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat.turns).toHaveLength(5);
    expect(designChat.summary).toBeUndefined();
    expect(designChat).toMatchObject({ compacting: false, error: 'model is not configured' });
  });

  it('例外: 会話が消えた後に届いた要約では、残った会話の先頭を削らない', () => {
    talk(5);
    useToolBuilderStore.getState().startDesignChatCompact();
    useToolBuilderStore.getState().reset();
    useToolBuilderStore.getState().completeDesignChatCompact(1, '覚え書き');
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat.turns).toEqual([]);
    expect(designChat.summary).toBeUndefined();
  });

  it('正常: クリアで会話・覚え書き・消費が消え、キャンバスと開閉はそのまま', () => {
    useToolBuilderStore.getState().setDesignChatOpen(true);
    exchange('多い順に並べて', { ...sortResult, usage: { promptTokens: 6812, contextWindow: 200192 } });
    useToolBuilderStore.getState().completeDesignChatCompact(1, '覚え書き');
    const graph = currentGraph();

    useToolBuilderStore.getState().clearDesignChat();
    const { designChat } = useToolBuilderStore.getState();
    expect(designChat).toMatchObject({ turns: [], compacted: 0, open: true });
    expect(designChat.summary).toBeUndefined();
    expect(designChat.usage).toBeUndefined();
    // 会話は下書きだが、会話で作ったキャンバスは資産なので消さない。
    expect(currentGraph()).toEqual(graph);
  });
});

describe('designChatTranscript', () => {
  function turns(count: number): DesignChatTurn[] {
    return Array.from({ length: count }, (_value, index) => ({
      id: `t${index}`, user: `u${index}`, assistant: `a${index}`, changes: [], reverted: false, problems: [], warnings: [],
    }));
  }

  it('正常: role と content だけを古い順で送る（変更一覧は送らない）', () => {
    expect(designChatTranscript(turns(2))).toEqual([
      { role: 'user', content: 'u0' }, { role: 'assistant', content: 'a0' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
    ]);
  });

  it('境界: 直近 12 ターンに切り、古いものから捨てる', () => {
    const transcript = designChatTranscript(turns(7));
    expect(transcript).toHaveLength(12);
    expect(transcript[0]).toEqual({ role: 'user', content: 'u1' });
    expect(transcript.at(-1)).toEqual({ role: 'assistant', content: 'a6' });
  });

  it('異常: 返答がまだ無いターンは指示だけを送る', () => {
    const first = turns(1)[0] as DesignChatTurn;
    expect(designChatTranscript([{ ...first, assistant: undefined }])).toEqual([{ role: 'user', content: 'u0' }]);
  });
});

/**
 * 自動生成したツールの配置（v51）。どの自動経路も横一列に並べていたため、
 * 10 ノードのツールが幅 2,740px × 高さ 80px になった。折り返して並べ、人が並べた位置は動かさない。
 */
describe('自動配置（段組み＋折り返し）', () => {
  const tenant = { tenantId: 't', workspaceId: 'w' };
  /** n0 → n1 → … の直線グラフ（位置は付けない）。 */
  function chainGraph(count: number): ToolGraphDto {
    const nodes = Array.from({ length: count }, (_value, index) => ({ id: `n${index}`, type: 'select', config: { columns: [] } }));
    return { nodes, edges: nodes.slice(1).map((node, index) => ({ from: `n${index}`, to: node.id })) };
  }
  function toolWith(graph: ToolGraphDto): SerializedToolDto {
    return {
      metadata: { internalId: 'wide', workingName: 'w', displayName: 'W', publishName: 'w', version: '1.0.0', owner: 'o', state: 'draft', tenant },
      sideEffect: 'read-only', graph,
    } as SerializedToolDto;
  }
  const positions = () => useToolBuilderStore.getState().nodes.map((node) => node.position);
  const maxX = () => Math.max(...positions().map((position) => position.x));
  /** 4 列（80 / 360 / 640 / 920）で折り返し、帯は 200px ずつ下がる。 */
  const wrappedChain6 = [
    { x: 80, y: 120 }, { x: 360, y: 120 }, { x: 640, y: 120 }, { x: 920, y: 120 },
    { x: 80, y: 320 }, { x: 360, y: 320 },
  ];

  beforeEach(() => useToolBuilderStore.getState().reset());

  it('正常: テンプレートから作成すると、引数の帯の下で処理の列が 4 列で折り返す', () => {
    const graph = chainGraph(6);
    useToolBuilderStore.getState().loadTemplate({
      template: { id: 'long', version: '1.0.0' },
      graph: { nodes: [{ id: 'args', type: 'agent-input', config: {} }, ...graph.nodes], edges: graph.edges },
      agentTool: { name: 'long', description: 'd' },
      pendingExpressions: [],
    }, 'x');
    const [args, ...flow] = positions();
    expect(args).toEqual({ x: 80, y: 120 });
    expect(flow).toEqual(wrappedChain6.map((position) => ({ x: position.x, y: position.y + 200 })));
  });

  it('正常: 全ノードが位置を持たない保存済みツールは折り返して並ぶ', () => {
    useToolBuilderStore.getState().loadTool(toolWith(chainGraph(6)));
    expect(positions()).toEqual(wrappedChain6);
  });

  it('従来どおり: 位置を持つ保存済みツールは、横に長くても人が並べた位置のまま開く', () => {
    const graph = chainGraph(6);
    const placed = { ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, position: { x: 80 + index * 280, y: 120 } })) };
    useToolBuilderStore.getState().loadTool(toolWith(placed));
    expect(maxX()).toBe(80 + 5 * 280);
  });

  it('正常: 空のキャンバスへの設計アシスタントの適用は、返ったグラフ全体を折り返して並べる', () => {
    useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: 'source-1' }, { type: 'remove', id: 'filter-1' }]);
    const revision = useToolBuilderStore.getState().layoutRevision;
    const id = useToolBuilderStore.getState().startDesignChatTurn('人口の推移を作って');
    useToolBuilderStore.getState().completeDesignChatTurn(id, { message: '作りました。', graph: chainGraph(6), changes: [] });
    expect(positions()).toEqual(wrappedChain6);
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision + 1);
  });

  it('従来どおり: 既存のキャンバスへの追加では既存ノードを動かさず、新しいノードは上流の右へ置く', () => {
    const id = useToolBuilderStore.getState().startDesignChatTurn('並べ替えて');
    useToolBuilderStore.getState().completeDesignChatTurn(id, {
      message: '足しました。',
      graph: {
        nodes: [
          { id: 'source-1', type: 'json-source', config: { rows: [] }, position: { x: 80, y: 120 } },
          { id: 'filter-1', type: 'filter', config: {}, position: { x: 390, y: 120 } },
          { id: 'sort-1', type: 'sort', config: {} },
        ],
        edges: [{ from: 'source-1', to: 'filter-1' }, { from: 'filter-1', to: 'sort-1' }],
      },
      changes: [],
    });
    expect(positions()).toEqual([{ x: 80, y: 120 }, { x: 390, y: 120 }, { x: 610, y: 120 }]);
  });

  it('正常: 既存のキャンバスで右端を越える追加は、最下端の下の新しい帯の左端へ送る', () => {
    const graph = chainGraph(2);
    useToolBuilderStore.getState().loadTool(toolWith({
      ...graph, nodes: [{ ...graph.nodes[0]!, position: { x: 80, y: 120 } }, { ...graph.nodes[1]!, position: { x: 1120, y: 120 } }],
    }));
    const revision = useToolBuilderStore.getState().layoutRevision;
    const id = useToolBuilderStore.getState().startDesignChatTurn('10 件に絞って');
    useToolBuilderStore.getState().completeDesignChatTurn(id, {
      message: '絞りました。',
      graph: {
        nodes: [...graph.nodes, { id: 'limit-1', type: 'limit', config: { count: 10 } }],
        edges: [...graph.edges, { from: 'n1', to: 'limit-1' }],
      },
      changes: [],
    });
    expect(positions()).toEqual([{ x: 80, y: 120 }, { x: 1120, y: 120 }, { x: 80, y: 320 }]);
    // 足しただけなので全体を見せ直す合図は出さない（ノード数の変化で画面が追う）。
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision);
  });

  it('正常: 整列は人が並べた位置も含めて並べ直し、元に戻すで整列前の位置へ戻る', () => {
    const graph = chainGraph(6);
    const row = graph.nodes.map((_node, index) => ({ x: 80 + index * 280, y: 120 }));
    useToolBuilderStore.getState().loadTool(toolWith({ ...graph, nodes: graph.nodes.map((node, index) => ({ ...node, position: row[index] })) }));
    const revision = useToolBuilderStore.getState().layoutRevision;

    useToolBuilderStore.getState().arrangeNodes();
    expect(positions()).toEqual(wrappedChain6);
    expect(useToolBuilderStore.getState().arrangeUndo).toBeDefined();
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision + 1);

    useToolBuilderStore.getState().undoArrange();
    expect(positions()).toEqual(row);
    expect(useToolBuilderStore.getState().arrangeUndo).toBeUndefined();
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision + 2);
  });

  it('正常: 整列は画面が渡した列数で折り返す', () => {
    useToolBuilderStore.getState().loadTool(toolWith(chainGraph(6)));
    useToolBuilderStore.getState().arrangeNodes(6);
    expect(new Set(positions().map((position) => position.y))).toEqual(new Set([120]));
    expect(maxX()).toBe(80 + 5 * 280);
  });

  it('境界: 元に戻すは 1 段だけで、2 度目は何も変えない', () => {
    useToolBuilderStore.getState().arrangeNodes();
    useToolBuilderStore.getState().undoArrange();
    const once = positions();
    const revision = useToolBuilderStore.getState().layoutRevision;
    useToolBuilderStore.getState().undoArrange();
    expect(positions()).toEqual(once);
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision);
  });

  it('境界: 次の編集で元に戻すが消え、選択だけでは消えない', () => {
    const edits = [
      () => useToolBuilderStore.getState().onNodesChange([{ type: 'position', id: 'filter-1', position: { x: 5, y: 5 } }]),
      () => useToolBuilderStore.getState().addNode('select'),
      () => useToolBuilderStore.getState().updateNodeConfig('filter-1', { column: 'age', op: 'gte', value: 20 }),
      () => useToolBuilderStore.getState().onConnect({ source: 'source-1', target: 'filter-1', sourceHandle: null, targetHandle: null }),
      () => useToolBuilderStore.getState().onEdgesChange([{ type: 'remove', id: 'source-1-filter-1' }]),
      () => useToolBuilderStore.getState().loadTool(toolWith(chainGraph(2))),
    ];
    for (const edit of edits) {
      useToolBuilderStore.getState().reset();
      useToolBuilderStore.getState().arrangeNodes();
      useToolBuilderStore.getState().selectNode('source-1');
      useToolBuilderStore.getState().onNodesChange([{ type: 'select', id: 'source-1', selected: true }]);
      expect(useToolBuilderStore.getState().arrangeUndo).toBeDefined();
      edit();
      expect(useToolBuilderStore.getState().arrangeUndo).toBeUndefined();
    }
  });

  it('境界: 整列は位置だけの変更なので、検証待ちにも保存失敗の消去にもしない', () => {
    useToolBuilderStore.getState().setPropagation(okPropagation);
    useToolBuilderStore.getState().setSaveError('failed');
    useToolBuilderStore.getState().arrangeNodes();
    expect(useToolBuilderStore.getState()).toMatchObject({ propagationPending: false, saveError: 'failed' });
  });

  it('異常: 空のキャンバスでは整列しても何も起きず、元に戻すも出ない', () => {
    useToolBuilderStore.getState().onNodesChange([{ type: 'remove', id: 'source-1' }, { type: 'remove', id: 'filter-1' }]);
    const revision = useToolBuilderStore.getState().layoutRevision;
    useToolBuilderStore.getState().arrangeNodes();
    expect(useToolBuilderStore.getState().arrangeUndo).toBeUndefined();
    expect(useToolBuilderStore.getState().layoutRevision).toBe(revision);
  });
});
