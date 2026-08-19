/**
 * ドメイン: Tool 識別子とテナントスコープ（v2 実装契約 §4）
 *
 * TenantScope / tenantKey の実体は横断概念として shared へ移設した(ADR-0035)。
 * 既存 import の互換のためここから再エクスポートする。
 * 再エクスポートはテスト互換のために維持。テスト以外の新規コードは shared/tenant-scope を直接 import すること。
 */
import type { Flavor } from '../shared/brand';

export type { TenantScope, TenantKey } from '../shared/tenant-scope';
export { tenantKey } from '../shared/tenant-scope';

/** Tool の内部識別子（非空文字列）。 */
export type ToolId = Flavor<string, 'ToolId'>;
