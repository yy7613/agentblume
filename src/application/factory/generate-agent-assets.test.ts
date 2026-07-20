import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import { SemVer } from '../../domain/tool/semver';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { GenerateAgentAssetsUseCase } from './generate-agent-assets';
import { ProfileDataSourcesUseCase } from './profile-data-sources';
import { AssemblerRole } from './roles/assembler-role';
import { SkillWriterRole } from './roles/skill-writer-role';
import { ToolSmithRole } from './roles/tool-smith-role';

const scope = { tenantId: 't', workspaceId: 'w' };
const goal: FactoryGoalInput = { goal: 'Answer sales questions and summarize trends.', language: 'ja' };

const onePlan: FactoryPlan = {
  agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
  tools: [{ key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
  skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup'] }],
  personas: [],
  scenarios: [],
};

const twoToolPlan: FactoryPlan = {
  agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
  tools: [
    { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
    { key: 'broken', displayName: 'Broken Tool', purpose: 'Always fails to validate.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
  ],
  skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup', 'broken'] }],
  personas: [],
  scenarios: [],
};

function validToolProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

/** select列 'does_not_exist' が存在しないため EtlEngine.propagateSchemas でhasErrors:trueになる不正グラフ。 */
function invalidToolGraphProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'sel', type: 'select', config: { columns: ['does_not_exist'] } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

function validSkillProposalJson(): string {
  return JSON.stringify({
    responsibility: 'Summarize sales trends.',
    activationCondition: 'user asks for a summary',
    inputDescription: 'A question about sales.',
    outputDescription: 'A concise summary of sales rows.',
    instructions: 'Use the lookup_sales tool to fetch sales rows, then summarize the trend.',
  });
}

function validAssemblerProposalJson(): string {
  return JSON.stringify({
    role: '# Role\nYou are the Sales Assistant, helping accountants understand sales data.',
    rules: '# Extra rules\nAlways cite the rows returned by the lookup tool.',
  });
}

async function setup() {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, 'id,amount\n1,100\n2,200');
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  const profiles = await profiler.executeAll(scope, ['ds-1']);

  const model = new ScriptedModelProvider();
  const toolSmith = new ToolSmithRole(model);
  const skillWriter = new SkillWriterRole(model);
  const assembler = new AssemblerRole(model);

  const toolRepo = new InMemoryToolRepository();
  const skillRepo = new InMemorySkillRepository();
  const agentRepo = new InMemoryAgentRepository();
  const saveTool = new SaveToolUseCase(toolRepo, engine, resolver);
  const saveSkill = new SaveSkillUseCase(skillRepo, toolRepo);
  const saveAgent = new SaveAgentUseCase(agentRepo, toolRepo, skillRepo);
  const generateAgentPrompt = new GenerateAgentPromptUseCase(toolRepo, skillRepo, agentRepo);

  const useCase = new GenerateAgentAssetsUseCase(toolSmith, skillWriter, assembler, saveTool, saveSkill, saveAgent, generateAgentPrompt, engine, resolver);
  return { model, toolRepo, skillRepo, agentRepo, profiles, useCase };
}

describe('GenerateAgentAssetsUseCase', () => {
  it('happy path: Tool → Skill → Agent の順にdraftとして保存する（read-only）', async () => {
    const { model, toolRepo, skillRepo, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    expect(result.toolRefs).toHaveLength(1);
    expect(result.skillRefs).toHaveLength(1);
    expect(result.agentRef).toBeDefined();
    expect(result.toolKeyToRef.get('lookup')).toEqual(result.toolRefs[0]);
    expect(result.roleCallsUsed).toBe(3); // tool-smith(1) + skill-writer(1) + assembler(1)

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.metadata.state).toBe('draft');
    expect(tool?.sideEffect).toBe('read-only');
    expect(tool?.agentTool?.name).toBe('lookup_sales');
    expect(result.toolKeyToPublishName.get('lookup')).toBe(tool?.metadata.publishName);

    const skillRef = result.skillRefs[0];
    if (skillRef === undefined) throw new Error('expected a skill ref');
    const skill = await skillRepo.findVersion(scope, skillRef.internalId, SemVer.parse(skillRef.version));
    expect(skill?.metadata.state).toBe('draft');
    expect(skill?.tools).toEqual([{ internalId: toolRef.internalId, version: SemVer.parse(toolRef.version) }]);

    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.metadata.state).toBe('draft');
    expect(agent?.kind).toBe('normal');
    expect(agent?.systemPrompt).toContain('Sales Assistant');
    expect(agent?.systemPrompt).toContain('Always cite the rows');
  });

  it('無効なグラフは修復ループで再提案させ、修正後に保存する', async () => {
    const { model, toolRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: invalidToolGraphProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push(event.kind) });

    expect(result.toolRefs).toHaveLength(1);
    expect(result.roleCallsUsed).toBe(4); // tool-smith attempts(2) + skill-writer(1) + assembler(1)
    expect(events).toContain('tool_repair_attempted');
    expect(events).toContain('tool_generated');
    expect((await toolRepo.list(scope))).toHaveLength(1); // 無効な提案は保存されない。修正版のみ1件。
  });

  it('修復上限まで失敗したToolはスキップされ、依存Skillは残るToolへ縮退し、Agentは保存される', async () => {
    const { model, skillRepo, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' }, // lookup: 成功
      { message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' }, // broken: attempt 1
      { message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' }, // broken: attempt 2（maxRepairAttempts:1で上限）
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: twoToolPlan, profiles, maxRepairAttempts: 1, onEvent: (event) => events.push(event.kind) });

    expect(result.toolRefs).toHaveLength(1);
    expect(result.toolKeyToRef.has('lookup')).toBe(true);
    expect(result.toolKeyToRef.has('broken')).toBe(false);
    expect(result.toolKeyToPublishName.has('lookup')).toBe(true);
    expect(result.toolKeyToPublishName.has('broken')).toBe(false);
    expect(events.filter((kind) => kind === 'tool_repair_attempted')).toHaveLength(2);

    expect(result.skillRefs).toHaveLength(1);
    const skillRef = result.skillRefs[0];
    if (skillRef === undefined) throw new Error('expected a skill ref');
    const skill = await skillRepo.findVersion(scope, skillRef.internalId, SemVer.parse(skillRef.version));
    expect(skill?.tools).toHaveLength(1); // 'broken' 抜きで縮退。

    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent).not.toBeNull();
    expect(agent?.tools).toHaveLength(1);
  });

  it('全Toolが修復上限まで失敗した場合はFactoryValidationErrorを投げる', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' },
    );

    await expect(useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 1 })).rejects.toThrow(/no tools could be generated/);
  });
});
