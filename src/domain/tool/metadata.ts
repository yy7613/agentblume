/**
 * ドメイン: Tool メタデータ型（v2 実装契約 §6）— 型のみ。
 */
import type { TenantScope, ToolId } from './ids';
import type { SemVer } from './semver';

/** 公開ライフサイクル状態。 */
export type PublishState = 'draft' | 'in-review' | 'published' | 'deprecated' | 'archived';

/** Tool の副作用分類。 */
export type SideEffect = 'read-only' | 'write' | 'external-action';

/** Tool の識別・公開・所有情報。 */
export interface ToolMetadata {
  readonly internalId: ToolId;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly version: SemVer;
  readonly owner: string;
  readonly state: PublishState;
  readonly tenant: TenantScope;
}

/** 一覧表示用の要約（internalId ごとの最新）。 */
export interface ToolSummary {
  readonly internalId: ToolId;
  readonly publishName: string;
  readonly displayName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
}

/** 有効な PublishState の集合（実行時検証用）。 */
export const PUBLISH_STATES: readonly PublishState[] = [
  'draft',
  'in-review',
  'published',
  'deprecated',
  'archived',
];

/** 有効な SideEffect の集合（実行時検証用）。 */
export const SIDE_EFFECTS: readonly SideEffect[] = ['read-only', 'write', 'external-action'];

/** 値が PublishState か判定する型ガード。 */
export function isPublishState(value: unknown): value is PublishState {
  return typeof value === 'string' && (PUBLISH_STATES as readonly string[]).includes(value);
}

/** 値が SideEffect か判定する型ガード。 */
export function isSideEffect(value: unknown): value is SideEffect {
  return typeof value === 'string' && (SIDE_EFFECTS as readonly string[]).includes(value);
}
