import type { PersonaId } from '../../domain/validation/ids';
import { createPersona, type Persona, type PersonaArchetype, type PersonaLanguage, type PersonaLevel, type PersonaVerbosity } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';

export interface SavePersonaInput {
  readonly scope: TenantScope; readonly internalId: PersonaId; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string;
  readonly archetype: PersonaArchetype;
  readonly knowledgeLevel: PersonaLevel;
  readonly patience: PersonaLevel;
  readonly tone: string;
  readonly verbosity: PersonaVerbosity;
  readonly language: PersonaLanguage;
  readonly extraInstructions?: string;
  readonly promptOverride?: string;
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

export class SavePersonaUseCase {
  constructor(private readonly personas: PersonaRepository) {}

  async execute(input: SavePersonaInput): Promise<Persona> {
    const versions = await this.personas.listVersions(input.scope, input.internalId);
    const version = versions.length === 0
      ? SemVer.of(1, 0, 0)
      : versions.reduce((max, item) => (item.compare(max) > 0 ? item : max)).bump(input.bump ?? 'patch');
    const persona = createPersona({
      metadata: {
        internalId: input.internalId, workingName: input.workingName, displayName: input.displayName,
        publishName: input.publishName, version, owner: input.owner, state: input.state ?? 'draft', tenant: input.scope,
      },
      archetype: input.archetype,
      knowledgeLevel: input.knowledgeLevel,
      patience: input.patience,
      tone: input.tone,
      verbosity: input.verbosity,
      language: input.language,
      ...(input.extraInstructions !== undefined ? { extraInstructions: input.extraInstructions } : {}),
      ...(input.promptOverride !== undefined ? { promptOverride: input.promptOverride } : {}),
    });
    await this.personas.save(persona);
    return persona;
  }
}
