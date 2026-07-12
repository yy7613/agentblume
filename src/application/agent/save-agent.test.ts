import { describe, expect, it } from 'vitest';
import { createAgent, type Agent } from '../../domain/agent/agent';
import type { AgentRepository, AgentSummary } from '../../domain/agent/agent-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { SaveAgentUseCase } from './save-agent';
import type { WikiRepository } from '../../domain/memory/wiki-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const v = SemVer.of(1, 0, 0);
function agentMeta(id: string, publishName = id) {
  return { internalId: id, workingName: id, displayName: id, publishName, version: v, owner: 'owner', state: 'draft' as const, tenant: scope };
}
function leaf(id: string, publishName = id): Agent {
  return createAgent({ metadata: agentMeta(id, publishName), kind: 'normal', systemPrompt: 'x', tools: [] });
}
class MapAgents implements AgentRepository {
  readonly saved: Agent[] = [];
  constructor(private readonly byId = new Map<string, Agent>()) {}
  async save(agent: Agent): Promise<void> { this.saved.push(agent); this.byId.set(agent.metadata.internalId, agent); }
  async findVersion(_s: TenantScope, id: string): Promise<Agent | null> { return this.byId.get(id) ?? null; }
  async findLatest(_s: TenantScope, id: string): Promise<Agent | null> { return this.byId.get(id) ?? null; }
  async listVersions(): Promise<SemVer[]> { return []; }
  async list(): Promise<AgentSummary[]> { return []; }
}
const noTools = { async save() {}, async findVersion() { return null; }, async findLatest() { return null; }, async listVersions() { return []; }, async list() { return []; } } as unknown as ToolRepository;
const rootInput = { scope, internalId: 'root', workingName: 'r', displayName: 'R', publishName: 'root', owner: 'owner', kind: 'normal' as const, systemPrompt: 'Delegate.', tools: [] };

describe('SaveAgentUseCase sub-agents', () => {
  it('存在するサブエージェント参照を検証して保存する', async () => {
    const agents = new MapAgents(new Map([['sub', leaf('sub', 'sub_pub')]]));
    const saved = await new SaveAgentUseCase(agents, noTools).execute({ ...rootInput, agents: [{ internalId: 'sub', version: v, usage: 'delegate scoring' }] });
    expect(saved.agents).toEqual([{ internalId: 'sub', version: v, usage: 'delegate scoring' }]);
    expect(agents.saved).toHaveLength(1);
  });

  it('存在しないサブエージェント参照を拒否する', async () => {
    await expect(new SaveAgentUseCase(new MapAgents(), noTools).execute({ ...rootInput, agents: [{ internalId: 'ghost', version: v, usage: 'x' }] }))
      .rejects.toThrow(/SaveAgent:.*sub-agent not found/);
  });

  it('公開名が同じ2サブ（ask_名衝突）を拒否する', async () => {
    const agents = new MapAgents(new Map([['a', leaf('a', 'dup')], ['b', leaf('b', 'dup')]]));
    await expect(new SaveAgentUseCase(agents, noTools).execute({ ...rootInput, agents: [{ internalId: 'a', version: v, usage: 'x' }, { internalId: 'b', version: v, usage: 'y' }] }))
      .rejects.toThrow(/SaveAgent:.*collides/);
  });

  it('存在するWiki allowlistをAgent版へ保存し、未知Wikiを拒否する', async () => {
    const wiki = { findSpace: async (_scope: TenantScope, id: string) => id === 'customer-a' ? { id, tenant: scope, name: 'Customer A', description: '', createdAt: 'now', updatedAt: 'now' } : null } as unknown as WikiRepository;
    const agents = new MapAgents();
    const saved = await new SaveAgentUseCase(agents, noTools, undefined, wiki).execute({ ...rootInput, wikis: [{ wikiId: 'customer-a' }] });
    expect(saved.wikis).toEqual([{ wikiId: 'customer-a' }]);
    await expect(new SaveAgentUseCase(new MapAgents(), noTools, undefined, wiki).execute({ ...rootInput, wikis: [{ wikiId: 'ghost' }] })).rejects.toThrow(/wiki not found: ghost/);
  });
});
