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
  error?: string;
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
  setError(error?: string): void;
  setSavedVersion(version: string, versions: readonly string[]): void;
  setVersions(versions: readonly string[]): void;
  loadTool(tool: SerializedToolDto): void;
  reset(): void;
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

function starterNodes(): ToolFlowNode[] {
  return [
    makeNode('source-1', 'json-source', { x: 80, y: 120 }),
    makeNode('filter-1', 'filter', { x: 390, y: 120 }, { column: 'age', op: 'gte', value: 18 }),
  ];
}

function makeNode(
  id: string,
  type: ToolNodeType,
  position: { x: number; y: number },
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

let nextNodeId = 1;

function initialState() {
  return {
    metadata: initialMetadata,
    nodes: starterNodes(),
    edges: [{ id: 'source-1-filter-1', source: 'source-1', target: 'filter-1' }],
    selectedNodeId: 'filter-1' as string | undefined,
    propagation: undefined,
    preview: undefined,
    previewLoading: false,
    error: undefined,
    currentVersion: undefined,
    versions: [] as readonly string[],
  };
}

export function flowToGraph(nodes: readonly ToolFlowNode[], edges: readonly Edge[]): ToolGraphDto {
  return {
    nodes: nodes.map((node) => ({ id: node.id, type: node.data.nodeType, config: node.data.config })),
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
    ...(['tenantId', 'workspaceId', 'internalId'].includes(key) ? { currentVersion: undefined, versions: [] } : {}),
  })),
  addNode: (type) => set((state) => {
    const id = `${type}-${nextNodeId++}`;
    const selected = state.nodes.find((node) => node.id === state.selectedNodeId);
    const x = selected === undefined ? 160 + state.nodes.length * 40 : selected.position.x + 280;
    const y = selected === undefined ? 100 + state.nodes.length * 55 : selected.position.y;
    const item = catalogItem(type);
    const upstreamColumns = selected === undefined ? [] : (state.propagation?.nodes[selected.id]?.schema.columns ?? []);
    const initialConfig = type === 'graph-output' && upstreamColumns.length >= 2
      ? { ...structuredClone(item.defaultConfig), graph: { sourceColumn: upstreamColumns[0]?.name, targetColumn: upstreamColumns[1]?.name } }
      : undefined;
    const node = makeNode(id, type, { x, y }, initialConfig);
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
      ...((type === 'workspace-output' || type === 'graph-output') && state.metadata.sideEffect === 'read-only' ? { metadata: { ...state.metadata, sideEffect: 'session-write' as const } } : {}),
    };
  }),
  onNodesChange: (changes) => set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) })),
  onEdgesChange: (changes) => set((state) => ({ edges: applyEdgeChanges(changes, state.edges) })),
  onConnect: (connection) => set((state) => ({ edges: addEdge(connection, state.edges) })),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  updateNodeConfig: (nodeId, config) => set((state) => ({
    nodes: state.nodes.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, config } } : node),
  })),
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  setPropagation: (propagation) => set({ propagation }),
  setPreview: (preview) => set({ preview }),
  setError: (error) => set({ error }),
  setSavedVersion: (currentVersion, versions) => set({ currentVersion, versions }),
  setVersions: (versions) => set({ versions }),
  loadTool: (tool) => set((state) => ({
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
      { x: 80 + index * 280, y: 120 },
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
    error: undefined,
    versions: state.versions,
  })),
  reset: () => {
    nextNodeId = 1;
    set(initialState());
  },
}));

export function currentGraph(): ToolGraphDto {
  const { nodes, edges } = useToolBuilderStore.getState();
  return flowToGraph(nodes, edges);
}
