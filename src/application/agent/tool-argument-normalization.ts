import type { Table } from '../../domain/data/types';
import type { GraphNode, ToolGraph } from '../../domain/etl/graph';
import { normalizeFilterConfig, type FilterConfig } from '../../domain/etl/nodes/filter';
import type { Tool } from '../../domain/tool/tool';
import type { EtlEngine } from '../etl/engine';
import type { JsonObject } from '../model/model-provider';

export interface IdentifierNormalization { readonly field: string; readonly reason: 'exact-domain-string'; }
export interface NormalizedToolArguments {
  readonly arguments: JsonObject;
  readonly normalizations: readonly IdentifierNormalization[];
  /** Reuse the inspected file snapshots in actual execution, avoiding a second read and source drift. */
  readonly sourceSnapshots: ReadonlyMap<string, GraphNode>;
}
const MAX_DOMAIN_VALUES = 60;
const IDENTIFIER_OPS = new Set(['eq', 'neq', 'in', 'notIn']);

function ancestors(graph: ToolGraph, nodeId: string): GraphNode[] {
  const seen = new Set<string>(), pending = [nodeId];
  while (pending.length) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...graph.edges.filter(edge => edge.to === id).map(edge => edge.from));
  }
  return graph.nodes.filter(node => seen.has(node.id));
}

/** Only paths known to preserve this identifier are eligible; unknown transforms fail closed. */
function preservesIdentifier(node: GraphNode, column: string): boolean {
  if (['csv-source', 'json-source', 'select', 'filter', 'sort', 'limit', 'distinct', 'join'].includes(node.type)) return true;
  const config = node.config as Record<string, unknown>;
  if (node.type === 'calculate') return config['outputColumn'] !== column;
  if (node.type === 'parse-period') return (config['startColumn'] ?? 'periodStart') !== column && (config['granularityColumn'] ?? 'periodGranularity') !== column;
  if (node.type === 'rename') {
    const renames = config['renames'];
    return Array.isArray(renames) && renames.every(rename => rename.from !== column && rename.to !== column);
  }
  return false;
}

function domain(table: Table, column: string): string[] | undefined {
  if (!table.schema.columns.some(item => item.name === column && item.type === 'string')) return undefined;
  const values = new Set<string>();
  for (const row of table.rows) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') return undefined;
    values.add(value);
    if (values.size > MAX_DOMAIN_VALUES) return undefined;
  }
  return values.size ? [...values].sort() : undefined;
}

/** Exact quoting only. Never pad, trim or choose among identifiers that collide when represented as numbers. */
export function exactNumericIdentifier(value: number, values: readonly string[]): string | undefined {
  if (!Number.isSafeInteger(value)) return undefined;
  const candidate = String(value);
  if (!values.includes(candidate)) return undefined;
  return values.filter(item => item.trim() !== '' && Number(item) === value).length === 1 ? candidate : undefined;
}

export async function normalizeIdentifierArguments(input: {
  readonly tool: Tool;
  readonly arguments: JsonObject;
  readonly engine: EtlEngine;
  /** This callback must resolve file nodes only, without database/web/business-source dispatch. */
  readonly resolveFileSource?: (node: GraphNode) => Promise<GraphNode | undefined>;
}): Promise<NormalizedToolArguments> {
  const unchanged = (): NormalizedToolArguments => ({ arguments: input.arguments, normalizations: [], sourceSnapshots: new Map() });
  if (input.tool.sideEffect !== 'read-only') return unchanged();
  const candidates = (input.tool.inputSchema?.columns ?? []).filter(column => column.type === 'string' && typeof input.arguments[column.name] === 'number' && Number.isSafeInteger(input.arguments[column.name]));
  if (!candidates.length) return unchanged();
  const tables = new Map<string, Table>(), snapshots = new Map<string, GraphNode>();
  const load = async (node: GraphNode): Promise<Table | undefined> => {
    if (tables.has(node.id)) return tables.get(node.id);
    if (node.type !== 'csv-source' && node.type !== 'json-source') return undefined;
    const config = node.config as Record<string, unknown>;
    const id = config['dataSourceId'];
    const resolved = typeof id === 'string' && id.trim() !== '' ? await input.resolveFileSource?.(node) : node;
    if (!resolved) return undefined;
    const preview = input.engine.preview({ nodes: [resolved], edges: [] }, { rowLimit: 1, retainTables: true });
    tables.set(node.id, preview.fullOutput); snapshots.set(node.id, resolved);
    return preview.fullOutput;
  };
  const corrected = { ...input.arguments }, normalizations: IdentifierNormalization[] = [];
  try {
    for (const candidate of candidates) {
      const sites = input.tool.graph.nodes.filter(node => node.type === 'filter').flatMap(node =>
        normalizeFilterConfig(node.config as FilterConfig).conditions.filter(condition => condition.valueBinding?.source === 'agent-input' && condition.valueBinding.field === candidate.name)
          .map(condition => ({ node, condition })));
      if (!sites.length || sites.some(site => !IDENTIFIER_OPS.has(site.condition.op))) continue;
      const domains: string[][] = [];
      let eligible = true;
      for (const site of sites) {
        const path = ancestors(input.tool.graph, site.node.id);
        if (path.some(node => !preservesIdentifier(node, site.condition.column))) { eligible = false; break; }
        const sources = path.filter(node => node.type === 'csv-source' || node.type === 'json-source');
        let found = false;
        for (const source of sources) {
          const table = await load(source);
          if (!table) { eligible = false; break; }
          if (!table.schema.columns.some(column => column.name === site.condition.column)) continue;
          const values = domain(table, site.condition.column);
          if (!values) { eligible = false; break; }
          domains.push(values); found = true;
        }
        if (!eligible || !found) { eligible = false; break; }
      }
      if (!eligible || !domains.length || domains.some(values => JSON.stringify(values) !== JSON.stringify(domains[0]))) continue;
      const canonical = exactNumericIdentifier(input.arguments[candidate.name] as number, domains[0]!);
      if (canonical === undefined) continue;
      corrected[candidate.name] = canonical;
      normalizations.push({ field: candidate.name, reason: 'exact-domain-string' });
    }
  } catch {
    // A failed read or an unsupported definition cannot justify changing an identifier.
    return unchanged();
  }
  return normalizations.length ? { arguments: corrected, normalizations, sourceSnapshots: snapshots } : unchanged();
}

export function withFileSourceSnapshots(graph: ToolGraph, snapshots: ReadonlyMap<string, GraphNode>): ToolGraph {
  return snapshots.size ? { ...graph, nodes: graph.nodes.map(node => snapshots.get(node.id) ?? node) } : graph;
}
