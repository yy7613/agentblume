/**
 * ドメイン: Tool メタデータ型（v2 実装契約 §6）— 型のみ。
 *
 * PublishState 一族と共通メタデータ形状は shared/publishable.ts へ実体移設した(ADR-0036)。
 * 既存 import の互換のためここから再エクスポートする。SideEffect 系は Tool 固有なので残置。
 */
import type { PublishableMetadata, PublishState } from '../shared/publishable';
import type { ToolId } from './ids';
import type { SemVer } from './semver';

export type { PublishState } from '../shared/publishable';
export { PUBLISH_STATES, isPublishState } from '../shared/publishable';

/** Tool の副作用分類。 */
export type SideEffect = 'read-only' | 'session-write' | 'write' | 'external-action';

/** Tool の識別・公開・所有情報。 */
export type ToolMetadata = PublishableMetadata<ToolId, SemVer>;

/** 一覧表示用の要約（internalId ごとの最新）。 */
export interface ToolSummary {
  readonly internalId: ToolId;
  readonly publishName: string;
  readonly displayName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
  readonly sideEffect: SideEffect;
}

/** 有効な SideEffect の集合（実行時検証用）。 */
export const SIDE_EFFECTS: readonly SideEffect[] = ['read-only', 'session-write', 'write', 'external-action'];

/** 値が SideEffect か判定する型ガード。 */
export function isSideEffect(value: unknown): value is SideEffect {
  return typeof value === 'string' && (SIDE_EFFECTS as readonly string[]).includes(value);
}
