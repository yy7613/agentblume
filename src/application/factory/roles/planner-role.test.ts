import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../../adapters/model/scripted-model-provider';
import { DEFAULT_FACTORY_OPTIONS, type FactoryGoalInput } from '../../../domain/factory/factory-run';
import type { ModelCapability, ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../../model/model-provider';
import type { DataProfile } from '../profile-data-sources';
import type { ExistingToolCatalog } from '../tool-catalog';
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

const existingTools: ExistingToolCatalog = {
  entries: [
    {
      internalId: 'builtin-current-datetime', latestVersion: '1.0.0', publishName: 'current_datetime', displayName: 'Current Datetime',
      toolName: 'current_datetime', description: 'Returns the current date and time.', inputs: [], sideEffect: 'read-only', owner: 'builtin',
    },
  ],
  totalCount: 23,
};

/** 既存の `current_datetime` を再利用し、新規Toolを1件だけ作る計画。 */
function reusePlanJson(internalId = 'builtin-current-datetime'): string {
  return JSON.stringify({
    agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
    tools: [
      { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
      { key: 'today', displayName: 'Current Datetime', purpose: 'Know what "this month" means.', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId, rationale: 'builtin tool already returns now/date/yearMonth' } },
    ],
    skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup', 'today'] }],
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

  it('既存ツールカタログをプロンプトへ載せ、「新規作成の前に再利用を検討する」よう指示する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });

    // 再利用の思考ステップはsystem命令側（データではなく指示）。
    const systemMessage = String(model.requests[0]?.messages.find((message) => message.role === 'system')?.content);
    expect(systemMessage).toContain('Reuse before creating');
    expect(systemMessage).toContain('reuse.internalId');
    expect(systemMessage).toContain('current_datetime');
    // カタログ自体（利用者が書いた表示名・説明を含む）はuntrusted data側へ隔離する。
    const userMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(userMessage).toContain('builtin-current-datetime');
    expect(userMessage).toContain('Returns the current date and time.');
    // 上限で切り捨てた分は件数だけ伝える。
    expect(userMessage).toContain('existingToolsOmitted');
  });

  it('reuse付きの計画をそのままパースする（dataSourceId空でも再利用計画なら通る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    const plan = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });

    expect(plan.tools).toHaveLength(2);
    expect(plan.tools[0]?.reuse).toBeUndefined();
    expect(plan.tools[1]?.reuse).toEqual({ internalId: 'builtin-current-datetime', rationale: 'builtin tool already returns now/date/yearMonth' });
  });

  it('カタログ未指定でも従来どおり計画できる（existingToolsは空配列として渡る）', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: validPlanJson() }, finishReason: 'stop' });
    const role = new PlannerRole(model);

    await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS });

    const userMessage = String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content);
    expect(userMessage).toContain('"existingTools":[]');
    expect(userMessage).not.toContain('existingToolsOmitted');
  });

  it('空のreuse(internalId空)は「reuse指定なし」へ正規化する — strictモデルがoptionalを埋める実測ケース', async () => {
    // 実測: gemmaは再利用しないツールにも reuse: {internalId: ''} を埋めて計画全体を落としていた。
    const plan = JSON.parse(reusePlanJson()) as { tools: Record<string, unknown>[] };
    plan.tools[0] = { ...plan.tools[0], reuse: { internalId: '', rationale: '' } };
    plan.tools[1] = { ...plan.tools[1], reuse: { internalId: 'builtin-current-datetime', rationale: 'keep' } };
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify(plan) }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    const parsed = await role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools });
    expect(parsed.tools[0]?.reuse).toBeUndefined();
    expect(parsed.tools[1]?.reuse).toEqual({ internalId: 'builtin-current-datetime', rationale: 'keep' });
  });

  it('空のreuseを剥がした結果dataSourceIdが空なら、dataSourceIdエラーとして拒否する', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: reusePlanJson('  ') }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS, existingTools })).rejects.toThrow(/dataSourceId/);
  });

  it('壊れたJSONはFactoryValidationErrorになる', async () => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(/invalid JSON/);
  });

  it.each([
    ['空応答', null, /empty content/],
    ['JSON配列', '[]', /not a JSON object/],
    ['agentBrief欠落', '{"tools":[],"skills":[],"personas":[],"scenarios":[]}', /missing agentBrief/],
    ['計画コレクション欠落', '{"agentBrief":{"displayName":"a","role":"b"}}', /missing tools\/skills\/personas\/scenarios/],
  ] as const)('構造化出力が計画の形をしていない場合（%s）はFactoryValidationErrorになる', async (_label, content, expected) => {
    const model = new ScriptedModelProvider();
    model.enqueue({ message: { role: 'assistant', content }, finishReason: 'stop' });
    const role = new PlannerRole(model);
    await expect(role.propose({ goal, profiles, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS })).rejects.toThrow(expected);
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
