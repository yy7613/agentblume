import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { Agent, AgentKind } from './agent';
import type { AgentId } from './ids';

export interface AgentSummary {
  readonly internalId: AgentId;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly kind: AgentKind;
  readonly state: PublishState;
}

export interface AgentRepository {
  save(agent: Agent): Promise<void>;
  /** Promotion-capable repositories update lifecycle state without creating a new semantic version. */
  updateState?(scope: TenantScope, internalId: AgentId, version: SemVer, state: PublishState): Promise<Agent>;
  findVersion(scope: TenantScope, internalId: AgentId, version: SemVer): Promise<Agent | null>;
  findLatest(scope: TenantScope, internalId: AgentId): Promise<Agent | null>;
  listVersions(scope: TenantScope, internalId: AgentId): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<AgentSummary[]>;
  /**
   * 論理削除: list/findLatestからは除外し、listVersionsは空配列を返す。
   * findVersionは削除後も既存versionを返し続ける（既存の参照Runやpinned versionを壊さないため）。
   * 戻り値は削除前に存在したか（既に削除済み/未存在なら false）。
   */
  delete(scope: TenantScope, internalId: AgentId): Promise<boolean>;
}
