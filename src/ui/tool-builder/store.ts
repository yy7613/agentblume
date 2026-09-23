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
  DesignChatAgentToolDto,
  DesignChatChangeDto,
  DesignChatCompactTurnDto,
  DesignChatMessageDto,
  DesignChatResultDto,
  DesignChatUsageDto,
  InstantiatedTemplateDto,
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
import { designChatPositions, freePosition, layoutWrapped, loadedPositions, ORIGIN, PLACEMENT_STEP_X, type CanvasPosition } from './layout';

export interface ToolNodeData extends Record<string, unknown> {
  readonly nodeType: ToolNodeType;
  readonly label: string;
  readonly config: Readonly<Record<string, unknown>>;
}
export type ToolFlowNode = Node<ToolNodeData, 'tool'>;

/**
 * 設計アシスタント（v47 / ADR-0051）の 1 往復。
 *
 * `before` はこのターンを**適用する直前**のキャンバスで、「この変更を取り消す」の戻り先。
 * グラフを変えなかったターン（質問への回答・聞き返し・適用できなかった）には付かない。
 */
export interface DesignChatTurn {
  readonly id: string;
  readonly user: string;
  readonly assistant?: string;
  readonly changes: readonly DesignChatChangeDto[];
  readonly before?: {
    readonly nodes: readonly ToolFlowNode[];
    readonly edges: readonly Edge[];
    /** 適用前の Tool Calling 契約（v49）。説明文を変えたターンにだけ付き、取り消しで書き戻す。 */
    readonly agentTool?: { readonly name: string; readonly description: string };
  };
  readonly reverted: boolean;
  /** 適用できなかった理由（英語の原文）。画面が localizeDiagnosticDetail で日本語化して出す。 */
  readonly problems: readonly string[];
  /** 適用はしたが気を付けてほしい点（英語の原文。赤枠ではなく注記として出す）。 */
  readonly warnings: readonly string[];
}

export interface DesignChatState {
  readonly open: boolean;
  readonly turns: readonly DesignChatTurn[];
  readonly busy: boolean;
  readonly error?: string;
  /** 直近の変更で触れたノード。画面が数秒だけ強調し、clearDesignChatHighlight で消す。 */
  readonly highlight: readonly string[];
  /**
   * 畳んだ古いターンの覚え書き（v49）。モデルが書き、次の要求の `transcriptSummary` として送る。
   * 無いのは「まだ 1 度も圧縮していない」ことを意味する（空文字は作らない）。
   */
  readonly summary?: string;
  /** これまでに畳んだターン数。画面の「圧縮済み（N ターン）」に出す。 */
  readonly compacted: number;
  /** 要約を待っている。送信と圧縮を止め、「要約しています…」を出すために持つ。 */
  readonly compacting: boolean;
  /** 直前の応答のトークン消費（v49）。メーターの唯一の情報源で、画面は推定しない。 */
  readonly usage?: DesignChatUsageDto;
}

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
  /**
   * テンプレートから作成したとき、式が空の calculate ノードへ渡す「AIに式を書かせる」の初期指示文。
   * 関数電卓パネルが開いたときに**1 度だけ**消費する（消費後は消える）。
   */
  pendingCalculateIntent?: { readonly nodeId: string; readonly intent: string };
  /** 直近に展開したテンプレート（`id@version`）。作成後の通知に出す。 */
  createdFromTemplate?: string;
  /**
   * 設計アシスタントの会話（v47）。**下書き（ToolBuilderDraft）には入れない**（永続化しない）ので、
   * 別のツールを開く・新規作成・テンプレートから作成で消える。開閉だけは画面が localStorage に覚える。
   */
  designChat: DesignChatState;
  /**
   * 「整列」の直前の配置（v51）。「元に戻す」の戻り先で、1 段だけ持つ。
   * グラフの編集（ノードの移動・追加・削除、接続、設定、読み込み）で消え、画面の通知も一緒に消える。
   */
  arrangeUndo?: readonly { readonly id: string; readonly position: CanvasPosition }[];
  /**
   * 全体を並べ直した回数（v51）。画面はこれが変わったら fitView で全体を見せる。
   * ノード数が変わらない並べ替え（整列・元に戻す）でも見せ直すために、ノード数とは別に持つ。
   */
  layoutRevision: number;
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
  /** 実体化したテンプレートを新しい下書きとしてキャンバスへ展開する（v43）。 */
  loadTemplate(instantiated: InstantiatedTemplateDto, displayName: string): void;
  /** 関数電卓パネルが初期指示文を受け取る（同じノードで 1 度だけ返す）。 */
  consumePendingCalculateIntent(nodeId: string): string | undefined;
  /** 作成通知を閉じる。 */
  clearCreatedFromTemplate(): void;
  /** 設計アシスタントのパネルを開く／閉じる（localStorage への記憶は画面側）。 */
  setDesignChatOpen(open: boolean): void;
  /** 指示を送った。返したidで完了・失敗を差し戻す（遅れて届いた応答を別のターンへ混ぜない）。 */
  startDesignChatTurn(instruction: string): string;
  /** 応答を受け取った。`graph` があればキャンバスへ即座に適用し、変更したノードを強調・選択する。 */
  completeDesignChatTurn(turnId: string, result: DesignChatResultDto): void;
  /** 応答が受け取れなかった（通信・モデルの失敗）。キャンバスは変えない。 */
  failDesignChatTurn(turnId: string, error: string): void;
  /** そのターンの適用前のキャンバスへ戻す（以後のターンの変更も戻る）。 */
  revertDesignChatTurn(turnId: string): void;
  /** 強調表示を消す（画面が数秒後に呼ぶ）。 */
  clearDesignChatHighlight(): void;
  /** 要約を頼んだ（v49）。返るまで送信も次の圧縮も止める。 */
  startDesignChatCompact(): void;
  /** 要約が返った。古い `count` ターンを一覧から外し、要約を**置き換える**（前回分は材料に入っている）。 */
  completeDesignChatCompact(count: number, summary: string): void;
  /** 要約できなかった（v49）。会話は 1 文字も変えず、理由だけ出す。 */
  failDesignChatCompact(error: string): void;
  /** 会話・要約・消費を消す（v49）。キャンバスは変えない。 */
  clearDesignChat(): void;
  /** 全ノードを段組み＋折り返しで並べ直す（v51）。`maxColumns` は画面が表示幅から決める。 */
  arrangeNodes(maxColumns?: number): void;
  /** 直前の「整列」を取り消し、整列前の配置へ戻す（1 段だけ）。 */
  undoArrange(): void;
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

/** 保存APIが非空を要求するメタデータ（api層 saveToolBodySchema の min(1) と対応。ownerは v52 で入力必須から外れ、空ならサーバーがログイン中の利用者名で埋める）。 */
export const REQUIRED_METADATA_KEYS = ['internalId', 'workingName', 'displayName', 'publishName'] as const;
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
/** グラフを編集した: 「整列」の取り消しは 1 段だけなので、次の編集で戻り先を捨てる（v51）。 */
const dropArrangeUndo = { arrangeUndo: undefined } as const;

/** 人がノードを動かした・足した・消した（選択や寸法の計測は編集ではない）。 */
function editsNodes(changes: readonly NodeChange<ToolFlowNode>[]): boolean {
  return changes.some((change) => change.type === 'position' || change.type === 'add' || change.type === 'remove' || change.type === 'replace');
}

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

/** グラフDTOをキャンバスのノード・エッジへ。エッジidは重複しないよう添字を混ぜる（loadToolと同じ作法）。 */
function graphToFlow(graph: ToolGraphDto, positions: ReadonlyMap<string, CanvasPosition>): { readonly nodes: ToolFlowNode[]; readonly edges: Edge[] } {
  return {
    nodes: graph.nodes.map((node) => makeNode(
      node.id,
      node.type as ToolNodeType,
      positions.get(node.id) ?? ORIGIN,
      node.config as Readonly<Record<string, unknown>>,
    )),
    edges: graph.edges.map((edge, index) => ({
      id: `${edge.from}-${edge.to}-${index}`,
      source: edge.from,
      target: edge.to,
      ...(edge.toInput === undefined ? {} : { targetHandle: inputHandleId(edge.toInput) }),
    })),
  };
}

/** 会話のうちモデルへ送る上限（契約 §3）。古いものから捨てる。 */
export const DESIGN_CHAT_TRANSCRIPT_LIMIT = 12;

/** モデルへ送る会話（古い順、直近 12 件）。変更一覧は送らず、role と content だけにする。 */
export function designChatTranscript(turns: readonly DesignChatTurn[], limit = DESIGN_CHAT_TRANSCRIPT_LIMIT): readonly DesignChatMessageDto[] {
  const messages: DesignChatMessageDto[] = [];
  for (const turn of turns) {
    messages.push({ role: 'user', content: turn.user });
    if (turn.assistant !== undefined) messages.push({ role: 'assistant', content: turn.assistant });
  }
  return messages.slice(-limit);
}

/** 圧縮で原文のまま残す直近のターン数（契約 §5）。ここより古いターンをモデルが要約する。 */
export const DESIGN_CHAT_KEEP_TURNS = 4;
/** 圧縮ボタンが押せるようになるターン数（残す 4 ターンより多い＝畳む相手がいる）。 */
export const DESIGN_CHAT_COMPACT_MIN_TURNS = DESIGN_CHAT_KEEP_TURNS + 1;

/** 圧縮の材料にする古いターン（直近 4 ターンより前）。空なら畳む相手がいない。 */
export function designChatFoldableTurns(turns: readonly DesignChatTurn[]): readonly DesignChatTurn[] {
  return turns.slice(0, Math.max(0, turns.length - DESIGN_CHAT_KEEP_TURNS));
}

/**
 * 畳むターンを要約 API の材料へ移す（v49）。
 * 変更は `changes[].summary`（「何をしたか」の正確な記録）だけを渡し、op や nodeId は渡さない。
 */
export function designChatCompactTurns(turns: readonly DesignChatTurn[]): readonly DesignChatCompactTurnDto[] {
  return turns.map((turn) => ({
    user: turn.user,
    ...(turn.assistant === undefined ? {} : { assistant: turn.assistant }),
    changes: turn.changes.map((change) => change.summary),
  }));
}

/**
 * 設計アシスタントへ送る、いまの Tool Calling 契約（v49）。
 *
 * 保存用の `agentToolOf` と違い**片方だけでも送る**。説明文を直したいときに名前が未入力でも
 * 「いまの説明」をモデルに見せる必要があるため。両方空なら見せるものが無いので送らない。
 */
export function designChatAgentTool(metadata: ToolMetadataState): DesignChatAgentToolDto | undefined {
  return metadata.agentName.trim() === '' && metadata.agentDescription.trim() === ''
    ? undefined
    : { name: metadata.agentName, description: metadata.agentDescription };
}

/** 会話の初期値。`open` はパネルの開閉で、会話を消すときも引き継ぐ（消えたのは中身だけ）。 */
function emptyDesignChat(open: boolean): DesignChatState {
  return { open, turns: [], busy: false, error: undefined, highlight: [], summary: undefined, compacted: 0, compacting: false, usage: undefined };
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
    pendingCalculateIntent: undefined,
    createdFromTemplate: undefined,
    designChat: emptyDesignChat(false),
    arrangeUndo: undefined,
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
  // 初期状態（reset）には入れない: 戻すと「前と同じ値」になり、画面が全体を見せ直す合図を取りこぼしうる。
  layoutRevision: 0,
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
      ...clearSaveError, ...markPending, ...dropArrangeUndo,
      ...bumpSideEffect(state.metadata, nodes),
    };
  }),
  onNodesChange: (changes) => set((state) => ({
    nodes: applyNodeChanges(changes, state.nodes),
    ...(changesSavePayload(changes) ? { ...clearSaveError, ...markPending } : {}),
    ...(editsNodes(changes) ? dropArrangeUndo : {}),
  })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges), ...clearSaveError, ...markPending, ...dropArrangeUndo })),
  onConnect: (connection) => set((state) => ({ edges: addEdge(connection, state.edges), ...clearSaveError, ...markPending, ...dropArrangeUndo })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  updateNodeConfig: (nodeId, config) => set((state) => {
    const nodes = state.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, config } } : node);
    // agent-output の overflow を store-and-reference へ変えた場合もセッション書き込みになる。
    return { nodes, ...clearSaveError, ...markPending, ...dropArrangeUndo, ...bumpSideEffect(state.metadata, nodes) };
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
    // 全ノードが位置を持たない（Factory が生成した・position 導入前の）ツールは折り返して並べる（v51）。
    // 一部でも位置を持つなら人が並べたものなので動かさず、欠けたものだけ空き位置へ置く。
    const unplaced = tool.graph.nodes.every((node) => node.position === undefined);
    const positions = unplaced ? layoutWrapped(tool.graph.nodes, tool.graph.edges) : loadedPositions(tool.graph.nodes);
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
      // 会話は編集中のツールに紐づく。別のツールを開いたら捨てる（パネルの開閉だけ引き継ぐ）。
      designChat: emptyDesignChat(state.designChat.open),
      ...dropArrangeUndo,
      ...(unplaced ? { layoutRevision: state.layoutRevision + 1 } : {}),
    };
  }),
  /**
   * 実体化したテンプレートを**新しい下書き**として展開する（v43 / ADR-0049）。
   *
   * 保存済み Tool を開く `loadTool` と同じ状態（派生状態は破棄して自動プレビューに再計算させる）に
   * するが、版はまだ無いので `currentVersion` は付けない。メタデータは人が直せる出発点を入れる:
   * 表示名はテンプレートのタイトル、公開名と Agent Tool の名前は実体化が決めた function 名。
   */
  loadTemplate: (instantiated, displayName) => set((state) => {
    const positions = layoutWrapped(instantiated.graph.nodes, instantiated.graph.edges);
    const name = instantiated.agentTool.name;
    const pending = instantiated.pendingExpressions[0];
    return {
      metadata: {
        internalId: name,
        workingName: displayName,
        displayName,
        publishName: name,
        agentName: name,
        agentDescription: instantiated.agentTool.description,
        owner: '',
        sideEffect: 'read-only' as const,
      },
      nodes: instantiated.graph.nodes.map((node, index) => makeNode(
        node.id,
        node.type as ToolNodeType,
        node.position ?? positions[index] ?? ORIGIN,
        node.config as Readonly<Record<string, unknown>>,
      )),
      edges: instantiated.graph.edges.map((edge, index) => ({
        id: `${edge.from}-${edge.to}-${index}`,
        source: edge.from,
        target: edge.to,
        ...(edge.toInput === undefined ? {} : { targetHandle: inputHandleId(edge.toInput) }),
      })),
      // 式が空の calculate があれば、そのノードを選んで開いた状態にする（人が最初に触る場所）。
      selectedNodeId: pending?.nodeId ?? instantiated.graph.nodes[0]?.id,
      ...(pending === undefined ? { pendingCalculateIntent: undefined } : { pendingCalculateIntent: { nodeId: pending.nodeId, intent: pending.intent } }),
      createdFromTemplate: `${instantiated.template.id}@${instantiated.template.version}`,
      currentVersion: undefined,
      versions: [] as readonly string[],
      propagation: undefined,
      propagationPending: true,
      preview: undefined,
      draftIssue: undefined,
      diagnostics: undefined,
      saveError: undefined,
      designChat: emptyDesignChat(state.designChat.open),
      ...dropArrangeUndo,
      layoutRevision: state.layoutRevision + 1,
    };
  }),
  consumePendingCalculateIntent: (nodeId) => {
    const pending = get().pendingCalculateIntent;
    if (pending === undefined || pending.nodeId !== nodeId) return undefined;
    set({ pendingCalculateIntent: undefined });
    return pending.intent;
  },
  clearCreatedFromTemplate: () => set({ createdFromTemplate: undefined }),
  setDesignChatOpen: (open) => set((state) => ({ designChat: { ...state.designChat, open } })),
  startDesignChatTurn: (instruction) => {
    // 応答を差し戻す宛先。時刻だけだと同じミリ秒の連投で衝突するので、会話の長さを混ぜる。
    const id = `turn-${Date.now()}-${get().designChat.turns.length}`;
    set((state) => ({
      designChat: {
        ...state.designChat,
        turns: [...state.designChat.turns, { id, user: instruction, changes: [], reverted: false, problems: [], warnings: [] }],
        busy: true,
        error: undefined,
        highlight: [],
      },
    }));
    return id;
  },
  completeDesignChatTurn: (turnId, result) => set((state) => {
    // 要求中に別のツールを開く・新規作成すると会話ごと消える。その遅れた応答でキャンバスを書き換えない。
    if (!state.designChat.turns.some((turn) => turn.id === turnId)) return {};
    const changes = result.changes ?? [];
    const problems = result.problems ?? [];
    const warnings = result.warnings ?? [];
    // 説明文の更新（v49）はグラフとは独立に届く。名前を返さなかったときは説明だけを差し替える。
    const tool = result.agentTool;
    const metadata = tool === undefined ? state.metadata : {
      ...state.metadata,
      ...(tool.name === undefined ? {} : { agentName: tool.name }),
      agentDescription: tool.description,
    };
    /**
     * 1 手で戻せるように、適用前のキャンバスと（変えたなら）適用前の説明文を控える。
     * どちらも変えなかったターン（質問への回答）には付けない＝取り消しボタンも出ない。
     */
    const restorable = result.graph !== undefined || tool !== undefined;
    const answered = (turn: DesignChatTurn): DesignChatTurn => ({
      ...turn, assistant: result.message, changes, problems, warnings,
      ...(restorable ? { before: {
        nodes: state.nodes, edges: state.edges,
        ...(tool === undefined ? {} : { agentTool: { name: state.metadata.agentName, description: state.metadata.agentDescription } }),
      } } : {}),
    });
    // メーターは**直前の応答**だけを映す。消費を返さなかった応答では消す（古い値を残すと嘘になる）。
    const usage = result.usage;
    // 変更なし（質問への回答）と、適用できなかった（problems）ときはキャンバスを触らない。
    if (result.graph === undefined) {
      return {
        ...(tool === undefined ? {} : { metadata }),
        designChat: {
          ...state.designChat,
          turns: state.designChat.turns.map((turn) => turn.id === turnId ? answered(turn) : turn),
          busy: false,
          usage,
        },
      };
    }
    // 空のキャンバスへの適用は丸ごと新しいグラフなので折り返して並べる。既存があれば人の配置を保つ（v51）。
    const fresh = state.nodes.length === 0;
    const positions = fresh
      ? new Map(layoutWrapped(result.graph.nodes, result.graph.edges).map((position, index) => [result.graph?.nodes[index]?.id ?? '', position] as const))
      : designChatPositions(result.graph, state.nodes);
    const { nodes, edges } = graphToFlow(result.graph, positions);
    const touched = changes
      .map((change) => change.nodeId)
      .filter((nodeId): nodeId is string => nodeId !== undefined && nodes.some((node) => node.id === nodeId));
    return {
      nodes,
      edges,
      // 最初の変更ノードを開いて見せる。どれも消えていれば選択は動かさない。
      selectedNodeId: touched[0] ?? state.selectedNodeId,
      designChat: {
        ...state.designChat,
        turns: state.designChat.turns.map((turn) => turn.id === turnId ? answered(turn) : turn),
        busy: false,
        highlight: touched,
        usage,
      },
      ...clearSaveError, ...markPending, ...dropArrangeUndo,
      ...(fresh ? { layoutRevision: state.layoutRevision + 1 } : {}),
      ...(tool === undefined ? {} : { metadata }),
      // 説明文の更新と同じターンで sink が増えることもあるので、更新後のメタデータを渡して上書きを避ける。
      ...bumpSideEffect(metadata, nodes),
    };
  }),
  // 失敗したターンも会話には残す（何を頼んで駄目だったかが読める）。キャンバスは触らない。
  // 会話が消えた後に届いた失敗は、消えたままにする（completeDesignChatTurn と同じ理由）。
  failDesignChatTurn: (turnId, error) => set((state) => state.designChat.turns.some((turn) => turn.id === turnId)
    ? { designChat: { ...state.designChat, busy: false, error } }
    : {}),
  revertDesignChatTurn: (turnId) => set((state) => {
    const index = state.designChat.turns.findIndex((turn) => turn.id === turnId);
    const before = state.designChat.turns[index]?.before;
    if (before === undefined) return {};
    return {
      nodes: [...before.nodes],
      edges: [...before.edges],
      // 説明文を変えたターンなら Tool Calling 契約の説明も適用前へ戻す（v49）。同じ 1 手で全部が戻る。
      ...(before.agentTool === undefined ? {} : { metadata: { ...state.metadata, agentName: before.agentTool.name, agentDescription: before.agentTool.description } }),
      selectedNodeId: before.nodes.some((node) => node.id === state.selectedNodeId) ? state.selectedNodeId : before.nodes[0]?.id,
      designChat: {
        ...state.designChat,
        // このターン以降にキャンバスを変えたターンも巻き戻るので、そちらにも「取り消し済み」を付ける。
        turns: state.designChat.turns.map((turn, position) => position >= index && turn.before !== undefined ? { ...turn, reverted: true } : turn),
        highlight: [],
      },
      ...clearSaveError, ...markPending, ...dropArrangeUndo,
    };
  }),
  clearDesignChatHighlight: () => set((state) => ({ designChat: { ...state.designChat, highlight: [] } })),
  startDesignChatCompact: () => set((state) => ({ designChat: { ...state.designChat, compacting: true, error: undefined } })),
  /**
   * 要約が返った（v49）。畳んだターンは一覧から消え、その `before`（取り消しの戻り先）も
   * 一緒に失われる。だから画面はボタンの補助文で「取り消せなくなる」と先に伝える。
   */
  completeDesignChatCompact: (count, summary) => set((state) => {
    const { turns, compacted } = state.designChat;
    // 材料にしたターンが残っている範囲でだけ畳む（会話が消えた後に届いた要約で先頭を削らない）。
    const folded = Math.min(count, turns.length);
    if (folded <= 0) return { designChat: { ...state.designChat, compacting: false } };
    return {
      designChat: {
        ...state.designChat,
        turns: turns.slice(folded),
        // 前回の要約は材料として渡してあるので、足さずに置き換える（同じ話が二重に載らない）。
        summary,
        compacted: compacted + folded,
        compacting: false,
        // 畳んだターンの強調は、そのターンがもう読めないので一緒に消す。
        highlight: [],
      },
    };
  }),
  failDesignChatCompact: (error) => set((state) => ({ designChat: { ...state.designChat, compacting: false, error } })),
  // 会話・要約・消費を捨てる。キャンバスは触らない（下書きの会話は資産ではないが、作ったグラフは資産）。
  clearDesignChat: () => set((state) => ({ designChat: emptyDesignChat(state.designChat.open) })),
  /**
   * 「整列」（v51）。人が並べた位置も含めて全ノードを並べ直すので、直前の配置を 1 段だけ控えて
   * 「元に戻す」を出せるようにする。位置は保存対象だがドラッグと同じく検証は要らないので、
   * 検証待ちにも保存失敗の消去にもしない。
   */
  arrangeNodes: (maxColumns) => set((state) => {
    if (state.nodes.length === 0) return {};
    const positions = layoutWrapped(
      state.nodes,
      state.edges.map((edge) => ({ from: edge.source, to: edge.target })),
      maxColumns === undefined ? {} : { maxColumns },
    );
    return {
      nodes: state.nodes.map((node, index) => ({ ...node, position: positions[index] ?? node.position })),
      arrangeUndo: state.nodes.map((node) => ({ id: node.id, position: node.position })),
      layoutRevision: state.layoutRevision + 1,
    };
  }),
  undoArrange: () => set((state) => {
    if (state.arrangeUndo === undefined) return {};
    const before = new Map(state.arrangeUndo.map((entry) => [entry.id, entry.position] as const));
    return {
      nodes: state.nodes.map((node) => ({ ...node, position: before.get(node.id) ?? node.position })),
      ...dropArrangeUndo,
      layoutRevision: state.layoutRevision + 1,
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
    ...dropArrangeUndo,
  }),
  // 新規作成。会話は消えるが、パネルを開いているかどうかは利用者の設定なので引き継ぐ。
  reset: () => set((state) => ({ ...initialState(), designChat: emptyDesignChat(state.designChat.open) })),
}));

export function currentGraph(): ToolGraphDto {
  const { nodes, edges } = useToolBuilderStore.getState();
  return flowToGraph(nodes, edges);
}
