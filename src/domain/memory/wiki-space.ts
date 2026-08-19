import { assertNonEmpty } from '../shared/assert';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../tool/ids';
import { MemoryDomainError } from './errors';
import type { WikiSpaceId } from './ids';

export const DEFAULT_WIKI_ID = 'default';

export interface WikiSpace {
  readonly id: WikiSpaceId;
  readonly tenant: TenantScope;
  readonly name: string;
  readonly description: string;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}

export interface WikiSpaceSummary {
  readonly id: WikiSpaceId;
  readonly name: string;
  readonly description: string;
  readonly updatedAt: IsoDateTime;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, `WikiSpace: ${field}`, (m) => new MemoryDomainError(m));
}

export function createWikiSpace(props: { readonly id: WikiSpaceId; readonly tenant: TenantScope; readonly name: string; readonly description?: string; readonly createdAt: IsoDateTime }): WikiSpace {
  nonEmpty(props.id, 'id'); nonEmpty(props.tenant?.tenantId, 'tenant.tenantId'); nonEmpty(props.tenant?.workspaceId, 'tenant.workspaceId'); nonEmpty(props.name, 'name'); nonEmpty(props.createdAt, 'createdAt');
  return { id: props.id.trim(), tenant: { ...props.tenant }, name: props.name.trim(), description: props.description?.trim() ?? '', createdAt: props.createdAt, updatedAt: props.createdAt };
}

export function reviseWikiSpace(space: WikiSpace, changes: { readonly name: string; readonly description?: string; readonly updatedAt: IsoDateTime }): WikiSpace {
  nonEmpty(changes.name, 'name'); nonEmpty(changes.updatedAt, 'updatedAt');
  return { ...space, name: changes.name.trim(), description: changes.description?.trim() ?? '', updatedAt: changes.updatedAt };
}

export function summarizeWikiSpace(space: WikiSpace): WikiSpaceSummary {
  return { id: space.id, name: space.name, description: space.description, updatedAt: space.updatedAt };
}

