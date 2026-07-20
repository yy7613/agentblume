import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { DEFAULT_FACTORY_OPTIONS, type FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { DataProfile } from '../profile-data-sources';
import { PlannerRole } from './planner-role';

const goal: FactoryGoalInput = { goal: 'Answer sales questions and summarize trends.', language: 'ja' };
const profiles: readonly DataProfile[] = [{
  dataSourceId: 'ds-1', name: 'Sales', kind: 'file',
  columns: [{ name: 'amount', type: 'number', nullable: false }],
  sampleRowCount: 1, sampleRows: [{ amount: 100 }],
}];

function validPlanJson(overrides?: { readonly dataSourceId?: string; readonly sideEffect?: string }): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
    tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: overrides?.dataSourceId ?? 'ds-1', sideEffect: overrides?.sideEffect ?? 'read-only' }],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
    personas: [{ key: 'accountant', archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: 'polite', verbosity: 'normal', language: 'ja' }],
    scenarios: [{ key: 'scenario-1', goal: 'find total sales', personaKey: 'accountant', expectedToolKeys: ['lookup'], maxUserTurns: 3 }],
  });
}

describe('PlannerRole', () => {
  it('温度0・厳格な構造化出力でFactoryPlanを提案し、アプリ側で再検証する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    const plan = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });

    expect(plan.agentBrief.displayName).toBe('Sales Assistant');
    expect(plan.tools).toHaveLength(1);
    expect(model.requests[0]?.temperature).toBe(0);
    expect(model.requests[0]?.responseFormat?.strict).toBe(true);
    // データ値（列名・サンプル行）はuser message側でuntrusted dataとして隔離される。
    const userMessage = model.requests[0]?.messages.find((message) => message.role === 'user');
    expect(String(userMessage?.content)).toContain('<untrusted-data');
    expect(String(userMessage?.content)).toContain('ds-1');
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/invalid JSON/);
  });

  it('入力にないdataSourceIdを参照する計画は拒否する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ dataSourceId: 'ds-unknown' }) }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/unknown data source/);
  });

  it("write副作用のtool計画は拒否する（read-only/session-writeのみ許可）", async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson({ sideEffect: 'write' }) }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/sideEffect must be/);
  });

  it('structured-output capabilityがないモデルは利用不可', async () => {
    const capabilities: readonly ModelCapability[] = ['chat'];
    const model: ModelProviderPort = {
      capabilities: () => capabilities,
      complete: (_request: ModelCompletionRequest, _signal?: AbortSignal): Promise<ModelCompletion> => {
        throw new Error('should not be called');
      },
    };
    const role = new PlannerRole(model);
    expect(role.available()).toBe(false);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/does not support structured output/);
  });
});
