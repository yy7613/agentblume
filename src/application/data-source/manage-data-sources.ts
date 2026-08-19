import { randomUUID } from 'node:crypto';
import type { TenantScope } from '../../domain/tool/ids';
import type { DataSource, DatabaseConnectionStatus, DatabaseConnectionSummary } from '../../domain/data-source/data-source';
import type { ConnectionId, DataSourceId } from '../../domain/data-source/ids';
import type { Row } from '../../domain/data/types';
import type { DataSourceRepository } from '../../domain/data-source/data-source-repository';
import { validateFileContent } from '../../domain/data-source/file-content-validation';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** backendが環境変数から解決するDB接続の安全な公開面。 */
export interface DatabaseConnectionCatalog {
  list(): readonly DatabaseConnectionSummary[];
  test(connectionId: ConnectionId): Promise<DatabaseConnectionStatus>;
}

/** DB読取は構成済みallowlistのtable/viewを固定上限で読むだけのポート。 */
export interface DatabaseReadPort {
  readTable(connectionId: ConnectionId, table: string, limit: number): Promise<readonly Row[]>;
}

export class DataSourceValidationError extends Error {
  readonly code = 'DATA_SOURCE_VALIDATION';
  constructor(message: string) { super(message); this.name = 'DataSourceValidationError'; }
}

export class SaveFileDataSourceUseCase {
  constructor(
    private readonly repository: DataSourceRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly name: string; readonly format: 'csv' | 'json'; readonly content: string }): Promise<DataSource> {
    const name = input.name.trim();
    if (name === '') throw new DataSourceValidationError('file name is required');
    const sizeBytes = Buffer.byteLength(input.content, 'utf8');
    if (sizeBytes === 0) throw new DataSourceValidationError('file content must not be empty');
    if (sizeBytes > MAX_FILE_BYTES) throw new DataSourceValidationError(`file content exceeds ${MAX_FILE_BYTES} bytes`);
    // 壊れたCSV/JSON（バイナリ混入・null文字・パース不能）を登録前に検出する（UX改善）。
    validateFileContent(input.format, input.content);
    const timestamp = this.now().toISOString();
    const source: DataSource = {
      id: this.makeId(), tenant: input.scope, name, kind: 'file', format: input.format,
      contentType: input.format === 'csv' ? 'text/csv' : 'application/json', sizeBytes,
      createdAt: timestamp, updatedAt: timestamp,
    };
    await this.repository.save(source, input.content);
    return source;
  }
}

export class RegisterDatabaseDataSourceUseCase {
  constructor(
    private readonly repository: DataSourceRepository,
    private readonly connections: DatabaseConnectionCatalog,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: { readonly scope: TenantScope; readonly name: string; readonly connectionId: ConnectionId; readonly defaultSchema?: string }): Promise<DataSource> {
    const name = input.name.trim();
    const connectionId = input.connectionId.trim();
    if (name === '') throw new DataSourceValidationError('database source name is required');
    if (connectionId === '') throw new DataSourceValidationError('connection ID is required');
    const connection = this.connections.list().find((item) => item.id === connectionId);
    if (connection === undefined) throw new DataSourceValidationError(`connection is not configured: ${connectionId}`);
    const defaultSchema = input.defaultSchema?.trim();
    const timestamp = this.now().toISOString();
    const source: DataSource = {
      id: this.makeId(), tenant: input.scope, name, kind: 'database', connectionId,
      driver: connection.driver, ...(defaultSchema === undefined || defaultSchema === '' ? {} : { defaultSchema }),
      createdAt: timestamp, updatedAt: timestamp,
    };
    await this.repository.save(source);
    return source;
  }
}

export class QueryDataSourcesUseCase {
  constructor(private readonly repository: DataSourceRepository) {}
  async list(scope: TenantScope): Promise<readonly DataSource[]> { return this.repository.list(scope); }
}

export class DeleteDataSourceUseCase {
  constructor(private readonly repository: DataSourceRepository) {}
  async execute(scope: TenantScope, id: DataSourceId): Promise<void> { await this.repository.delete(scope, id); }
}

export class QueryDatabaseConnectionsUseCase {
  constructor(private readonly connections: DatabaseConnectionCatalog) {}
  list(): readonly DatabaseConnectionSummary[] { return this.connections.list(); }
  async test(connectionId: ConnectionId): Promise<DatabaseConnectionStatus> { return this.connections.test(connectionId); }
}
