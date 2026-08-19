/**
 * ドメイン: DataSource 識別子(ADR-0034)
 */
import type { Flavor } from '../shared/brand';

/** データソースの識別子。 */
export type DataSourceId = Flavor<string, 'DataSourceId'>;

/** 接続設定の識別子。 */
export type ConnectionId = Flavor<string, 'ConnectionId'>;
