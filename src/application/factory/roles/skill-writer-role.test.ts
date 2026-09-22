import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bundledPrompts } from '../../../test-support/prompts';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import type { FactorySkillPlan } from '../../../domain/factory/factory-plan';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import { SkillWriterRole, type SkillWriterToolContract } from './skill-writer-role';

const skillPlan: FactorySkillPlan = { key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] };
const toolContracts: readonly SkillWriterToolContract[] = [{ name: 'lookup_sales', description: 'Look up sales rows.' }];

function validProposalJson(): string {
  return JSON.stringify({
    responsibility: 'Summarize sales trends.',
    activationCondition: 'user asks for a summary',
    inputDescription: 'A question about sales.',
    outputDescription: 'A concise summary of sales rows.',
    instructions: 'Use the lookup_sales tool to fetch sales rows, then summarize the trend.',
  });
}

describe('SkillWriterRole', () => {
  it('温度0・厳格な構造化出力でSkill起草を提案する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validProposalJson() }, finishReason: 'stop' });
    const role = new SkillWriterRole(model, bundledPrompts());

    const proposal = await role.propose({ skillPlan, toolContracts });

    expect(proposal.responsibility).toBe('Summarize sales trends.');
    expect(proposal.instructions).toContain('lookup_sales');
    expect(model.requests[0]?.temperature).toBe(0);
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new SkillWriterRole(model, bundledPrompts());
    await expect(role.propose({ skillPlan, toolContracts })).rejects.toThrow(/invalid JSON/);
  });

  it('フィールドを欠く応答はFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ responsibility: 'x' }) }, finishReason: 'stop' });
    const role = new SkillWriterRole(model, bundledPrompts());
    await expect(role.propose({ skillPlan, toolContracts })).rejects.toThrow(/missing string field/);
  });

  it('structured-output capabilityがないモデルは利用不可', async () => {
    const capabilities: readonly ModelCapability[] = ['chat'];
    const model: ModelProviderPort = {
      capabilities: () => capabilities,
      complete: (_request: ModelCompletionRequest, _signal?: AbortSignal): Promise<ModelCompletion> => {
        throw new Error('should not be called');
      },
    };
    const role = new SkillWriterRole(model, bundledPrompts());
    expect(role.available()).toBe(false);
    await expect(role.propose({ skillPlan, toolContracts })).rejects.toThrow(/does not support structured output/);
  });
});

// ---------------------------------------------------------------------------
// 移行の証明（v48 / ADR-0052）: 文を `prompts/factory/skill-writer.md` へ移す**前に**
// 組み立てた system 文を `__fixtures__/*.txt` へ固定してある。一字一句一致する限り等価変換である。
// ---------------------------------------------------------------------------

describe('SkillWriterRole の system 文', () => {
  it('従来どおり: 条件分岐が無いので、常に移行前と一字一句同じ system 文になる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{}' }, finishReason: 'stop' });
    await new SkillWriterRole(model, bundledPrompts()).propose({
      skillPlan: { key: 's', displayName: 'S', responsibility: 'r', activationCondition: 'a', toolKeys: [] },
      toolContracts: [],
    }).catch(() => undefined);

    const system = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(system).toBe(readFileSync(fileURLToPath(new URL('./__fixtures__/skill-writer.txt', import.meta.url)), 'utf8'));
  });
});
