import type { TenantScope } from '../tool/ids';
import { MemoryDomainError } from './errors';

export const DEFAULT_WIKI_ID = 'default';

export interface WikiSpace {
  readonly id: string;
  readonly tenant: TenantScope;
  readonly name: string;
  readonly description: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiSpaceSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly updatedAt: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new MemoryDomainError(`WikiSpace: ${field} must be a non-empty string`);
}

export function createWikiSpace(props: { readonly id: string; readonly tenant: TenantScope; readonly name: string; readonly description?: string; readonly createdAt: string }): WikiSpace {
  nonEmpty(props.id, 'id'); nonEmpty(props.tenant?.tenantId, 'tenant.tenantId'); nonEmpty(props.tenant?.workspaceId, 'tenant.workspaceId'); nonEmpty(props.name, 'name'); nonEmpty(props.createdAt, 'createdAt');
  return { id: props.id.trim(), tenant: { ...props.tenant }, name: props.name.trim(), description: props.description?.trim() ?? '', createdAt: props.createdAt, updatedAt: props.createdAt };
}

export function reviseWikiSpace(space: WikiSpace, changes: { readonly name: string; readonly description?: string; readonly updatedAt: string }): WikiSpace {
  nonEmpty(changes.name, 'name'); nonEmpty(changes.updatedAt, 'updatedAt');
  return { ...space, name: changes.name.trim(), description: changes.description?.trim() ?? '', updatedAt: changes.updatedAt };
}

export function summarizeWikiSpace(space: WikiSpace): WikiSpaceSummary {
  return { id: space.id, name: space.name, description: space.description, updatedAt: space.updatedAt };
}

