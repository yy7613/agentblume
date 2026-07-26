import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { createAgent, subAgentToolName, DEFAULT_AGENT_RUNTIME_HARNESS, type AgentRuntimeHarness } from './agent';
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

  it('MCPサーバー参照を直列化往復で維持し、旧dataは未設定として読む（後方互換）', () => {
    const agent = createAgent({ ...valid(), mcpServers: ['files', 'github'] });
    expect(agent.mcpServers).toEqual(['files', 'github']);
    expect(deserializeAgent(serializeAgent(agent)).mcpServers).toEqual(['files', 'github']);
    expect(serializeAgent(deserializeAgent(serializeAgent(agent)))).toEqual(serializeAgent(agent));
    // 未指定・空配列は「MCPツールなし」＝フィールド自体を持たない。
    expect(createAgent(valid()).mcpServers).toBeUndefined();
    expect(createAgent({ ...valid(), mcpServers: [] }).mcpServers).toBeUndefined();
    const legacy = serializeAgent(agent) as unknown as Record<string, unknown>;
    delete legacy['mcpServers'];
    expect(deserializeAgent(legacy).mcpServers).toBeUndefined();
  });

  it('MCPサーバー参照の件数・空文字・長さ・重複を拒否する', () => {
    expect(() => createAgent({ ...valid(), mcpServers: Array.from({ length: 9 }, (_, index) => `s${index}`) })).toThrow(/at most 8 entries/);
    expect(() => createAgent({ ...valid(), mcpServers: [' '] })).toThrow(/mcpServers\.0 must be a non-empty string/);
    expect(() => createAgent({ ...valid(), mcpServers: ['x'.repeat(65)] })).toThrow(/at most 64 characters/);
    expect(() => createAgent({ ...valid(), mcpServers: ['files', 'files'] })).toThrow(/duplicate MCP server reference: files/);
    expect(() => createAgent({ ...valid(), mcpServers: [1 as unknown as string] })).toThrow(AgentValidationError);
    // 前後の空白は取り除いて保存する。
    expect(createAgent({ ...valid(), mcpServers: [' files '] }).mcpServers).toEqual(['files']);
  });

  it('ランタイムハーネス設定を直列化往復で維持し、旧dataは未設定として読む（後方互換）', () => {
    const harness: AgentRuntimeHarness = { ...DEFAULT_AGENT_RUNTIME_HARNESS, fileMemory: true, todoProvider: true, compaction: true, webSearch: true };
    const agent = createAgent({ ...valid(), harness });
    expect(agent.harness).toEqual(harness);
    expect(deserializeAgent(serializeAgent(agent)).harness).toEqual(harness);
    expect(serializeAgent(deserializeAgent(serializeAgent(agent)))).toEqual(serializeAgent(agent));
    // 未指定 = 従来動作（フィールド自体を持たない）。
    expect(createAgent(valid()).harness).toBeUndefined();
    const legacy = serializeAgent(agent) as unknown as Record<string, unknown>;
    delete legacy['harness'];
    expect(deserializeAgent(legacy).harness).toBeUndefined();
    // 既定値は「functionInvocationのみ有効」＝従来動作と等価。
    expect(DEFAULT_AGENT_RUNTIME_HARNESS).toEqual({ fileMemory: false, todoProvider: false, compaction: false, webSearch: false, toolApproval: false, functionInvocation: true });
  });

  it('ランタイムハーネスのboolean以外のフィールドを拒否する', () => {
    const broken = { ...DEFAULT_AGENT_RUNTIME_HARNESS, compaction: 'yes' } as unknown as AgentRuntimeHarness;
    expect(() => createAgent({ ...valid(), harness: broken })).toThrow(/harness\.compaction must be a boolean/);
    expect(() => deserializeAgent({ ...serializeAgent(createAgent(valid())), harness: { fileMemory: true } })).toThrow(AgentValidationError);
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
