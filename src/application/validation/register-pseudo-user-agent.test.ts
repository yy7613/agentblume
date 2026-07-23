import { describe, expect, it } from 'vitest';
import type { Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import type { TenantScope } from '../../domain/tool/ids';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { SemVer } from '../../domain/tool/semver';
import { PersonaNotFoundError } from '../../domain/validation/errors';
import { buildPersonaBasePrompt, createPersona, type Persona } from '../../domain/validation/persona';
import type { PersonaRepository, PersonaSummary } from '../../domain/validation/persona-repository';
import { SaveAgentUseCase } from '../agent/save-agent';
import { RegisterPseudoUserAgentUseCase } from './register-pseudo-user-agent';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
const v1 = SemVer.of(1, 0, 0);
function makePersona(): Persona {
  return createPersona({ metadata: { internalId: 'novice', workingName: 'p', displayName: 'Novice User', publishName: 'novice_user', version: v1, owner: 'owner', state: 'draft', tenant: scope }, archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja' });
}
class MapAgents implements AgentRepository {
  readonly byId = new Map<string, Agent>();
  private readonly versionsById = new Map<string, SemVer[]>();
  async save(agent: Agent): Promise<void> {
    this.byId.set(agent.metadata.internalId, agent);
    this.versionsById.set(agent.metadata.internalId, [...(this.versionsById.get(agent.metadata.internalId) ?? []), agent.metadata.version]);
  }
  async findVersion(_s: TenantScope, id: string, version: SemVer): Promise<Agent | null> { const a = this.byId.get(id); return a !== undefined && a.metadata.version.equals(version) ? a : null; }
  async findLatest(_s: TenantScope, id: string): Promise<Agent | null> { return this.byId.get(id) ?? null; }
  async listVersions(_s: TenantScope, id: string): Promise<SemVer[]> { return this.versionsById.get(id) ?? []; }
  async list(): Promise<AgentSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}
const noTools = { async save() {}, async findVersion() { return null; }, async findLatest() { return null; }, async listVersions() { return []; }, async list() { return []; } } as unknown as ToolRepository;
class StaticPersonas implements PersonaRepository {
  constructor(private readonly persona: Persona | null) {}
  async save(): Promise<void> {}
  async findVersion(): Promise<Persona | null> { return this.persona; }
  async findLatest(): Promise<Persona | null> { return this.persona; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<PersonaSummary[]> { return []; }
  async delete(): Promise<boolean> { return false; }
}

function useCase(persona: Persona | null, agents = new MapAgents()) {
  return { uc: new RegisterPseudoUserAgentUseCase(new StaticPersonas(persona), new SaveAgentUseCase(agents, noTools)), agents };
}

describe('RegisterPseudoUserAgentUseCase', () => {
  it('Personaの基底プロンプトから能力を持たないpseudo-user Agentを登録する', async () => {
    const persona = makePersona();
    const { uc } = useCase(persona);
    const agent = await uc.execute({ scope, personaId: 'novice' });
    expect(agent.kind).toBe('pseudo-user');
    expect(agent.metadata.internalId).toBe('pseudo-novice');
    expect(agent.persona).toEqual({ personaId: 'novice', version: v1 });
    expect(agent.tools).toEqual([]);
    expect(agent.systemPrompt).toBe(buildPersonaBasePrompt(persona));
    expect(agent.metadata.version.toString()).toBe('1.0.0');
  });

  it('再登録はバージョンをbumpする', async () => {
    const { uc } = useCase(makePersona());
    await uc.execute({ scope, personaId: 'novice' });
    const second = await uc.execute({ scope, personaId: 'novice', bump: 'minor' });
    expect(second.metadata.version.toString()).toBe('1.1.0');
  });

  it('promptOverrideを基底プロンプトの代わりに使う', async () => {
    const { uc } = useCase(makePersona());
    const agent = await uc.execute({ scope, personaId: 'novice', promptOverride: '固定の疑似ユーザー設定。' });
    expect(agent.systemPrompt).toBe('固定の疑似ユーザー設定。');
  });

  it('Persona未存在を拒否する', async () => {
    const { uc } = useCase(null);
    await expect(uc.execute({ scope, personaId: 'ghost' })).rejects.toBeInstanceOf(PersonaNotFoundError);
  });
});
