/**
 * ドメイン: MCPサーバー設定のリポジトリ境界。
 *
 * save は (scope, name) で upsert する（設定は版を持たない。常に最新の1件だけを保持する）。
 * replaceAll は「JSONタブのApply」に対応し、スコープ内の設定を与えられた集合で丸ごと置き換える
 * （実装はトランザクションで原子的に行うこと。途中失敗で設定が半端に消えてはならない）。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { McpServerConfig } from './mcp-server';

export interface McpServerRepository {
  save(config: McpServerConfig): Promise<void>;
  find(scope: TenantScope, name: string): Promise<McpServerConfig | null>;
  /** name 昇順で返す。 */
  list(scope: TenantScope): Promise<readonly McpServerConfig[]>;
  /** 戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, name: string): Promise<boolean>;
  replaceAll(scope: TenantScope, configs: readonly McpServerConfig[]): Promise<void>;
}
