import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/tool/ids';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';
import { DataSourceValidationError } from './manage-data-sources';
import type { DatabaseReadPort } from './manage-data-sources';
import type { WebSearchUseCase } from '../search/web-search';

/** Tool定義内のopaqueなdataSourceIdを、実行直前だけbackend payloadへ展開する。 */
export class ResolveDataSourceGraphUseCase {
  constructor(private readonly sources: DataSourceRepository, private readonly database?: DatabaseReadPort, private readonly webSearch?: WebSearchUseCase) {}

  async execute(scope: TenantScope, graph: ToolGraph): Promise<ToolGraph> {
    return {
      ...graph,
      nodes: await Promise.all(graph.nodes.map(async (node) => {
        if (node.type !== 'csv-source' && node.type !== 'json-source' && node.type !== 'database-source' && node.type !== 'web-search-source') return node;
        const configured = node.config as Record<string, unknown>;
        if (node.type === 'web-search-source') {
          const provider = configured['provider'];
          const query = configured['query'];
          const maxResults = configured['maxResults'] ?? 5;
          const cacheKey = configured['cacheKey'];
          if (this.webSearch === undefined) throw new DataSourceValidationError('web search execution is not configured');
          if (typeof provider !== 'string' || typeof query !== 'string' || typeof maxResults !== 'number' || !Number.isInteger(maxResults)) throw new DataSourceValidationError('web search source has invalid settings');
          try {
            if (!this.webSearch.isConfigured(provider)) throw new DataSourceValidationError(`search provider is not configured: ${provider}`);
            if (typeof cacheKey !== 'string' || cacheKey === '') return { ...node, type: 'json-source', config: { rows: [] } };
            const includeDomains = Array.isArray(configured['includeDomains']) && configured['includeDomains'].every((value) => typeof value === 'string') ? configured['includeDomains'] as string[] : [];
            const rows = this.webSearch.resolve(scope, { cacheKey, provider, query, maxResults, includeDomains });
            return { ...node, type: 'json-source', config: { rows } };
          } catch (error) {
            throw new DataSourceValidationError(error instanceof Error ? error.message : 'web search source cannot resolve cache');
          }
        }
        const dataSourceId = configured['dataSourceId'];
        if (typeof dataSourceId !== 'string' || dataSourceId.trim() === '') return node;
        if (node.type === 'database-source') {
          const source = await this.sources.find(scope, dataSourceId);
          const table = configured['table'];
          if (source === null || source.kind !== 'database') throw new DataSourceValidationError(`data source is unavailable or not a database: ${dataSourceId}`);
          if (typeof table !== 'string' || table.trim() === '') throw new DataSourceValidationError('database source requires a table/view');
          if (this.database === undefined) throw new DataSourceValidationError('database source execution is not configured');
          try {
            const rows = await this.database.readTable(source.connectionId, table, typeof configured['limit'] === 'number' ? configured['limit'] : 1000);
            return { ...node, type: 'json-source', config: { rows } };
          } catch { throw new DataSourceValidationError(`database source cannot read allowed table '${table}'`); }
        }
        const record = await this.sources.readFile(scope, dataSourceId);
        if (record === null || record.source.kind !== 'file') throw new DataSourceValidationError(`data source is unavailable or not a file: ${dataSourceId}`);
        if (node.type === 'csv-source') {
          if (record.source.format !== 'csv') throw new DataSourceValidationError(`data source '${dataSourceId}' is not CSV`);
          const { dataSourceId: _id, ...config } = configured;
          return { ...node, config: { ...config, text: record.content } };
        }
        if (record.source.format !== 'json') throw new DataSourceValidationError(`data source '${dataSourceId}' is not JSON`);
        let rows: unknown;
        try { rows = JSON.parse(record.content); } catch { throw new DataSourceValidationError(`JSON data source '${dataSourceId}' is invalid`); }
        if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== 'object' || Array.isArray(row))) {
          throw new DataSourceValidationError(`JSON data source '${dataSourceId}' must contain an array of objects`);
        }
        const { dataSourceId: _id, ...config } = configured;
        return { ...node, config: { ...config, rows: rows as Row[] } };
      })),
    };
  }
}
