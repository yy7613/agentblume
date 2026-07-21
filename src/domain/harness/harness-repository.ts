import type { PublishState } from '../tool/metadata';
import type { TenantScope } from '../tool/ids';
import type { SemVer } from '../tool/semver';
import type { AgentHarness, HarnessPattern } from './agent-harness';

export interface HarnessSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly pattern: HarnessPattern;
  readonly state: PublishState;
}
export interface AgentHarnessRepository {
  save(harness: AgentHarness): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<AgentHarness | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<AgentHarness | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<HarnessSummary[]>;
  /**
   * 論理削除（docs/14-agent-harness-builder.md §10）: 参照Runを壊さないため findVersion は削除後も返す。
   * list/findLatest からは除外し、listVersions は空配列を返す。戻り値は削除前に存在したか（既に削除済み/未存在なら false）。
   */
  delete(scope: TenantScope, internalId: string): Promise<boolean>;
}
