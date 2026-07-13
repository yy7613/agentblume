import { createHash, randomUUID } from 'node:crypto';
import type { Table } from '../../domain/data/types';
import type { GraphNode } from '../../domain/etl/graph';
import type { AgentOutputConfig } from '../../domain/etl/nodes/agent-output';
import type { GraphArtifactMapping, GraphOutputConfig } from '../../domain/etl/nodes/graph-output';
import type { CompatibleWorkspaceOutputConfig, WorkspaceOutputConfig } from '../../domain/etl/nodes/workspace-output';
import { createSessionArtifact, toArtifactDescriptor, type SessionArtifactDescriptor } from '../../domain/session/session-artifact';
import type { AgentSession } from '../../domain/session/agent-session';
import { SessionQuotaExceededError } from '../../domain/session/errors';
import type { SessionArtifactRepository } from '../../domain/session/session-repository';
import type { Tool } from '../../domain/tool/tool';

export interface ToolOutputDispatchInput {
  readonly tool: Tool;
  readonly table: Table;
  readonly session?: AgentSession;
  readonly runId: string;
  readonly toolCallId: string;
  readonly agentId?: string;
}

export type ToolDeliveryResult =
  | { readonly delivery: 'agent'; readonly value: unknown; readonly content: string; readonly sizeBytes: number; readonly overflowed?: boolean }
  | { readonly delivery: 'session-workspace'; readonly artifact: SessionArtifactDescriptor; readonly content: string };

const DEFAULT_OUTPUT: AgentOutputConfig = { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65_536, overflow: 'error' };
type TableArtifactPayload = { readonly schema: Table['schema']; readonly rows: readonly Readonly<Record<string, unknown>>[] };
type GraphArtifactPayload = { readonly nodes: readonly { readonly id: string; readonly label?: string; readonly properties: Readonly<Record<string, unknown>> }[]; readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string; readonly label?: string; readonly properties: Readonly<Record<string, unknown>> }[] };

export class ToolOutputDispatcher {
  constructor(
    private readonly artifacts?: SessionArtifactRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async dispatch(input: ToolOutputDispatchInput): Promise<ToolDeliveryResult> {
    const sink = terminalSink(input.tool);
    if (sink?.type === 'workspace-output' || sink?.type === 'graph-output') return this.store(input, sink);
    const config = sink?.type === 'agent-output' ? sink.config as AgentOutputConfig : DEFAULT_OUTPUT;
    const value = inlineValue(input.table, config);
    const content = stringify(value);
    const sizeBytes = byteLength(content);
    if (sizeBytes <= config.maxBytes) return { delivery: 'agent', value, content, sizeBytes };
    if (config.overflow === 'store-and-reference') return this.store(input, undefined, true);
    throw new SessionQuotaExceededError(`agent-output exceeds maxBytes (${sizeBytes} > ${config.maxBytes}); reduce rows or use workspace-output`);
  }

  private async store(input: ToolOutputDispatchInput, sink?: GraphNode, overflowed = false): Promise<ToolDeliveryResult> {
    const session = input.session;
    const repository = this.artifacts;
    if (session === undefined || repository === undefined) throw new SessionQuotaExceededError('workspace output requires an active agent session');
    const config: CompatibleWorkspaceOutputConfig | GraphOutputConfig = sink === undefined
      ? { name: `${input.tool.metadata.publishName}-output`, artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 10 }
      : sink.config as CompatibleWorkspaceOutputConfig | GraphOutputConfig;
    const normalized = tablePayload(input.table);
    const kind = sink?.type === 'graph-output' ? 'graph' : (config as WorkspaceOutputConfig).artifactKind;
    const mapping = sink?.type === 'graph-output'
      ? (config as GraphOutputConfig).graph
      : (config as CompatibleWorkspaceOutputConfig).artifactKind === 'graph'
        ? (config as Extract<CompatibleWorkspaceOutputConfig, { readonly artifactKind: 'graph' }>).graph
        : undefined;
    const payload = kind === 'graph' ? graphPayload(normalized, mapping) : normalized;
    const encoded = serializedArtifactPayload(payload, kind);
    const sizeBytes = byteLength(encoded);
    if (sizeBytes > session.quota.maxArtifactBytes) throw new SessionQuotaExceededError(`artifact exceeds maxArtifactBytes (${sizeBytes} > ${session.quota.maxArtifactBytes})`);
    const usage = await repository.usage(session.scope, session.id);
    if (usage.count >= session.quota.maxArtifacts || usage.bytes + sizeBytes > session.quota.maxBytes) throw new SessionQuotaExceededError('session artifact quota exceeded');

    const sinkNodeId = sink?.id ?? 'implicit-agent-output-overflow';
    const idempotencyKey = `${input.runId}:${input.toolCallId}:${sinkNodeId}`;
    const existing = await repository.findByIdempotencyKey(session.scope, session.id, idempotencyKey);
    if (existing !== null) {
      const descriptor = toArtifactDescriptor(existing, previewPayload(payload, config.previewRows));
      return { delivery: 'session-workspace', artifact: descriptor, content: stringify({ artifact: descriptor, overflowed }) };
    }
    const siblings = await repository.list(session.scope, session.id);
    const named = siblings.filter((artifact) => artifact.name === config.name);
    if (config.onConflict === 'fail' && named.length > 0) throw new SessionQuotaExceededError(`artifact name already exists: ${config.name}`);
    const revision = named.length === 0 ? 1 : Math.max(...named.map((artifact) => artifact.revision)) + 1;
    const timestamp = this.now().toISOString();
    const artifact = createSessionArtifact({
      id: this.makeId(), scope: session.scope, sessionId: session.id, name: config.name, kind,
      revision, contentType: kind === 'table' ? 'application/x-ndjson' : kind === 'graph' ? 'application/vnd.agentblume.property-graph+json' : 'application/json',
      schema: input.table.schema, sizeBytes, checksum: createHash('sha256').update(encoded).digest('hex'),
      counts: kind === 'graph' ? { nodes: (payload as GraphArtifactPayload).nodes.length, edges: (payload as GraphArtifactPayload).edges.length } : { rows: input.table.rows.length }, origin: { runId: input.runId, toolId: input.tool.metadata.internalId, toolVersion: input.tool.metadata.version.toString(), toolCallId: input.toolCallId, sinkNodeId, ...(input.agentId === undefined ? {} : { agentId: input.agentId }) },
      createdAt: timestamp, expiresAt: session.expiresAt,
    });
    await repository.save(artifact, payload, idempotencyKey);
    const descriptor = toArtifactDescriptor(artifact, previewPayload(payload, config.previewRows));
    return { delivery: 'session-workspace', artifact: descriptor, content: stringify({ artifact: descriptor, overflowed }) };
  }
}

function terminalSink(tool: Tool): GraphNode | undefined {
  const origins = new Set(tool.graph.edges.map((edge) => edge.from));
  const terminal = tool.graph.nodes.filter((node) => !origins.has(node.id));
  return terminal.length === 1 && ['agent-output', 'workspace-output', 'graph-output'].includes(terminal[0]?.type ?? '') ? terminal[0] : undefined;
}

function inlineValue(table: Table, config: AgentOutputConfig): unknown {
  const columns = config.columns === undefined || config.columns.length === 0 ? table.schema.columns.map((column) => column.name) : config.columns;
  const rows = table.rows.slice(0, config.maxRows).map((row) => Object.fromEntries(columns.map((column) => [column, cellJson(row[column])])));
  if (config.shape === 'first-row') return rows[0] ?? null;
  if (config.shape === 'single-value') return rows[0]?.[config.valueColumn as string] ?? null;
  if (config.shape === 'summary') return { rowCount: table.rows.length, columns: table.schema.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable })), preview: rows.slice(0, 10) };
  if (config.format === 'markdown-table') return markdown(rows, columns);
  if (config.format === 'chartjs') return { labels: rows.map((_, index) => String(index + 1)), datasets: columns.map((column) => ({ label: column, data: rows.map((row) => row[column]) })) };
  return { schema: table.schema, rows };
}

function tablePayload(table: Table): TableArtifactPayload {
  return { schema: table.schema, rows: table.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cellJson(value)]))) };
}
function graphPayload(table: TableArtifactPayload, mapping: GraphArtifactMapping | undefined): GraphArtifactPayload {
  if (mapping === undefined) throw new Error('graph workspace output requires a graph mapping');
  const nodes = new Map<string, { readonly id: string; readonly label?: string; readonly properties: Readonly<Record<string, unknown>> }>();
  const edges = table.rows.map((row, index) => {
    const source = graphId(row[mapping.sourceColumn], mapping.sourceColumn);
    const target = graphId(row[mapping.targetColumn], mapping.targetColumn);
    const labelValue = mapping.edgeLabelColumn === undefined ? undefined : row[mapping.edgeLabelColumn];
    const label = labelValue === undefined || labelValue === null ? undefined : String(labelValue);
    if (!nodes.has(source)) nodes.set(source, { id: source, properties: { id: source } });
    if (!nodes.has(target)) nodes.set(target, { id: target, properties: { id: target } });
    return { id: `${source}->${target}#${index}`, source, target, ...(label === undefined ? {} : { label }), properties: row };
  });
  return { nodes: [...nodes.values()], edges };
}
function graphId(value: unknown, column: string): string {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`graph mapping column '${column}' has an empty value`);
  return String(value);
}
function serializedArtifactPayload(payload: TableArtifactPayload | GraphArtifactPayload, kind: WorkspaceOutputConfig['artifactKind'] | 'graph'): string {
  return kind === 'table'
    ? `${JSON.stringify({ schema: (payload as TableArtifactPayload).schema })}\n${(payload as TableArtifactPayload).rows.map((row) => JSON.stringify(row)).join('\n')}${(payload as TableArtifactPayload).rows.length === 0 ? '' : '\n'}`
    : stringify(payload);
}
function previewPayload(payload: TableArtifactPayload | GraphArtifactPayload, rows: number): unknown {
  if ('rows' in payload) return { schema: payload.schema, rows: payload.rows.slice(0, rows) };
  return { nodes: payload.nodes.slice(0, rows), edges: payload.edges.slice(0, rows) };
}
function cellJson(value: unknown): unknown { return value instanceof Date ? value.toISOString() : value; }
function stringify(value: unknown): string { return JSON.stringify(value) ?? 'null'; }
function byteLength(value: string): number { return new TextEncoder().encode(value).byteLength; }
function markdown(rows: readonly Readonly<Record<string, unknown>>[], columns: readonly string[]): string {
  if (rows.length === 0) return '(no rows)';
  const escape = (value: unknown) => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', '<br>');
  return [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...rows.map((row) => `| ${columns.map((column) => escape(row[column])).join(' | ')} |`)].join('\n');
}
