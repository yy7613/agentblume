/**
 * ドメイン: Tool 識別子とテナントスコープ（v2 実装契約 §4）
 */

/** Tool の内部識別子（非空文字列）。 */
export type ToolId = string;

/** テナント分離の単位。テナント × ワークスペース。 */
export interface TenantScope {
  readonly tenantId: string;
  readonly workspaceId: string;
}

/**
 * TenantScope を衝突しない単一文字列キーへ連結する。
 *
 * 区切りにスペースを用いる。tenantId / workspaceId 自体にスペースを含めない
 * 前提（識別子は非空トークン）で衝突しない。
 */
export function tenantKey(scope: TenantScope): string {
  return `${scope.tenantId} ${scope.workspaceId}`;
}
