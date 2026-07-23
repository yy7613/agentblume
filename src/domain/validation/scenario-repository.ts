import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { Scenario } from './scenario';

export interface ScenarioSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly state: PublishState;
}

export interface ScenarioRepository {
  save(scenario: Scenario): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Scenario | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<Scenario | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<ScenarioSummary[]>;
  /**
   * 論理削除。list/findLatestからは除外し、listVersionsは空配列を返す。
   * findVersionは削除後も既存versionを返し続ける(既存の参照ScenarioRunを壊さないため)。
   * 戻り値は削除前に存在したか(既に削除済み/未存在なら false)。
   */
  delete(scope: TenantScope, internalId: string): Promise<boolean>;
}
