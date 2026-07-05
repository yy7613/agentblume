import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { ValidationDomainError } from '../../domain/validation/errors';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import { createScenario, type Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import type { SurveyQuestion } from '../../domain/validation/survey';

export interface SaveScenarioInput {
  readonly scope: TenantScope; readonly internalId: string; readonly workingName: string; readonly displayName: string;
  readonly publishName: string; readonly owner: string;
  readonly target: { readonly agentId: string; readonly version: SemVer };
  readonly persona: { readonly personaId: string; readonly version: SemVer };
  readonly goal: string;
  readonly context?: string;
  readonly maxUserTurns: number;
  readonly expectedTools?: readonly string[];
  readonly survey: readonly SurveyQuestion[];
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

export class SaveScenarioUseCase {
  constructor(
    private readonly scenarios: ScenarioRepository,
    private readonly agents: AgentRepository,
    private readonly personas: PersonaRepository,
  ) {}

  async execute(input: SaveScenarioInput): Promise<Scenario> {
    // 参照整合: 対象Agent版と Persona 版の存在を保存前に確認する。
    if (await this.agents.findVersion(input.scope, input.target.agentId, input.target.version) === null) {
      throw new ValidationDomainError(`SaveScenario: target agent not found: ${input.target.agentId}@${input.target.version.toString()}`);
    }
    if (await this.personas.findVersion(input.scope, input.persona.personaId, input.persona.version) === null) {
      throw new ValidationDomainError(`SaveScenario: persona not found: ${input.persona.personaId}@${input.persona.version.toString()}`);
    }
    const versions = await this.scenarios.listVersions(input.scope, input.internalId);
    const version = versions.length === 0
      ? SemVer.of(1, 0, 0)
      : versions.reduce((max, item) => (item.compare(max) > 0 ? item : max)).bump(input.bump ?? 'patch');
    const scenario = createScenario({
      metadata: {
        internalId: input.internalId, workingName: input.workingName, displayName: input.displayName,
        publishName: input.publishName, version, owner: input.owner, state: input.state ?? 'draft', tenant: input.scope,
      },
      target: { agentId: input.target.agentId, version: input.target.version },
      persona: { personaId: input.persona.personaId, version: input.persona.version },
      goal: input.goal,
      ...(input.context !== undefined ? { context: input.context } : {}),
      maxUserTurns: input.maxUserTurns,
      ...(input.expectedTools !== undefined ? { expectedTools: input.expectedTools } : {}),
      survey: input.survey,
    });
    await this.scenarios.save(scenario);
    return scenario;
  }
}
