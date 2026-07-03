import { describe, expect, it } from 'vitest';
import { SemVer } from '../tool/semver';
import { createAgent } from './agent';
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

  it('空system prompt、重複Tool、不正serialized dataを拒否する', () => {
    expect(() => createAgent({ ...valid(), systemPrompt: ' ' })).toThrow(AgentValidationError);
    const ref = { internalId: 'tool-1', version: SemVer.of(1, 0, 0) };
    expect(() => createAgent({ ...valid(), tools: [ref, ref] })).toThrow(/duplicate tool/);
    expect(() => deserializeAgent({ nope: true })).toThrow(AgentValidationError);
  });
});
