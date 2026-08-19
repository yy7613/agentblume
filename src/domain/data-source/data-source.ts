import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';
import type { ConnectionId, DataSourceId } from './ids';

/** Toolから参照する再利用可能なデータソースのカタログ情報。payloadや資格情報は含めない。 */
export type DataSource = FileDataSource | DatabaseDataSource;

export interface DataSourceBase {
  readonly id: DataSourceId;
  readonly tenant: TenantScope;
  readonly name: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface FileDataSource extends DataSourceBase {
  readonly kind: 'file';
  readonly format: 'csv' | 'json';
  readonly contentType: 'text/csv' | 'application/json';
  readonly sizeBytes: number;
}

export interface DatabaseDataSource extends DataSourceBase {
  readonly kind: 'database';
  /** backend環境変数の設定名。接続文字列・パスワードではない。 */
  readonly connectionId: ConnectionId;
  readonly driver: 'postgresql';
  readonly defaultSchema?: string;
}

export interface DatabaseConnectionSummary {
  readonly id: ConnectionId;
  readonly driver: 'postgresql';
}

export interface DatabaseConnectionStatus extends DatabaseConnectionSummary {
  readonly available: boolean;
  /** 設定値・秘密情報を出さない利用者向けの状態説明。 */
  readonly error?: string;
}
