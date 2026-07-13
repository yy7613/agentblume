import { createHash, randomUUID } from 'node:crypto';
import type { Table } from '../../domain/data/types';
import type { GraphNode } from '../../domain/etl/graph';
import type { AgentOutputConfig } from '../../domain/etl/nodes/agent-output';
import type { GraphArtifactMapping, GraphOutputConfig } from '../../domain/etl/nodes/graph-output';
import type { CompatibleWorkspaceOutputConfig, WorkspaceOutputConfig } from '../../domain/etl/nodes/workspace-output';
import type { ChartOutputConfig } from '../../domain/etl/nodes/chart-output';
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
type ChartArtifactPayload = { readonly specVersion: 1; readonly chartType: ChartOutputConfig['chartType']; readonly title?: string; readonly mapping: Readonly<Record<string, string | number>>; readonly rows: readonly Readonly<Record<string, unknown>>[]; readonly sourceRowCount: number; readonly sampled: boolean };

export class ToolOutputDispatcher {
  constructor(
    private readonly artifacts?: SessionArtifactRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
  ) {}

  async dispatch(input: ToolOutputDispatchInput): Promise<ToolDeliveryResult> {
    const sink = terminalSink(input.tool);
    if (sink?.type === 'workspace-output' || sink?.type === 'graph-output' || sink?.type === 'chart-output') return this.store(input, sink);
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
    const config: CompatibleWorkspaceOutputConfig | GraphOutputConfig | ChartOutputConfig = sink === undefined
      ? { name: `${input.tool.metadata.publishName}-output`, artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 10 }
      : sink.config as CompatibleWorkspaceOutputConfig | GraphOutputConfig | ChartOutputConfig;
    const normalized = tablePayload(input.table);
    const kind = sink?.type === 'graph-output' ? 'graph' : sink?.type === 'chart-output' ? 'chart' : (config as WorkspaceOutputConfig).artifactKind;
    const mapping = sink?.type === 'graph-output'
      ? (config as GraphOutputConfig).graph
      : (config as CompatibleWorkspaceOutputConfig).artifactKind === 'graph'
        ? (config as Extract<CompatibleWorkspaceOutputConfig, { readonly artifactKind: 'graph' }>).graph
        : undefined;
    const payload = kind === 'graph' ? graphPayload(normalized, mapping) : kind === 'chart' && sink?.type === 'chart-output' ? chartPayload(normalized, config as ChartOutputConfig) : normalized;
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
  return terminal.length === 1 && ['agent-output', 'workspace-output', 'graph-output', 'chart-output'].includes(terminal[0]?.type ?? '') ? terminal[0] : undefined;
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
  if (mapping.mode === 'correlation-network') return correlationNetworkPayload(table, mapping);
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
function correlationNetworkPayload(table: TableArtifactPayload, mapping: Extract<GraphArtifactMapping, { readonly mode: 'correlation-network' }>): GraphArtifactPayload {
  const nodes = new Map<string, { readonly id: string; readonly label?: string; readonly properties: Readonly<Record<string, unknown>> }>();
  const edges: { id: string; source: string; target: string; label?: string; properties: Readonly<Record<string, unknown>> }[] = [];
  const pairs = new Set<string>();
  for (const row of table.rows) {
    const source = graphId(row[mapping.columnX], mapping.columnX); const target = graphId(row[mapping.columnY], mapping.columnY);
    const coefficient = row[mapping.coefficient]; const pairCount = row[mapping.pairCount];
    if (typeof coefficient !== 'number' || !Number.isFinite(coefficient) || typeof pairCount !== 'number' || !Number.isFinite(pairCount)) continue;
    if (source === target || Math.abs(coefficient) < mapping.minimumAbsoluteCoefficient || pairCount < mapping.minimumPairCount) continue;
    const key = [source, target].sort().join('\u0000'); if (pairs.has(key)) continue; pairs.add(key);
    if (!nodes.has(source)) nodes.set(source, { id: source, label: source, properties: { column: source } });
    if (!nodes.has(target)) nodes.set(target, { id: target, label: target, properties: { column: target } });
    edges.push({ id: `correlation:${key}`, source, target, label: 'correlation', properties: { ...row, coefficient, absoluteCoefficient: Math.abs(coefficient), pairCount } });
  }
  return { nodes: [...nodes.values()], edges };
}
function chartPayload(table: TableArtifactPayload, config: ChartOutputConfig): ChartArtifactPayload {
  const rows = chartRows(table.rows, config);
  return { specVersion: 1, chartType: config.chartType, ...(config.title === undefined ? {} : { title: config.title }), mapping: config.mapping, rows, sourceRowCount: table.rows.length, sampled: rows.length < table.rows.length };
}
function chartRows(rows: readonly Readonly<Record<string, unknown>>[], config: ChartOutputConfig): readonly Readonly<Record<string, unknown>>[] {
  if (rows.length <= config.maxPoints) return rows;
  if (config.downsample === 'none') return rows.slice(0, config.maxPoints);
  const xColumn = mappingString(config.mapping, config.chartType === 'time-series' ? 'timeColumn' : 'xColumn');
  const yColumn = mappingString(config.mapping, config.chartType === 'time-series' ? 'valueColumn' : 'yColumn');
  return xColumn === undefined || yColumn === undefined ? evenlySample(rows, config.maxPoints) : largestTriangleThreeBuckets(rows, config.maxPoints, xColumn, yColumn);
}
function mappingString(mapping: ChartOutputConfig['mapping'], key: string): string | undefined { const value = mapping[key]; return typeof value === 'string' ? value : undefined; }
function evenlySample(rows: readonly Readonly<Record<string, unknown>>[], maxPoints: number): readonly Readonly<Record<string, unknown>>[] {
  if (maxPoints <= 1) return rows.slice(0, 1);
  const result: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < maxPoints; index++) result.push(rows[Math.round(index * (rows.length - 1) / (maxPoints - 1))]!);
  return result;
}
/** LTTB preserves visual extrema while retaining the first and final observations. */
function largestTriangleThreeBuckets(rows: readonly Readonly<Record<string, unknown>>[], maxPoints: number, xColumn: string, yColumn: string): readonly Readonly<Record<string, unknown>>[] {
  if (maxPoints <= 2) return evenlySample(rows, maxPoints);
  const points = rows.map((row, index) => ({ row, x: chartNumber(row[xColumn], index), y: chartNumber(row[yColumn], 0) }));
  const sampled: Readonly<Record<string, unknown>>[] = [rows[0]!];
  const every = (rows.length - 2) / (maxPoints - 2);
  let selected = 0;
  for (let bucket = 0; bucket < maxPoints - 2; bucket++) {
    const averageStart = Math.floor((bucket + 1) * every) + 1;
    const averageEnd = Math.min(Math.floor((bucket + 2) * every) + 1, rows.length);
    const average = points.slice(averageStart, averageEnd);
    const averageX = average.reduce((sum, point) => sum + point.x, 0) / (average.length || 1);
    const averageY = average.reduce((sum, point) => sum + point.y, 0) / (average.length || 1);
    const rangeStart = Math.floor(bucket * every) + 1;
    const rangeEnd = Math.min(Math.floor((bucket + 1) * every) + 1, rows.length - 1);
    const previous = points[selected]!;
    let largestArea = -1;
    let next = rangeStart;
    for (let index = rangeStart; index < rangeEnd; index++) {
      const point = points[index]!;
      const area = Math.abs((previous.x - averageX) * (point.y - previous.y) - (previous.x - point.x) * (averageY - previous.y));
      if (area > largestArea) { largestArea = area; next = index; }
    }
    sampled.push(rows[next]!);
    selected = next;
  }
  sampled.push(rows[rows.length - 1]!);
  return sampled;
}
function chartNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'string') { const parsed = Date.parse(value); if (Number.isFinite(parsed)) return parsed; }
  return fallback;
}
function graphId(value: unknown, column: string): string {
  if (value === undefined || value === null || String(value).trim() === '') throw new Error(`graph mapping column '${column}' has an empty value`);
  return String(value);
}
function serializedArtifactPayload(payload: TableArtifactPayload | GraphArtifactPayload | ChartArtifactPayload, kind: WorkspaceOutputConfig['artifactKind'] | 'graph'): string {
  return kind === 'table'
    ? `${JSON.stringify({ schema: (payload as TableArtifactPayload).schema })}\n${(payload as TableArtifactPayload).rows.map((row) => JSON.stringify(row)).join('\n')}${(payload as TableArtifactPayload).rows.length === 0 ? '' : '\n'}`
    : stringify(payload);
}
function previewPayload(payload: TableArtifactPayload | GraphArtifactPayload | ChartArtifactPayload, rows: number): unknown {
  if ('chartType' in payload) return { chartType: payload.chartType, title: payload.title, mapping: payload.mapping, sourceRowCount: payload.sourceRowCount, sampled: payload.sampled, rows: payload.rows.slice(0, rows) };
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
