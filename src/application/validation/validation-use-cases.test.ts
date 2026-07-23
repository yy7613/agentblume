import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { PersonaNotFoundError, ScenarioNotFoundError, ScenarioRunNotFoundError, ValidationDomainError } from '../../domain/validation/errors';
import type { Persona } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';
import type { Scenario } from '../../domain/validation/scenario';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import { createScenarioRun, type ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';
import { DEFAULT_SURVEY } from '../../domain/validation/survey';
import { QueryPersonasUseCase } from './query-personas';
import { QueryScenarioRunsUseCase } from './query-scenario-runs';
import { QueryScenariosUseCase } from './query-scenarios';
import { SavePersonaUseCase } from './save-persona';
import { SaveScenarioUseCase } from './save-scenario';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };

function personaInput() {
  return {
    scope, internalId: 'persona-1', workingName: 'p', displayName: 'Novice', publishName: 'novice_user', owner: 'owner',
    archetype: 'novice' as const, knowledgeLevel: 'low' as const, patience: 'mid' as const,
    tone: '丁寧', verbosity: 'normal' as const, language: 'ja' as const,
  };
}

describe('SavePersona / QueryPersonas', () => {
  let saved: Persona[];
  let personas: PersonaRepository;

  beforeEach(() => {
    saved = [];
    personas = {
      save: vi.fn(async (persona: Persona) => { saved.push(persona); }),
      findVersion: vi.fn(async (_scope, id, version) => saved.find((persona) => persona.metadata.internalId === id && persona.metadata.version.equals(version)) ?? null),
      findLatest: vi.fn(async (_scope, id) => saved.filter((persona) => persona.metadata.internalId === id).at(-1) ?? null),
      listVersions: vi.fn(async (_scope, id) => saved.filter((persona) => persona.metadata.internalId === id).map((persona) => persona.metadata.version)),
      list: vi.fn(async () => []), delete: vi.fn(),
    };
  });

  it('初回1.0.0、以降はbump（既定patch）でSemVerを自動更新する', async () => {
    const useCase = new SavePersonaUseCase(personas);
    expect((await useCase.execute(personaInput())).metadata.version.toString()).toBe('1.0.0');
    expect((await useCase.execute(personaInput())).metadata.version.toString()).toBe('1.0.1');
    expect((await useCase.execute({ ...personaInput(), bump: 'major' })).metadata.version.toString()).toBe('2.0.0');
    expect(saved.at(-1)).toMatchObject({ archetype: 'novice', metadata: { state: 'draft' } });
  });

  it('不変条件違反（空tone）は ValidationDomainError で保存しない', async () => {
    await expect(new SavePersonaUseCase(personas).execute({ ...personaInput(), tone: ' ' })).rejects.toBeInstanceOf(ValidationDomainError);
    expect(saved).toHaveLength(0);
  });

  it('get は latest / version 指定で解決し、未存在は PersonaNotFoundError', async () => {
    await new SavePersonaUseCase(personas).execute(personaInput());
    await new SavePersonaUseCase(personas).execute({ ...personaInput(), tone: '事務的' });
    const query = new QueryPersonasUseCase(personas);
    expect((await query.get(scope, 'persona-1')).tone).toBe('事務的');
    expect((await query.get(scope, 'persona-1', SemVer.of(1, 0, 0))).tone).toBe('丁寧');
    expect((await query.versions(scope, 'persona-1')).map(String)).toEqual(['1.0.0', '1.0.1']);
    await expect(query.get(scope, 'missing')).rejects.toBeInstanceOf(PersonaNotFoundError);
    await expect(query.get(scope, 'persona-1', SemVer.of(9, 9, 9))).rejects.toBeInstanceOf(PersonaNotFoundError);
    await query.list(scope);
    expect(personas.list).toHaveBeenCalledWith(scope);
  });
});

describe('SaveScenario / QueryScenarios', () => {
  const agentVersion = SemVer.of(1, 0, 0);
  const personaVersion = SemVer.of(1, 0, 0);
  let saved: Scenario[];
  let scenarios: ScenarioRepository;
  let agents: AgentRepository;
  let personas: PersonaRepository;

  beforeEach(() => {
    saved = [];
    scenarios = {
      save: vi.fn(async (scenario: Scenario) => { saved.push(scenario); }),
      findVersion: vi.fn(async (_scope, id, version) => saved.find((scenario) => scenario.metadata.internalId === id && scenario.metadata.version.equals(version)) ?? null),
      findLatest: vi.fn(async (_scope, id) => saved.filter((scenario) => scenario.metadata.internalId === id).at(-1) ?? null),
      listVersions: vi.fn(async (_scope, id) => saved.filter((scenario) => scenario.metadata.internalId === id).map((scenario) => scenario.metadata.version)),
      list: vi.fn(async () => []), delete: vi.fn(),
    };
    agents = {
      save: vi.fn(), findLatest: vi.fn(), listVersions: vi.fn(), list: vi.fn(), delete: vi.fn(),
      findVersion: vi.fn(async (_scope, id, version) => (id === 'agent-1' && version.equals(agentVersion) ? ({} as Agent) : null)),
    };
    personas = {
      save: vi.fn(), findLatest: vi.fn(), listVersions: vi.fn(), list: vi.fn(), delete: vi.fn(),
      findVersion: vi.fn(async (_scope, id, version) => (id === 'persona-1' && version.equals(personaVersion) ? ({} as Persona) : null)),
    };
  });

  function scenarioInput() {
    return {
      scope, internalId: 'scenario-1', workingName: 's', displayName: 'Scenario', publishName: 'scenario_one', owner: 'owner',
      target: { agentId: 'agent-1', version: agentVersion },
      persona: { personaId: 'persona-1', version: personaVersion },
      goal: '売上サマリを得る', maxUserTurns: 4, survey: DEFAULT_SURVEY,
    };
  }

  it('参照整合を検証し、初回1.0.0・bumpで保存する', async () => {
    const useCase = new SaveScenarioUseCase(scenarios, agents, personas);
    expect((await useCase.execute(scenarioInput())).metadata.version.toString()).toBe('1.0.0');
    expect((await useCase.execute({ ...scenarioInput(), bump: 'minor' })).metadata.version.toString()).toBe('1.1.0');
    expect(saved.at(-1)?.survey).toHaveLength(8);
  });

  it('未存在のAgent版・Persona版は ValidationDomainError で拒否する', async () => {
    const useCase = new SaveScenarioUseCase(scenarios, agents, personas);
    await expect(useCase.execute({ ...scenarioInput(), target: { agentId: 'missing', version: agentVersion } }))
      .rejects.toBeInstanceOf(ValidationDomainError);
    await expect(useCase.execute({ ...scenarioInput(), target: { agentId: 'agent-1', version: SemVer.of(9, 0, 0) } }))
      .rejects.toBeInstanceOf(ValidationDomainError);
    await expect(useCase.execute({ ...scenarioInput(), persona: { personaId: 'missing', version: personaVersion } }))
      .rejects.toBeInstanceOf(ValidationDomainError);
    expect(saved).toHaveLength(0);
  });

  it('get は latest / version 指定で解決し、未存在は ScenarioNotFoundError', async () => {
    await new SaveScenarioUseCase(scenarios, agents, personas).execute(scenarioInput());
    const query = new QueryScenariosUseCase(scenarios);
    expect((await query.get(scope, 'scenario-1')).goal).toBe('売上サマリを得る');
    expect((await query.get(scope, 'scenario-1', SemVer.of(1, 0, 0))).metadata.version.toString()).toBe('1.0.0');
    expect((await query.versions(scope, 'scenario-1')).map(String)).toEqual(['1.0.0']);
    await expect(query.get(scope, 'missing')).rejects.toBeInstanceOf(ScenarioNotFoundError);
    await query.list(scope);
    expect(scenarios.list).toHaveBeenCalledWith(scope);
  });
});

describe('QueryScenarioRuns', () => {
  const run = createScenarioRun({
    id: 'run-1', scope, scenario: { id: 'scenario-1', version: SemVer.of(1, 0, 0) },
    status: 'completed', goalAchieved: true, transcript: [], survey: [], impressions: '',
    metrics: { userTurns: 0, agentRuns: 0, totalToolCalls: 0, durationMs: 0, usage: {} },
    startedAt: '2026-07-01T00:00:00.000Z', finishedAt: '2026-07-01T00:00:00.000Z',
  });
  const repo: ScenarioRunRepository = {
    save: vi.fn(),
    find: vi.fn(async (_scope: TenantScope, id: string): Promise<ScenarioRun | null> => (id === 'run-1' ? run : null)),
    list: vi.fn(async () => [run]),
  };

  it('list を委譲し、get の未存在は ScenarioRunNotFoundError', async () => {
    const query = new QueryScenarioRunsUseCase(repo);
    expect(await query.list(scope, { scenarioId: 'scenario-1' })).toEqual([run]);
    expect(repo.list).toHaveBeenCalledWith(scope, { scenarioId: 'scenario-1' });
    expect(await query.get(scope, 'run-1')).toEqual(run);
    await expect(query.get(scope, 'missing')).rejects.toBeInstanceOf(ScenarioRunNotFoundError);
  });
});
