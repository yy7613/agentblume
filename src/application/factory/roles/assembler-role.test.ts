import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import type { FactoryAgentBrief } from '../../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import { AssemblerRole } from './assembler-role';

const goal: FactoryGoalInput = { goal: 'Answer sales questions and summarize trends.', targetUsers: 'accountants', language: 'ja' };
const agentBrief: FactoryAgentBrief = { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' };
const skillGuide = '# Skillガイド\n- summarize@1.0.0: Summarize sales trends.';
const toolUsageGuide = '# Tool使用ガイド\n- lookup_sales@1.0.0: Look up sales rows.';

function validProposalJson(): string {
  return JSON.stringify({
    role: '# Role\nYou are the Sales Assistant, helping accountants understand sales data.',
    rules: '# Extra rules\nAlways cite the rows returned by the lookup tool.',
  });
}

describe('AssemblerRole', () => {
  it('温度0・厳格な構造化出力で役割文・追加規則を提案する（skill/toolガイドは上書きしない）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new AssemblerRole(model);

    const proposal = await role.propose({ goal, agentBrief, skillGuide, toolUsageGuide });

    expect(proposal.role).toContain('Sales Assistant');
    expect(proposal.rules).toContain('lookup tool');
    expect(model.requests[0]?.temperature).toBe(0);
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
    // goal（オペレータ自由記述）はuser message側でuntrusted dataとして隔離される。
    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('<untrusted-data');
    expect(String(userMessage?.content)).toContain('accountants');
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new AssemblerRole(model);
    await expect(role.propose({ goal, agentBrief, skillGuide, toolUsageGuide })).rejects.toThrow(/invalid JSON/);
  });

  it('role/rulesを欠く応答はFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ role: 'x' }) }, finishReason: 'stop' });
    const role = new AssemblerRole(model);
    await expect(role.propose({ goal, agentBrief, skillGuide, toolUsageGuide })).rejects.toThrow(/role\/rules/);
  });

  it('structured-output capabilityがないモデルは利用不可', async () => {
    const capabilities: readonly ModelCapability[] = ['chat'];
    const model: ModelProviderPort = {
      capabilities: () => capabilities,
      complete: (_request: ModelCompletionRequest, _signal?: AbortSignal): Promise<ModelCompletion> => {
        throw new Error('should not be called');
      },
    };
    const role = new AssemblerRole(model);
    expect(role.available()).toBe(false);
    await expect(role.propose({ goal, agentBrief, skillGuide, toolUsageGuide })).rejects.toThrow(/does not support structured output/);
  });
});
