import type { TenantScope } from '../tool/ids';
import type { DataSource } from './data-source';
import type { DataSourceId } from './ids';

/** カタログとファイルpayloadをbackend側で保持するポート。 */
export interface DataSourceRepository {
  save(source: DataSource, fileContent?: string): Promise<void>;
  list(scope: TenantScope): Promise<readonly DataSource[]>;
  find(scope: TenantScope, id: DataSourceId): Promise<DataSource | null>;
  /** ファイル本文はbackend内でのみ返す。APIレスポンスへそのまま流してはならない。 */
  readFile(scope: TenantScope, id: DataSourceId): Promise<{ readonly source: DataSource; readonly content: string } | null>;
  delete(scope: TenantScope, id: DataSourceId): Promise<void>;
}
