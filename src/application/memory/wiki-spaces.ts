import type { TenantScope } from '../../domain/tool/ids';
import { WikiSpaceNotFoundError } from '../../domain/memory/errors';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { createWikiSpace, reviseWikiSpace, type WikiSpace, type WikiSpaceSummary } from '../../domain/memory/wiki-space';

export class SaveWikiSpaceUseCase {
  constructor(private readonly wiki: WikiRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(input: { readonly scope: TenantScope; readonly id: string; readonly name: string; readonly description?: string }): Promise<WikiSpace> {
    const timestamp = this.now().toISOString();
    const existing = await this.wiki.findSpace(input.scope, input.id);
    const space = existing === null
      ? createWikiSpace({ id: input.id, tenant: input.scope, name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), createdAt: timestamp })
      : reviseWikiSpace(existing, { name: input.name, ...(input.description !== undefined ? { description: input.description } : {}), updatedAt: timestamp });
    await this.wiki.saveSpace(space);
    return space;
  }
}

export class QueryWikiSpacesUseCase {
  constructor(private readonly wiki: WikiRepository) {}
  async list(scope: TenantScope): Promise<WikiSpaceSummary[]> { return this.wiki.listSpaces(scope); }
  async get(scope: TenantScope, id: string): Promise<WikiSpace> {
    const space = await this.wiki.findSpace(scope, id);
    if (space === null) throw new WikiSpaceNotFoundError(`QueryWikiSpaces: wiki not found: ${id}`);
    return space;
  }
}
