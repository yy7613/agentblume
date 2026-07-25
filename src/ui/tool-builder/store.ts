import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { create } from 'zustand';
import type {
  GraphNodeDto,
  PreviewResultDto,
  PropagationResultDto,
  SerializedToolDto,
  SideEffectDto,
  ToolGraphDto,
} from '../api/types';
import { catalogItem, inputHandleId, toInputOf, type ToolNodeType } from './node-catalog';

export interface ToolNodeData extends Record<string, unknown> {
  readonly nodeType: ToolNodeType;
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
}
export type ToolFlowNode = Node<ToolNodeData, 'tool'>;

/** キャンバス座標（React Flow の XYPosition と同形）。 */
interface CanvasPosition { readonly x: number; readonly y: number }

export interface ToolMetadataState {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly agentName: string;
  readonly agentDescription: string;
  readonly owner: string;
  readonly sideEffect: SideEffectDto;
}

interface ToolBuilderState {
  metadata: ToolMetadataState;
  nodes: ToolFlowNode[];
  edges: Edge[];
  selectedNodeId?: string;
  propagation?: PropagationResultDto;
  preview?: PreviewResultDto;
  previewLoading: boolean;
  /** 自動プレビュー（スキーマ推論／プレビュー）の失敗。草案の状態なのでプレビュー領域へ出す。 */
  draftIssue?: string;
  /** 明示保存・バージョン操作の失敗。操作の近傍（保存ボタン直下）へ出す。 */
  saveError?: string;
  currentVersion?: string;
  versions: readonly string[];
  setMetadata<K extends keyof ToolMetadataState>(key: K, value: ToolMetadataState[K]): void;
  addNode(type: ToolNodeType): void;
  onNodesChange(changes: NodeChange<ToolFlowNode>[]): void;
  onEdgesChange(changes: EdgeChange[]): void;
  onConnect(connection: Connection): void;
  selectNode(nodeId?: string): void;
  updateNodeConfig(nodeId: string, config: Readonly<Record<string, unknown>>): void;
  setPreviewLoading(loading: boolean): void;
  setPropagation(propagation?: PropagationResultDto): void;
  setPreview(preview?: PreviewResultDto): void;
  setDraftIssue(draftIssue?: string): void;
  setSaveError(saveError?: string): void;
  setSavedVersion(version: string, versions: readonly string[]): void;
  setVersions(versions: readonly string[]): void;
  loadTool(tool: SerializedToolDto): void;
  reset(): void;
}

/** 保存APIが非空を要求するメタデータ（api層 saveToolBodySchema の min(1) と対応）。 */
export const REQUIRED_METADATA_KEYS = ['internalId', 'workingName', 'displayName', 'publishName', 'owner'] as const;
export type RequiredMetadataKey = (typeof REQUIRED_METADATA_KEYS)[number];

/** 未入力の必須メタデータ。保存ボタンのdisabled判定と理由表示に使う。 */
export function missingRequiredMetadata(metadata: ToolMetadataState): readonly RequiredMetadataKey[] {
  return REQUIRED_METADATA_KEYS.filter((key) => metadata[key].trim() === '');
}

/**
 * 保存失敗は「次の保存試行の開始時」と「保存内容が変わったとき」だけ消す。
 * 自動プレビューが上書きしないので、ユーザーはメッセージを読み切れる。
 */
const clearSaveError = { saveError: undefined } as const;

/**
 * 選択・移動だけの変更では保存失敗メッセージを消さない。
 * positionは保存対象だが、ドラッグでは保存が失敗した原因（設定不備・重複ID等）は解消しないので、
 * ユーザーがメッセージを読み切れるよう残す。
 */
function changesSavePayload(changes: readonly NodeChange<ToolFlowNode>[]): boolean {
  return changes.some((change) => change.type === 'add' || change.type === 'remove' || change.type === 'replace');
}

const initialMetadata: ToolMetadataState = {
  tenantId: 'local',
  workspaceId: 'default',
  internalId: '',
  workingName: '',
  displayName: '',
  publishName: '',
  agentName: '',
  agentDescription: '',
  owner: '',
  sideEffect: 'read-only',
};

/** 先頭列の起点。starterグラフと、選択が無いときのパレット追加の基準点。 */
const ORIGIN: CanvasPosition = { x: 80, y: 120 };
/** 配置間隔（min-width 170px のノードが重ならず、ハンドルのドラッグ接続が届く距離）。 */
const PLACEMENT_STEP_X = 280;
const PLACEMENT_STEP_Y = 140;
/** これより近い既存ノードがあれば「重なっている」と判定する箱のサイズ。 */
const NODE_FOOTPRINT_X = 200;
const NODE_FOOTPRINT_Y = 110;
/** 空き探索の幅。24×24=576スロットあり、graphSchemaのノード上限200でも空きが残る。 */
const PLACEMENT_SCAN = 24;

function starterNodes(): ToolFlowNode[] {
  return [
    makeNode('source-1', 'json-source', ORIGIN),
    makeNode('filter-1', 'filter', { x: 390, y: ORIGIN.y }, { column: 'age', op: 'gte', value: 18 }),
  ];
}

/**
 * 既存ノードIDと衝突しない `type-連番` を返す。
 *
 * starterグラフの固定ID（`source-1` / `filter-1`）や読み込んだToolのIDと重なる番号は飛ばす。
 * これによりReact keyの重複（ノードが画面から消える）と保存時の `duplicate node id` を防ぐ。
 */
function uniqueNodeId(type: ToolNodeType, nodes: readonly ToolFlowNode[]): string {
  const taken = new Set(nodes.map((node) => node.id));
  let counter = 1;
  while (taken.has(`${type}-${counter}`)) counter += 1;
  return `${type}-${counter}`;
}

/** 既存の配置と視覚的に重なるか。 */
function occupied(positions: readonly CanvasPosition[], position: CanvasPosition): boolean {
  return positions.some((placed) =>
    Math.abs(placed.x - position.x) < NODE_FOOTPRINT_X && Math.abs(placed.y - position.y) < NODE_FOOTPRINT_Y);
}

/** 希望位置が占有済みなら下方向へ、列が埋まっていれば右列へずらして空き位置を返す。 */
function freePosition(positions: readonly CanvasPosition[], desired: CanvasPosition): CanvasPosition {
  for (let column = 0; column < PLACEMENT_SCAN; column += 1) {
    for (let row = 0; row < PLACEMENT_SCAN; row += 1) {
      const candidate = { x: desired.x + column * PLACEMENT_STEP_X, y: desired.y + row * PLACEMENT_STEP_Y };
      if (!occupied(positions, candidate)) return candidate;
    }
  }
  return desired;
}

/**
 * 保存済みDTOの配置を復元する。
 * `position` があればそれを使い、無いノード（position導入前の保存データ）は
 * 従来の自動グリッドへ退避する（復元済みの配置と重なる場合はずらす）。
 */
function loadedPositions(graphNodes: readonly GraphNodeDto[]): CanvasPosition[] {
  const saved = graphNodes.map((node) => node.position === undefined ? undefined : { x: node.position.x, y: node.position.y });
  const placed: CanvasPosition[] = saved.filter((position): position is CanvasPosition => position !== undefined);
  return saved.map((position, index) => {
    if (position !== undefined) return position;
    const fallback = freePosition(placed, { x: ORIGIN.x + index * PLACEMENT_STEP_X, y: ORIGIN.y });
    placed.push(fallback);
    return fallback;
  });
}

function makeNode(
  id: string,
  type: ToolNodeType,
  position: CanvasPosition,
  config?: Readonly<Record<string, unknown>>,
): ToolFlowNode {
  const item = catalogItem(type);
  return {
    id,
    type: 'tool',
    position,
    data: { nodeType: type, label: item.label, config: config ?? structuredClone(item.defaultConfig) },
  };
}

function initialState() {
  return {
    metadata: initialMetadata,
    nodes: starterNodes(),
    edges: [{ id: 'source-1-filter-1', source: 'source-1', target: 'filter-1' }],
    selectedNodeId: 'filter-1' as string | undefined,
    propagation: undefined,
    preview: undefined,
    previewLoading: false,
    draftIssue: undefined,
    saveError: undefined,
    currentVersion: undefined,
    versions: [] as readonly string[],
  };
}

export function flowToGraph(nodes: readonly ToolFlowNode[], edges: readonly Edge[]): ToolGraphDto {
  return {
    // positionも書き出して、手動整列が保存→再読込で失われないようにする（実行には影響しない）。
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      config: node.data.config,
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
    })),
    edges: edges.map((edge) => {
      const toInput = toInputOf(edge.targetHandle);
      return toInput === undefined
        ? { from: edge.source, to: edge.target }
        : { from: edge.source, to: edge.target, toInput };
    }),
  };
}

export const useToolBuilderStore = create<ToolBuilderState>((set, get) => ({
  ...initialState(),
  setMetadata: (key, value) => set((state) => ({
    metadata: { ...state.metadata, [key]: value },
    ...clearSaveError,
    ...(['tenantId', 'workspaceId', 'internalId'].includes(key) ? { currentVersion: undefined, versions: [] } : {}),
  })),
  addNode: (type) => set((state) => {
    const id = uniqueNodeId(type, state.nodes);
    const selected = state.nodes.find((node) => node.id === state.selectedNodeId);
    // 選択ノードの右隣（+280）を基本に、占有済みなら空きへずらす。未選択なら先頭列から探す。
    const position = freePosition(
      state.nodes.map((node) => node.position),
      selected === undefined ? ORIGIN : { x: selected.position.x + PLACEMENT_STEP_X, y: selected.position.y },
    );
    const item = catalogItem(type);
    const upstreamColumns = selected === undefined ? [] : (state.propagation?.nodes[selected.id]?.schema.columns ?? []);
    const initialConfig = type === 'graph-output' && upstreamColumns.length >= 2
      ? { ...structuredClone(item.defaultConfig), graph: { sourceColumn: upstreamColumns[0]?.name, targetColumn: upstreamColumns[1]?.name } }
      : undefined;
    const node = makeNode(id, type, position, initialConfig);
    // 2入力ノードは選択ノードを左（toInput:0）へ自動接続し、右（toInput:1）は手動接続に任せる。
    const edge = item.kind !== 'source' && selected !== undefined && catalogItem(selected.data.nodeType).kind !== 'sink'
      ? [{
          id: `${selected.id}-${id}`,
          source: selected.id,
          target: id,
          ...(item.inputArity === 2 ? { targetHandle: inputHandleId(0) } : {}),
        }]
      : [];
    return {
      nodes: [...state.nodes, node], edges: [...state.edges, ...edge], selectedNodeId: id,
      ...clearSaveError,
      ...((type === 'workspace-output' || type === 'graph-output') && state.metadata.sideEffect === 'read-only' ? { metadata: { ...state.metadata, sideEffect: 'session-write' as const } } : {}),
    };
  }),
  onNodesChange: (changes) => set((state) => ({
    nodes: applyNodeChanges(changes, state.nodes),
    ...(changesSavePayload(changes) ? clearSaveError : {}),
  })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges), ...clearSaveError })),
  onConnect: (connection) => set((state) => ({ edges: addEdge(connection, state.edges), ...clearSaveError })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  updateNodeConfig: (nodeId, config) => set((state) => ({
    nodes: state.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, config } } : node),
    ...clearSaveError,
  })),
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  setPropagation: (propagation) => set({ propagation }),
  setPreview: (preview) => set({ preview }),
  setDraftIssue: (draftIssue) => set({ draftIssue }),
  setSaveError: (saveError) => set({ saveError }),
  setSavedVersion: (currentVersion, versions) => set({ currentVersion, versions }),
  setVersions: (versions) => set({ versions }),
  loadTool: (tool) => set((state) => {
    const positions = loadedPositions(tool.graph.nodes);
    return {
      metadata: {
        tenantId: tool.metadata.tenant.tenantId,
        workspaceId: tool.metadata.tenant.workspaceId,
        internalId: tool.metadata.internalId,
        workingName: tool.metadata.workingName,
        displayName: tool.metadata.displayName,
        publishName: tool.metadata.publishName,
        agentName: tool.agentTool?.name ?? tool.metadata.publishName,
        agentDescription: tool.agentTool?.description ?? `${tool.metadata.displayName} (${tool.sideEffect})`,
        owner: tool.metadata.owner,
        sideEffect: tool.sideEffect,
      },
      nodes: tool.graph.nodes.map((node, index) => makeNode(
        node.id,
        node.type as ToolNodeType,
        positions[index] ?? ORIGIN,
        node.config as Readonly<Record<string, unknown>>,
      )),
      edges: tool.graph.edges.map((edge, index) => ({
        id: `${edge.from}-${edge.to}-${index}`,
        source: edge.from,
        target: edge.to,
        ...(edge.toInput === undefined ? {} : { targetHandle: inputHandleId(edge.toInput) }),
      })),
      selectedNodeId: tool.graph.nodes[0]?.id,
      currentVersion: tool.metadata.version,
      propagation: undefined,
      preview: undefined,
      draftIssue: undefined,
      saveError: undefined,
      versions: state.versions,
    };
  }),
  reset: () => set(initialState()),
}));

export function currentGraph(): ToolGraphDto {
  const { nodes, edges } = useToolBuilderStore.getState();
  return flowToGraph(nodes, edges);
}
