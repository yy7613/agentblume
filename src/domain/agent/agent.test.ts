import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { createAgent, subAgentToolName } from './agent';
import { AgentValidationError } from './errors';
import { deserializeAgent, serializeAgent } from './serialization';

function valid() {
  return {
    metadata: {
      internalId: 'agent-1', workingName: 'work', displayName: 'Agent', publishName: 'agent',
      version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft' as const,
      tenant: { tenantId: 'tenant', workspaceId: 'workspace' },
    },
    kind: 'normal' as const,
    systemPrompt: 'Use the selected tools.',
    skills: [{ internalId: 'skill-1', version: SemVer.of(1, 3, 0) }],
    tools: [{ internalId: 'tool-1', version: SemVer.of(2, 1, 0) }],
    output: { name: 'agent_response', fields: [{ name: 'answer', type: 'string' as const, required: true }] },
  };
}

describe('Agent aggregate', () => {
  it('生成・serialize・deserializeで値を維持し入力を複製する', () => {
    const input = valid();
    const agent = createAgent(input);
    input.metadata.tenant.tenantId = 'changed';
    expect(agent.metadata.tenant.tenantId).toBe('tenant');
    expect(serializeAgent(deserializeAgent(serializeAgent(agent)))).toEqual(serializeAgent(agent));
    expect(agent.output?.fields[0]?.name).toBe('answer');
  });

  it('空system prompt、重複Skill/Tool、不正serialized dataを拒否する', () => {
    expect(() => createAgent({ ...valid(), systemPrompt: ' ' })).toThrow(AgentValidationError);
    const ref = { internalId: 'tool-1', version: SemVer.of(1, 0, 0) };
    expect(() => createAgent({ ...valid(), tools: [ref, ref] })).toThrow(/duplicate tool/);
    const skill = { internalId: 'skill-1', version: SemVer.of(1, 0, 0) };
    expect(() => createAgent({ ...valid(), skills: [skill, skill] })).toThrow(/duplicate skill/);
    expect(() => deserializeAgent({ nope: true })).toThrow(AgentValidationError);
  });

  it('sub-agent参照を保持し、自己参照・重複internalId・usage空を拒否する', () => {
    const sub = { internalId: 'sub-1', version: SemVer.of(1, 0, 0), usage: 'delegate scoring' };
    const agent = createAgent({ ...valid(), agents: [sub] });
    expect(agent.agents).toEqual([sub]);
    // 直列化往復で agents を維持する。
    expect(serializeAgent(deserializeAgent(serializeAgent(agent)))).toEqual(serializeAgent(agent));
    // 自己参照（自 internalId = 'agent-1'）は拒否。
    expect(() => createAgent({ ...valid(), agents: [{ internalId: 'agent-1', version: SemVer.of(1, 0, 0), usage: 'self' }] })).toThrow(/itself/);
    // 同一 internalId はバージョン違いでも重複。
    expect(() => createAgent({ ...valid(), agents: [sub, { ...sub, version: SemVer.of(2, 0, 0) }] })).toThrow(/duplicate sub-agent/);
    // usage 空は拒否。
    expect(() => createAgent({ ...valid(), agents: [{ ...sub, usage: ' ' }] })).toThrow(AgentValidationError);
  });

  it('agents無しの旧serializedデータを空配列として復元する（後方互換）', () => {
    const legacy = serializeAgent(createAgent(valid())) as unknown as Record<string, unknown>;
    delete legacy['agents'];
    expect(deserializeAgent(legacy).agents).toEqual([]);
  });

  it('Wiki allowlistを直列化し重複を拒否、旧dataは未設定として読む', () => {
    const agent = createAgent({ ...valid(), wikis: [{ wikiId: 'customer-a' }, { wikiId: 'customer-b' }] });
    expect(deserializeAgent(serializeAgent(agent)).wikis).toEqual([{ wikiId: 'customer-a' }, { wikiId: 'customer-b' }]);
    expect(() => createAgent({ ...valid(), wikis: [{ wikiId: 'customer-a' }, { wikiId: 'customer-a' }] })).toThrow(/duplicate wiki/);
    const legacy = serializeAgent(createAgent(valid())) as unknown as Record<string, unknown>; delete legacy['wikis'];
    expect(deserializeAgent(legacy).wikis).toBeUndefined();
  });

  it('subAgentToolNameはask_接頭辞のツール名を返す', () => {
    expect(subAgentToolName('sales_scorer')).toBe('ask_sales_scorer');
  });

  it('pseudo-user Agentはpersona参照を保持し能力を持てない（v18）', () => {
    const persona = { personaId: 'novice', version: SemVer.of(1, 0, 0) };
    const agent = createAgent({ ...valid(), kind: 'pseudo-user', skills: [], tools: [], persona });
    expect(agent.persona).toEqual(persona);
    expect(serializeAgent(deserializeAgent(serializeAgent(agent)))).toEqual(serializeAgent(agent));
    // persona は kind==='pseudo-user' のときのみ許可。
    expect(() => createAgent({ ...valid(), kind: 'normal', persona })).toThrow(/only allowed for kind/);
    // pseudo-user は tools/skills/agents 空必須。
    expect(() => createAgent({ ...valid(), kind: 'pseudo-user', skills: [], tools: [{ internalId: 'tool-1', version: SemVer.of(2, 1, 0) }] })).toThrow(/v18 constraint/);
  });

  it('persona無しの旧serializedデータをundefinedとして復元する（後方互換）', () => {
    const legacy = serializeAgent(createAgent(valid())) as unknown as Record<string, unknown>;
    delete legacy['persona'];
    expect(deserializeAgent(legacy).persona).toBeUndefined();
  });
});
