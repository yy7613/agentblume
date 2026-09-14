import type { Row } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { JOURNAL_ATTACHMENT_SCHEMA } from '../../domain/etl/nodes/journal-attachment';
import { JOURNAL_DRAFT_ENTRY_SCHEMA } from '../../domain/etl/nodes/journal-draft-entry';
import { JOURNAL_ENTRIES_SCHEMA, JOURNAL_ENTRIES_STATUSES, type JournalEntriesStatus } from '../../domain/etl/nodes/journal-entries-source';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';
import { DataSourceValidationError } from './manage-data-sources';
import type { DatabaseReadPort } from './manage-data-sources';
import type { WebSearchUseCase } from '../search/web-search';

/** 仕訳（`journal-entries` ソース）の絞り込み。ノードの config と同じ形。 */
export interface JournalEntryReadOptions {
  readonly status?: JournalEntriesStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  /** 読む仕訳の件数上限（出力行数ではない）。 */
  readonly limit?: number;
}

/**
 * 仕訳の行を供給するポート。domain の `journal-entries` ノードはリポジトリへ到達できないため、
 * 実行直前にここで行を差し込む（`web-search-source` と同じ規律）。実装は仕訳 BC の
 * `application/journal/entry-rows.ts`（`JournalEntryRowsProvider`）。
 */
export interface JournalEntryReadPort {
  rows(scope: TenantScope, options?: JournalEntryReadOptions): Promise<readonly Row[]>;
}

/** いまの実行に添付された帳票（画像）。`ImageAttachment` と同じ形を構造的に受ける。 */
export interface ResolveAttachment {
  readonly name: string;
  readonly dataUrl: string;
}

/**
 * 添付帳票を読み取って行にするポート。読み取りは LLM が行うため domain からは到達できない。
 * 実装は仕訳 BC の `application/journal/attachment-rows.ts`。
 */
export interface JournalAttachmentReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

/**
 * 添付帳票を読み取り、保存済みのルールで判定して仕訳案にするポート（取込 → 判定を 1 本で通す）。
 * 実装は仕訳 BC の `application/journal/draft-entry-rows.ts`。保存はしない。
 */
export interface JournalDraftEntryReadPort {
  rows(scope: TenantScope, attachments: readonly ResolveAttachment[], options?: { readonly limit?: number }): Promise<readonly Row[]>;
}

/**
 * 実行ごとに変わる文脈。テナント範囲と違い、ツール呼び出しのたびに違う値になる。
 * 添付はツールの引数では運べない（数 MB の base64 をモデルに書かせることになる）ので、ここで渡す。
 */
export interface ResolveGraphContext {
  readonly attachments?: readonly ResolveAttachment[];
}

/** Tool定義内のopaqueなdataSourceIdを、実行直前だけbackend payloadへ展開する。 */
export class ResolveDataSourceGraphUseCase {
  constructor(private readonly sources: DataSourceRepository, private readonly database?: DatabaseReadPort, private readonly webSearch?: WebSearchUseCase, private readonly journalEntries?: JournalEntryReadPort, private readonly journalAttachments?: JournalAttachmentReadPort, private readonly journalDraftEntries?: JournalDraftEntryReadPort) {}

  async execute(scope: TenantScope, graph: ToolGraph, context?: ResolveGraphContext): Promise<ToolGraph> {
    return {
      ...graph,
      nodes: await Promise.all(graph.nodes.map(async (node) => {
        if (node.type !== 'csv-source' && node.type !== 'json-source' && node.type !== 'database-source' && node.type !== 'web-search-source' && node.type !== 'journal-entries' && node.type !== 'journal-attachment' && node.type !== 'journal-draft-entry') return node;
        const configured = node.config as Record<string, unknown>;
        if (node.type === 'journal-draft-entry') {
          // 添付読み取りと同じ規律: 実行文脈が無い呼び出し（保存・スキーマ点検）では書き換えない。
          if (context === undefined) return node;
          if (this.journalDraftEntries === undefined) throw new DataSourceValidationError('journal draft entry is not available');
          const attachments = context.attachments ?? [];
          if (attachments.length === 0) throw new DataSourceValidationError('no document is attached to this message; attach the receipt or invoice image and ask again');
          const limit = configured['limit'];
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) {
            throw new DataSourceValidationError('journal draft entry source has invalid settings');
          }
          const rows = await this.journalDraftEntries.rows(scope, attachments, limit === undefined ? undefined : { limit });
          return { ...node, type: 'json-source', config: { rows, schema: JOURNAL_DRAFT_ENTRY_SCHEMA } };
        }
        if (node.type === 'journal-attachment') {
          // 実行文脈が無い呼び出し（ツールの保存・スキーマ点検・プレビュー）では書き換えない。
          // ここで「添付がありません」と落とすと、組込みツールの登録そのものが起動時に失敗する。
          // 未解決のノードは自前の固定スキーマを返すので、スキーマ伝播はそのまま通る。
          if (context === undefined) return node;
          // ポート未配線でツールを実行させない（空表を返すと「帳票に何も書いていない」と読めてしまう）。
          if (this.journalAttachments === undefined) throw new DataSourceValidationError('journal attachment reading is not available');
          const attachments = context.attachments ?? [];
          // 添付が無いのは利用者が直せる状態なので、空表ではなく直し方の分かる理由で落とす。
          if (attachments.length === 0) throw new DataSourceValidationError('no document is attached to this message; attach the receipt or invoice image and ask again');
          const limit = configured['limit'];
          if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit))) {
            throw new DataSourceValidationError('journal attachment source has invalid settings');
          }
          const rows = await this.journalAttachments.rows(scope, attachments, limit === undefined ? undefined : { limit });
          // スキーマを明示して渡す: 0 件でも列が消えず、下流の filter が列を見失わない。
          return { ...node, type: 'json-source', config: { rows, schema: JOURNAL_ATTACHMENT_SCHEMA } };
        }
        if (node.type === 'journal-entries') {
          // ポート未配線でツールを実行させない（空表を返すと「仕訳が 0 件」と読めてしまう）。
          if (this.journalEntries === undefined) throw new DataSourceValidationError('journal entries are not available');
          const status = configured['status'];
          const from = configured['from'];
          const to = configured['to'];
          const limit = configured['limit'];
          if ((status !== undefined && (typeof status !== 'string' || !(JOURNAL_ENTRIES_STATUSES as readonly string[]).includes(status)))
            || (from !== undefined && typeof from !== 'string')
            || (to !== undefined && typeof to !== 'string')
            || (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit)))) {
            throw new DataSourceValidationError('journal entries source has invalid settings');
          }
          const rows = await this.journalEntries.rows(scope, {
            ...(status === undefined ? {} : { status: status as JournalEntriesStatus }),
            ...(from === undefined ? {} : { from }),
            ...(to === undefined ? {} : { to }),
            ...(limit === undefined ? {} : { limit }),
          });
          // スキーマを明示して渡す: 0 件でも列が消えず、下流の filter が列を見失わない。
          return { ...node, type: 'json-source', config: { rows, schema: JOURNAL_ENTRIES_SCHEMA } };
        }
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
