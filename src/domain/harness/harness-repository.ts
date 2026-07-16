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
}
