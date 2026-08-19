/**
 * ドメイン共有: 公開可能アセットの共通メタデータ(ADR-0036、docs/03-domain-model.md §2)
 *
 * tool / agent / skill / harness / validation / evaluation の 6 BC にコピペされていた
 * 8 フィールドのメタデータ定義・検証・シリアライズ断片の単一情報源。
 *
 * - `version` はジェネリクス `V` で受ける。SemVer は tool BC 残置の決定(ADR-0035)により
 *   shared から import できないため、instanceof 検査は `isVersion` として注入する。
 * - エラーメッセージは `${prefix}: ${fieldPath} ...` 形で全 BC 統一されており、
 *   prefix とエラーファクトリの注入でバイト単位の互換を保つ。
 */
import { z } from 'zod';
import { assertNonEmpty } from './assert';
import type { ErrorFactory } from './errors';
import type { TenantScope } from './tenant-scope';

/** 公開ライフサイクル状態。 */
export type PublishState = 'draft' | 'in-review' | 'published' | 'deprecated' | 'archived';

/** 有効な PublishState の集合（実行時検証用）。 */
export const PUBLISH_STATES: readonly PublishState[] = [
  'draft',
  'in-review',
  'published',
  'deprecated',
  'archived',
];

/** 値が PublishState か判定する型ガード。 */
export function isPublishState(value: unknown): value is PublishState {
  return typeof value === 'string' && (PUBLISH_STATES as readonly string[]).includes(value);
}

/** 公開可能アセットの識別・公開・所有情報。各 BC は Id と V(SemVer)を束ねた別名で参照する。 */
export interface PublishableMetadata<Id extends string = string, V = unknown> {
  readonly internalId: Id;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: V;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

export interface ValidatePublishableMetadataOptions {
  /** BC 固有のエラー型を投げるファクトリ。 */
  readonly fail: ErrorFactory;
  /** version の型検査(通常 `(v) => v instanceof SemVer`)。 */
  readonly isVersion: (value: unknown) => boolean;
  /** 空白のみ文字列の扱い。tool のみ false(歴史的意味論の保存)。 */
  readonly trim?: boolean;
  /**
   * tenant がオブジェクトでないときに投げるメッセージ(tool のみ指定)。
   * 未指定の BC は optional chaining により tenant.tenantId の非空エラーへ落ちる。
   */
  readonly tenantGuardMessage?: string;
}

/**
 * 8 フィールドを検証し、余剰プロパティを落とした防御的コピーを返す。
 *
 * 検証順序は internalId → workingName → displayName → publishName → owner →
 * (tenant guard) → tenant.tenantId → tenant.workspaceId → version → state で、
 * 統合前の全 BC の順序と一致する(ゴールデンテストが internalId 先頭を固定)。
 */
export function validatePublishableMetadata<Id extends string, V>(
  metadata: PublishableMetadata<Id, V>,
  prefix: string,
  options: ValidatePublishableMetadataOptions,
): PublishableMetadata<Id, V> {
  const { fail, isVersion } = options;
  const nonEmptyOptions = { trim: options.trim ?? true };
  assertNonEmpty(metadata?.internalId, `${prefix}: metadata.internalId`, fail, nonEmptyOptions);
  assertNonEmpty(metadata.workingName, `${prefix}: metadata.workingName`, fail, nonEmptyOptions);
  assertNonEmpty(metadata.displayName, `${prefix}: metadata.displayName`, fail, nonEmptyOptions);
  assertNonEmpty(metadata.publishName, `${prefix}: metadata.publishName`, fail, nonEmptyOptions);
  assertNonEmpty(metadata.owner, `${prefix}: metadata.owner`, fail, nonEmptyOptions);
  if (options.tenantGuardMessage !== undefined && (metadata.tenant === null || typeof metadata.tenant !== 'object')) {
    throw fail(options.tenantGuardMessage);
  }
  assertNonEmpty(metadata.tenant?.tenantId, `${prefix}: metadata.tenant.tenantId`, fail, nonEmptyOptions);
  assertNonEmpty(metadata.tenant?.workspaceId, `${prefix}: metadata.tenant.workspaceId`, fail, nonEmptyOptions);
  if (!isVersion(metadata.version)) {
    throw fail(`${prefix}: metadata.version must be a SemVer instance`);
  }
  if (!isPublishState(metadata.state)) {
    throw fail(`${prefix}: invalid state: ${String(metadata.state)}`);
  }
  return {
    internalId: metadata.internalId,
    workingName: metadata.workingName,
    displayName: metadata.displayName,
    publishName: metadata.publishName,
    version: metadata.version,
    owner: metadata.owner,
    state: metadata.state,
    tenant: { tenantId: metadata.tenant.tenantId, workspaceId: metadata.tenant.workspaceId },
  };
}

/** 永続化 JSON 上のメタデータ表現(境界はプリミティブ — ADR-0035)。 */
export interface SerializedPublishableMetadata {
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: string;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: { readonly tenantId: string; readonly workspaceId: string };
}

/** 保存済み JSON の構造検証用スキーマ断片(各 BC の serialization.ts が参照)。 */
export const serializedPublishableMetadataSchema = z.object({
  internalId: z.string(),
  workingName: z.string(),
  displayName: z.string(),
  publishName: z.string(),
  version: z.string(),
  owner: z.string(),
  state: z.enum(PUBLISH_STATES as [PublishState, ...PublishState[]]),
  tenant: z.object({ tenantId: z.string(), workspaceId: z.string() }),
});

/** ドメインのメタデータを永続化表現へ写す(version は toString、tenant は複製)。 */
export function serializePublishableMetadata(
  metadata: PublishableMetadata<string, { toString(): string }>,
): SerializedPublishableMetadata {
  return {
    internalId: metadata.internalId,
    workingName: metadata.workingName,
    displayName: metadata.displayName,
    publishName: metadata.publishName,
    version: metadata.version.toString(),
    owner: metadata.owner,
    state: metadata.state,
    tenant: { tenantId: metadata.tenant.tenantId, workspaceId: metadata.tenant.workspaceId },
  };
}

/** 永続化表現からドメインのメタデータへ写す(version の解釈は parseVersion に委ねる)。 */
export function deserializePublishableMetadata<V>(
  metadata: SerializedPublishableMetadata,
  parseVersion: (text: string) => V,
): PublishableMetadata<string, V> {
  return {
    internalId: metadata.internalId,
    workingName: metadata.workingName,
    displayName: metadata.displayName,
    publishName: metadata.publishName,
    version: parseVersion(metadata.version),
    owner: metadata.owner,
    state: metadata.state,
    tenant: { tenantId: metadata.tenant.tenantId, workspaceId: metadata.tenant.workspaceId },
  };
}
