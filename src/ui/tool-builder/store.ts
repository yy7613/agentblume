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
  SaveToolDto,
  SchemaDto,
  SerializedToolDto,
  SideEffectDto,
  ToolDiagnosticsDto,
  ToolGraphDto,
} from '../api/types';
import { catalogItem, inputHandleId, toInputOf, type ToolNodeType } from './node-catalog';
import { scope } from '../scope';

export interface ToolNodeData extends Record<string, unknown> {
  readonly nodeType: ToolNodeType;
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
}
export type ToolFlowNode = Node<ToolNodeData, 'tool'>;

/** キャンバス座標（React Flow の XYPosition と同形）。 */
interface CanvasPosition { readonly x: number; readonly y: number }

export interface ToolMetadataState {
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
  /**
   * グラフや設定が変わってから、検証結果（propagation か draftIssue）が届くまで true。
   * 自動プレビューは300msデバウンスするので、その待ち時間も「検証中」として保存を止めるために持つ。
   */
  propagationPending: boolean;
  /** 自動プレビュー（スキーマ推論／プレビュー）の失敗。草案の状態なのでプレビュー領域へ出す。 */
  draftIssue?: string;
  /** 「呼び出し診断」（Tool下書きのプリフライト診断）。'loading' は要求中、failed は取得失敗（診断結果そのものではない）。 */
  diagnostics?: ToolDiagnosticsDto | 'loading' | { readonly failed: string };
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
  setDiagnostics(diagnostics?: ToolDiagnosticsDto | 'loading' | { readonly failed: string }): void;
  setSaveError(saveError?: string): void;
  setSavedVersion(version: string, versions: readonly string[]): void;
  setVersions(versions: readonly string[]): void;
  loadTool(tool: SerializedToolDto): void;
  applyDraft(draft: ToolBuilderDraft): void;
  reset(): void;
}

/** localStorageへ退避する編集内容（保存対象のメタデータとグラフだけ）。 */
export interface ToolBuilderDraft {
  readonly metadata: ToolMetadataState;
  readonly nodes: readonly ToolFlowNode[];
  readonly edges: readonly Edge[];
}

/** 現在の編集内容を下書き用に切り出す。 */
export function toolBuilderDraft(state: Pick<ToolBuilderState, 'metadata' | 'nodes' | 'edges'>): ToolBuilderDraft {
  return { metadata: state.metadata, nodes: state.nodes, edges: state.edges };
}

/** 保存APIが非空を要求するメタデータ（api層 saveToolBodySchema の min(1) と対応）。 */
export const REQUIRED_METADATA_KEYS = ['internalId', 'workingName', 'displayName', 'publishName', 'owner'] as const;
export type RequiredMetadataKey = (typeof REQUIRED_METADATA_KEYS)[number];

/** 未入力の必須メタデータ。保存ボタンのdisabled判定と理由表示に使う。 */
export function missingRequiredMetadata(metadata: ToolMetadataState): readonly RequiredMetadataKey[] {
  return REQUIRED_METADATA_KEYS.filter((key) => metadata[key].trim() === '');
}

/** モデルへ公開できる function 名の形（domain/tool の AgentToolContract と同じ制約）。 */
export const FUNCTION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 保存ペイロードの agentTool。名前と説明の両方が入っているときだけ載せる（片方だけではサーバーが400にする）。
 * 載せないときはサーバーが publishName を function 名として公開する。
 */
export function agentToolOf(metadata: ToolMetadataState): { readonly name: string; readonly description: string } | undefined {
  return metadata.agentName.trim() !== '' && metadata.agentDescription.trim() !== ''
    ? { name: metadata.agentName, description: metadata.agentDescription }
    : undefined;
}

/** モデルに実際に見える function 名。agentTool があればその名前、なければ publishName。 */
export function effectiveFunctionName(metadata: ToolMetadataState): string {
  return agentToolOf(metadata)?.name ?? metadata.publishName;
}

/**
 * agent-input ノードが宣言する引数スキーマ。
 * 複数の agent-input が違うスキーマを宣言していると、保存は先頭だけを inputSchema にして通ってしまい、
 * 実行時に別のノードで「inputSchema と一致しない」と落ちる。ここで衝突として検出して保存を止める。
 */
export function declaredInputSchema(nodes: readonly ToolFlowNode[]): { readonly schema?: SchemaDto; readonly conflict: boolean } {
  const schemas = nodes
    .filter((node) => node.data.nodeType === 'agent-input')
    .map((node) => (node.data.config as { schema?: SchemaDto })['schema']);
  const first = schemas[0];
  if (first === undefined) return { conflict: false };
  const signature = JSON.stringify(first.columns);
  const conflict = schemas.some((schema) => JSON.stringify(schema?.columns) !== signature);
  return { schema: first, conflict };
}

/** 保存を止める理由（優先順）。undefined なら保存できる。文言は画面側が付ける。 */
export type SaveBlocker =
  | { readonly kind: 'missing-metadata'; readonly keys: readonly RequiredMetadataKey[] }
  | { readonly kind: 'invalid-function-name'; readonly name: string }
  | { readonly kind: 'agent-input-conflict' }
  | { readonly kind: 'validation-pending' }
  | { readonly kind: 'graph-errors' };

/**
 * 保存前ガード。以前は必須メタデータだけで保存を許していたため、function 名が無効なツール・
 * 引数が食い違うツール・出力スキーマの無いツールが保存でき、エージェント実行時に初めて壊れた。
 */
export function saveBlocker(state: Pick<ToolBuilderState, 'metadata' | 'nodes' | 'propagation' | 'previewLoading' | 'draftIssue' | 'propagationPending'>): SaveBlocker | undefined {
  const keys = missingRequiredMetadata(state.metadata);
  if (keys.length > 0) return { kind: 'missing-metadata', keys };
  const name = effectiveFunctionName(state.metadata);
  if (!FUNCTION_NAME_PATTERN.test(name)) return { kind: 'invalid-function-name', name };
  if (declaredInputSchema(state.nodes).conflict) return { kind: 'agent-input-conflict' };
  // 設定未完了（自動検証がサーバーへ送る前に止めた）や検証APIの失敗も、出力スキーマを確定できないので保存しない。
  if (state.draftIssue !== undefined) return { kind: 'graph-errors' };
  if (state.propagationPending || state.previewLoading || state.propagation === undefined) return { kind: 'validation-pending' };
  if (state.propagation.hasErrors) return { kind: 'graph-errors' };
  return undefined;
}

/**
 * 保存 API と下書き診断 API へ送る DTO の唯一の組み立て口（両者が別々に組むと検査対象がずれる）。
 * outputSchema は終端ノード（terminalId）の推論結果。order.at(-1) は未接続 agent-input でありうるので使わない。
 */
export function buildSaveDto(state: Pick<ToolBuilderState, 'metadata' | 'nodes' | 'edges' | 'propagation'> = useToolBuilderStore.getState()): SaveToolDto {
  const { metadata } = state;
  const agentTool = agentToolOf(metadata);
  const inputSchema = declaredInputSchema(state.nodes).schema;
  const outputSchema = state.propagation === undefined ? undefined : state.propagation.nodes[state.propagation.terminalId]?.schema;
  return {
    scope,
    internalId: metadata.internalId,
    workingName: metadata.workingName,
    displayName: metadata.displayName,
    publishName: metadata.publishName,
    owner: metadata.owner,
    sideEffect: metadata.sideEffect,
    graph: flowToGraph(state.nodes, state.edges),
    ...(agentTool === undefined ? {} : { agentTool }),
    ...(inputSchema === undefined ? {} : { inputSchema }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}

/**
 * セッションへ成果物を書き込む終端（workspace-output / graph-output / chart-output、または
 * agent-output の overflow=store-and-reference）を持つか。サーバー（application/tool/save-tool.ts の
 * hasSessionStorageSink）と同じ集合で、read-only のままだと保存が400になるため sideEffect を自動で上げる。
 */
export function requiresSessionWrite(nodes: readonly ToolFlowNode[]): boolean {
  return nodes.some((node) =>
    node.data.nodeType === 'workspace-output' || node.data.nodeType === 'graph-output' || node.data.nodeType === 'chart-output'
    || (node.data.nodeType === 'agent-output' && node.data.config['overflow'] === 'store-and-reference'));
}

/** read-only のままではサーバーが拒否するグラフなら session-write へ上げたメタデータを返す。 */
function bumpSideEffect(metadata: ToolMetadataState, nodes: readonly ToolFlowNode[]): { readonly metadata: ToolMetadataState } | Record<never, never> {
  return metadata.sideEffect === 'read-only' && requiresSessionWrite(nodes)
    ? { metadata: { ...metadata, sideEffect: 'session-write' as const } }
    : {};
}

/**
 * 保存失敗は「次の保存試行の開始時」と「保存内容が変わったとき」だけ消す。
 * 自動プレビューが上書きしないので、ユーザーはメッセージを読み切れる。
 */
const clearSaveError = { saveError: undefined } as const;
/** 保存内容が変わった: 検証結果が届くまで保存を待たせる。 */
const markPending = { propagationPending: true } as const;

/**
 * 選択・移動だけの変更では保存失敗メッセージを消さない。
 * positionは保存対象だが、ドラッグでは保存が失敗した原因（設定不備・重複ID等）は解消しないので、
 * ユーザーがメッセージを読み切れるよう残す。
 */
function changesSavePayload(changes: readonly NodeChange<ToolFlowNode>[]): boolean {
  return changes.some((change) => change.type === 'add' || change.type === 'remove' || change.type === 'replace');
}

const initialMetadata: ToolMetadataState = {
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
    propagationPending: true,
    draftIssue: undefined,
    diagnostics: undefined,
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
    ...(key === 'internalId' ? { currentVersion: undefined, versions: [] } : {}),
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
    const nodes = [...state.nodes, node];
    return {
      nodes, edges: [...state.edges, ...edge], selectedNodeId: id,
      ...clearSaveError, ...markPending,
      ...bumpSideEffect(state.metadata, nodes),
    };
  }),
  onNodesChange: (changes) => set((state) => ({
    nodes: applyNodeChanges(changes, state.nodes),
    ...(changesSavePayload(changes) ? { ...clearSaveError, ...markPending } : {}),
  })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges), ...clearSaveError, ...markPending })),
  onConnect: (connection) => set((state) => ({ edges: addEdge(connection, state.edges), ...clearSaveError, ...markPending })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  updateNodeConfig: (nodeId, config) => set((state) => {
    const nodes = state.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, config } } : node);
    // agent-output の overflow を store-and-reference へ変えた場合もセッション書き込みになる。
    return { nodes, ...clearSaveError, ...markPending, ...bumpSideEffect(state.metadata, nodes) };
  }),
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  // 検証結果が届いた（undefined でも失敗として届いたと見なし、続く setDraftIssue が理由を持つ）。
  setPropagation: (propagation) => set({ propagation, propagationPending: false }),
  setPreview: (preview) => set({ preview }),
  // 理由付きの失敗も「検証が終わった」印。undefined（要求開始時のクリア）では pending を触らない。
  setDraftIssue: (draftIssue) => set(draftIssue === undefined ? { draftIssue } : { draftIssue, propagationPending: false }),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setSaveError: (saveError) => set({ saveError }),
  setSavedVersion: (currentVersion, versions) => set({ currentVersion, versions }),
  setVersions: (versions) => set({ versions }),
  loadTool: (tool) => set((state) => {
    const positions = loadedPositions(tool.graph.nodes);
    return {
      metadata: {
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
      propagationPending: true,
      preview: undefined,
      draftIssue: undefined,
      diagnostics: undefined,
      saveError: undefined,
      versions: state.versions,
    };
  }),
  // 復元した下書きを丸ごと反映する。派生状態（推論結果・プレビュー・エラー）は破棄して自動プレビューに再計算させる。
  applyDraft: (draft) => set({
    metadata: { ...draft.metadata },
    nodes: draft.nodes.map((node) => ({ ...node, data: { ...node.data } })),
    edges: draft.edges.map((edge) => ({ ...edge })),
    selectedNodeId: draft.nodes[0]?.id,
    propagation: undefined,
    propagationPending: true,
    preview: undefined,
    draftIssue: undefined,
    diagnostics: undefined,
    saveError: undefined,
  }),
  reset: () => set(initialState()),
}));

export function currentGraph(): ToolGraphDto {
  const { nodes, edges } = useToolBuilderStore.getState();
  return flowToGraph(nodes, edges);
}
