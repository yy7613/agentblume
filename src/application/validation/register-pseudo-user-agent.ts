/**
 * application層: Persona を kind==='pseudo-user' の Agent として登録する（v18 実装契約 §2.1）。
 *
 * Persona の基底プロンプト（goal/context を含まない buildPersonaBasePrompt）を systemPrompt とし、
 * 能力（tools/skills/agents）を持たない Agent として既存 SaveAgentUseCase で保存する。
 * 同 internalId が既にあればバージョンを bump する（SaveAgentUseCase の版採番に委譲）。
 */
import type { Agent } from '../../domain/agent/agent';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import { PersonaNotFoundError } from '../../domain/validation/errors';
import { buildPersonaBasePrompt } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import type { SaveAgentUseCase } from '../agent/save-agent';

export interface RegisterPseudoUserAgentInput {
  readonly scope: TenantScope;
  readonly personaId: string;
  /** 省略時は latest。 */
  readonly personaVersion?: SemVer;
  /** 省略時は `pseudo-${personaId}`。 */
  readonly agentInternalId?: string;
  readonly bump?: 'major' | 'minor' | 'patch';
  /** 生成される基底プロンプトの上書き（エスケープハッチ）。 */
  readonly promptOverride?: string;
}

export class RegisterPseudoUserAgentUseCase {
  constructor(private readonly personas: PersonaRepository, private readonly saveAgent: SaveAgentUseCase) {}

  async execute(input: RegisterPseudoUserAgentInput): Promise<Agent> {
    const persona = input.personaVersion === undefined
      ? await this.personas.findLatest(input.scope, input.personaId)
      : await this.personas.findVersion(input.scope, input.personaId, input.personaVersion);
    if (persona === null) {
      throw new PersonaNotFoundError(`RegisterPseudoUserAgent: persona not found: ${input.personaId}${input.personaVersion === undefined ? '' : `@${input.personaVersion.toString()}`}`);
    }
    const systemPrompt = input.promptOverride !== undefined && input.promptOverride.trim().length > 0
      ? input.promptOverride
      : buildPersonaBasePrompt(persona);
    return this.saveAgent.execute({
      scope: input.scope,
      internalId: input.agentInternalId ?? `pseudo-${persona.metadata.internalId}`,
      workingName: `${persona.metadata.displayName} (pseudo-user)`,
      displayName: persona.metadata.displayName,
      publishName: `${persona.metadata.publishName}_pseudo`,
      owner: persona.metadata.owner,
      kind: 'pseudo-user',
      systemPrompt,
      tools: [],
      persona: { personaId: persona.metadata.internalId, version: persona.metadata.version },
      ...(input.bump !== undefined ? { bump: input.bump } : {}),
    });
  }
}
