/**
 * ドメイン共有: テナントスコープ(ADR-0035)
 *
 * 実体は歴史的に src/domain/tool/ids.ts にあったが、全 BC が依存する横断概念のため
 * shared へ移設した。旧パス(tool/ids.ts)は互換のため再エクスポートを維持する。
 */
import type { Brand, Flavor } from './brand';
import type { ErrorFactory } from './errors';
import { SharedValidationError } from './errors';
import { assertNonEmpty } from './assert';

/** テナント識別子。素の string から代入可(弱ブランド)、WorkspaceId との取り違えは不可。 */
export type TenantId = Flavor<string, 'TenantId'>;

/** ワークスペース識別子。素の string から代入可(弱ブランド)、TenantId との取り違えは不可。 */
export type WorkspaceId = Flavor<string, 'WorkspaceId'>;

/** テナント分離の単位。テナント × ワークスペース。 */
export interface TenantScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/** tenantKey() が生成する連結キー。素の string からの代入は不可(強ブランド)。 */
export type TenantKey = Brand<string, 'TenantKey'>;

/**
 * TenantScope を衝突しない単一文字列キーへ連結する。
 *
 * 区切りにスペースを用いる。tenantId / workspaceId 自体にスペースを含めない
 * 前提(識別子は非空トークン)で衝突しない。
 */
export function tenantKey(scope: TenantScope): TenantKey {
  return `${scope.tenantId} ${scope.workspaceId}` as TenantKey;
}

/** TenantScope の形状か判定する(値の非空までは見ない構造ガード)。 */
export function isTenantScope(value: unknown): value is TenantScope {
  if (typeof value !== 'object' || value === null) return false;
  const scope = value as { tenantId?: unknown; workspaceId?: unknown };
  return typeof scope.tenantId === 'string' && typeof scope.workspaceId === 'string';
}

export interface CreateTenantScopeOptions {
  /** エラーメッセージの前置詞。既定 'createTenantScope: scope'。 */
  readonly label?: string;
  /** BC 固有のエラー型を投げたい場合に注入する。 */
  readonly fail?: ErrorFactory;
}

/** 両フィールドを非空検証し、防御的コピーを凍結して返す。不正は fail(既定 SharedValidationError)。 */
export function createTenantScope(value: unknown, options: CreateTenantScopeOptions = {}): TenantScope {
  const label = options.label ?? 'createTenantScope: scope';
  const fail = options.fail ?? ((message: string) => new SharedValidationError(message));
  if (!isTenantScope(value)) {
    throw fail(`${label} must be a TenantScope object`);
  }
  assertNonEmpty(value.tenantId, `${label}.tenantId`, fail);
  assertNonEmpty(value.workspaceId, `${label}.workspaceId`, fail);
  // tenantKey() のスペース区切りが衝突しないための前提(識別子は空白を含まないトークン)を強制する。
  if (/\s/.test(value.tenantId)) throw fail(`${label}.tenantId must not contain whitespace`);
  if (/\s/.test(value.workspaceId)) throw fail(`${label}.workspaceId must not contain whitespace`);
  return Object.freeze({ tenantId: value.tenantId, workspaceId: value.workspaceId });
}
