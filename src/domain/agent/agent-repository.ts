import type { TenantScope } from '../tool/ids';
import type { PublishState } from '../tool/metadata';
import type { SemVer } from '../tool/semver';
import type { Agent, AgentKind } from './agent';

export interface AgentSummary {
  readonly internalId: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly latestVersion: SemVer;
  readonly kind: AgentKind;
  readonly state: PublishState;
}

export interface AgentRepository {
  save(agent: Agent): Promise<void>;
  findVersion(scope: TenantScope, internalId: string, version: SemVer): Promise<Agent | null>;
  findLatest(scope: TenantScope, internalId: string): Promise<Agent | null>;
  listVersions(scope: TenantScope, internalId: string): Promise<SemVer[]>;
  list(scope: TenantScope): Promise<AgentSummary[]>;
}
