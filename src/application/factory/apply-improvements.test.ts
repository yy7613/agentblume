import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { ToolGraph } from '../../domain/etl/graph';
import type { ImprovementProposal } from '../../domain/factory/improvement-proposal';
import type { VersionRef } from '../../domain/factory/refs';
import { SemVer } from '../../domain/tool/semver';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { ApplyImprovementsUseCase } from './apply-improvements';
import type { UnitOfWorkPort } from '../persistence/unit-of-work';
import { ProfileDataSourcesUseCase } from './profile-data-sources';
import { ToolSmithRole } from './roles/tool-smith-role';

const scope = { tenantId: 't', workspaceId: 'w' };

const validGraph: ToolGraph = {
  nodes: [
    { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
  ],
  edges: [{ from: 'src', to: 'out' }],
};

/** select列 'does_not_exist' が存在しないため EtlEngine.propagateSchemas でhasErrors:trueになる不正グラフ。 */
const invalidGraph: ToolGraph = {
  nodes: [
    { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'sel', type: 'select', config: { columns: ['does_not_exist'] } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
  ],
  edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
};

/** ToolSmithが返す妥当な提案（`ds-1` を読む read-only グラフ）。 */
function validToolSmithProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'out', type: 'agent-output', config: { shape: 'summary', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'out' }],
    },
    agentTool: { name: 'summarize_sales', description: 'Summarize all sales rows.' },
  });
}

/** ToolSmithが返す不正な提案（存在しない列をselectするためスキーマ伝播でエラーになる）。 */
function invalidToolSmithProposalJson(): string {
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'sel', type: 'select', config: { columns: ['does_not_exist'] } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
    },
    agentTool: { name: 'summarize_sales', description: 'Summarize all sales rows.' },
  });
}

/** 決定的なid列（新規Tool/Skillのinternalidを検証しやすくする）。 */
function makeSequentialId(prefix: string): () => string {
  let next = 0;
  return () => { next += 1; return `${prefix}-${next}`; };
}

async function setup(options?: { readonly withToolCreation?: boolean; readonly unitOfWork?: UnitOfWorkPort }) {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, 'id,amount\n1,100\n2,200');
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);

  const toolRepo = new InMemoryToolRepository();
  const skillRepo = new InMemorySkillRepository();
  const agentRepo = new InMemoryAgentRepository();
  const saveTool = new SaveToolUseCase(toolRepo, engine, resolver);
  const saveSkill = new SaveSkillUseCase(skillRepo, toolRepo);
  const saveAgent = new SaveAgentUseCase(agentRepo, toolRepo, skillRepo);
  const generateAgentPrompt = new GenerateAgentPromptUseCase(toolRepo, skillRepo, agentRepo);
  const model = new ScriptedModelProvider();
  const toolCreation = options?.withToolCreation === true
    ? { toolSmith: new ToolSmithRole(model), resolveDataSources: resolver, profiler: new ProfileDataSourcesUseCase(dataSources, resolver, engine) }
    : undefined;
  const useCase = new ApplyImprovementsUseCase(
    agentRepo, skillRepo, toolRepo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine, undefined, toolCreation, makeSequentialId('new'),
    options?.unitOfWork,
  );

  const tool = await saveTool.execute({
    scope, internalId: 'tool-1', workingName: 'lookup (draft)', displayName: 'Lookup Sales', publishName: 'factory_tool_lookup', owner: 'agent-factory',
    sideEffect: 'read-only', graph: validGraph, agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
  const skill = await saveSkill.execute({
    scope, internalId: 'skill-1', workingName: 'summarize (draft)', displayName: 'Summarize', publishName: 'factory_skill_summarize', owner: 'agent-factory',
    responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', inputDescription: 'A question.', outputDescription: 'A summary.',
    instructions: 'Use lookup_sales, then summarize.', tools: [{ internalId: tool.metadata.internalId, version: tool.metadata.version }],
  });
  const agent = await saveAgent.execute({
    scope, internalId: 'agent-1', workingName: 'sales assistant (draft)', displayName: 'Sales Assistant', publishName: 'factory_agent_sales', owner: 'agent-factory',
    kind: 'normal', systemPrompt: '# Role\nYou are the Sales Assistant.\n\n# Extra rules\nBe concise.',
    skills: [{ internalId: skill.metadata.internalId, version: skill.metadata.version }],
    tools: [{ internalId: tool.metadata.internalId, version: tool.metadata.version }],
  });
  const agentRef: VersionRef = { internalId: agent.metadata.internalId, version: agent.metadata.version.toString() };

  return { agentRepo, skillRepo, toolRepo, saveAgent, model, useCase, agentRef, toolId: tool.metadata.internalId, skillId: skill.metadata.internalId };
}

describe('ApplyImprovementsUseCase', () => {
  it('skill-instructions-revision: 新しいSkill版と新しいAgent版を作る', async () => {
    const { skillRepo, agentRepo, useCase, agentRef, skillId } = await setup();
    const proposal: ImprovementProposal = { kind: 'skill-instructions-revision', skillId, instructions: 'Use lookup_sales; if it errors, apologize and retry once.', activationCondition: 'user asks about sales', rationale: 'improve error handling' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.resultingVersion.internalId).toBe(skillId);
    expect(result.applied[0]?.resultingVersion.version).toBe('1.0.1');
    expect(result.newAgentRef).not.toEqual(agentRef);

    const newSkill = await skillRepo.findVersion(scope, skillId, SemVer.of(1, 0, 1));
    expect(newSkill?.instructions).toContain('apologize');
    const newAgent = await agentRepo.findVersion(scope, agentRef.internalId, SemVer.parse(result.newAgentRef.version));
    expect(newAgent?.skills[0]?.version.toString()).toBe('1.0.1');
  });

  it('tool-contract-revision: 新しいTool版と新しいAgent版を作る', async () => {
    const { toolRepo, useCase, agentRef, toolId } = await setup();
    const proposal: ImprovementProposal = { kind: 'tool-contract-revision', toolId, agentTool: { description: 'Look up raw sales rows for the requested period.' }, rationale: 'clarify description' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    const newTool = await toolRepo.findVersion(scope, toolId, SemVer.parse(result.applied[0]!.resultingVersion.version));
    expect(newTool?.agentTool?.description).toContain('requested period');
    expect(newTool?.agentTool?.name).toBe('lookup_sales'); // 未指定fieldは既存値を維持する。
    expect(result.newAgentRef).not.toEqual(agentRef);
  });

  it('tool-graph-revision: 有効なグラフなら新しいTool版と新しいAgent版を作る', async () => {
    const { toolRepo, useCase, agentRef, toolId } = await setup();
    const revisedGraph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'sel', type: 'select', config: { columns: ['id', 'amount'] } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
    };
    const proposal: ImprovementProposal = { kind: 'tool-graph-revision', toolId, graph: revisedGraph, rationale: 'narrow columns' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    const newTool = await toolRepo.findVersion(scope, toolId, SemVer.parse(result.applied[0]!.resultingVersion.version));
    expect(newTool?.graph.nodes).toHaveLength(3);
  });

  it('整合性のためのSkill引き上げとAgent新版は同じトランザクション境界の内側にある', async () => {
    // 境界の内側を一切実行しない UnitOfWork を入れると、境界内の書き込みだけが消える。
    const aborting: UnitOfWorkPort = { withTransaction: async () => { throw new Error('transaction aborted'); } };
    const { toolRepo, skillRepo, agentRepo, useCase, agentRef, toolId, skillId } = await setup({ unitOfWork: aborting });
    const revisedGraph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'sel', type: 'select', config: { columns: ['id', 'amount'] } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
    };
    const proposal: ImprovementProposal = { kind: 'tool-graph-revision', toolId, graph: revisedGraph, rationale: 'narrow columns' };

    await expect(useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 })).rejects.toThrow('transaction aborted');

    // 境界の外（提案の適用ループ）で作られたTool新版は残る。
    expect(await toolRepo.findVersion(scope, toolId, SemVer.of(1, 0, 1))).not.toBeNull();
    // 境界の内側にある「Skillの引き上げ」と「Agent新版」は作られていない＝孤児が残らない。
    expect(await skillRepo.findVersion(scope, skillId, SemVer.of(1, 0, 1))).toBeNull();
    expect(await agentRepo.listVersions(scope, agentRef.internalId)).toHaveLength(1);
  });

  it('tool-graph-revision: agent-input付き改訂グラフはinputSchemaを再導出して保存する', async () => {
    const { toolRepo, useCase, agentRef, toolId } = await setup();
    const revisedGraph: ToolGraph = {
      nodes: [
        { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] }, sample: { minimumAmount: 100 } } },
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'flt', type: 'filter', config: { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'flt' }, { from: 'flt', to: 'out' }],
    };
    const proposal: ImprovementProposal = { kind: 'tool-graph-revision', toolId, graph: revisedGraph, rationale: 'parameterize amount' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    const newTool = await toolRepo.findVersion(scope, toolId, SemVer.parse(result.applied[0]!.resultingVersion.version));
    // Factory経路は全引数をoptionalへ正規化する（省略された条件は実行時にスキップ）。
    expect(newTool?.inputSchema).toEqual({ columns: [{ name: 'minimumAmount', type: 'number', nullable: true }] });
  });

  it('tool-graph-revision: agent-input無しでbindingだけ残る改訂はrejectedになる(安全側)', async () => {
    const { useCase, agentRef, toolId } = await setup();
    const revisedGraph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'flt', type: 'filter', config: { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'src', to: 'flt' }, { from: 'flt', to: 'out' }],
    };
    const proposal: ImprovementProposal = { kind: 'tool-graph-revision', toolId, graph: revisedGraph, rationale: 'orphan binding' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toContain('inputSchema');
  });

  it('tool-graph-revision: 無効なグラフはクラッシュせずrejectedになり、Agent新版も作らない', async () => {
    const { useCase, agentRef, toolId } = await setup();
    const proposal: ImprovementProposal = { kind: 'tool-graph-revision', toolId, graph: invalidGraph, rationale: 'broken' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/graph validation failed/);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('add-tool: 依存が注入されていない配線では却下される（従来どおり）', async () => {
    const { useCase, agentRef } = await setup();
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'extra', displayName: 'Extra', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'need more data' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toEqual([{ proposal, reason: 'add-tool is not configured' }]);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('add-tool: 修復ループが通ればToolを保存しAgent新版のtoolsへ追加する', async () => {
    const { agentRepo, toolRepo, model, useCase, agentRef, toolId } = await setup({ withToolCreation: true });
    model.enqueue({ message: { role: 'assistant', content: validToolSmithProposalJson() }, finishReason: 'stop' });
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'summary', displayName: 'Summarize Sales', purpose: 'Summarize all sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'the agent cannot aggregate' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.resultingVersion).toEqual({ internalId: 'new-1', version: '1.0.0' });

    const savedTool = await toolRepo.findVersion(scope, 'new-1', SemVer.of(1, 0, 0));
    expect(savedTool?.metadata.owner).toBe('agent-factory');
    expect(savedTool?.sideEffect).toBe('read-only');
    expect(savedTool?.agentTool?.name).toBe('summarize_sales');

    const newAgent = await agentRepo.findVersion(scope, agentRef.internalId, SemVer.parse(result.newAgentRef.version));
    // 既存Tool参照は残したまま、新Toolが追加される（差替ではなく和集合）。
    expect(newAgent?.tools.map((ref) => ref.internalId)).toEqual([toolId, 'new-1']);
  });

  it('add-tool: ToolSmithが修復上限まで直せなければ却下され、Agent新版も作らない', async () => {
    const { model, useCase, agentRef } = await setup({ withToolCreation: true });
    model.enqueue(
      { message: { role: 'assistant', content: invalidToolSmithProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: invalidToolSmithProposalJson() }, finishReason: 'stop' },
    );
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'broken', displayName: 'Broken', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'r' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4, maxRepairAttempts: 1 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/add-tool could not be generated/);
    expect(result.rejected[0]?.reason).toMatch(/graph validation failed/);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('add-tool: read-only/session-write以外の副作用はToolSmithを呼ばずに却下する', async () => {
    const { model, useCase, agentRef } = await setup({ withToolCreation: true });
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'writer', displayName: 'Writer', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'write' }, rationale: 'r' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/sideEffect must be 'read-only' or 'session-write'/);
    expect(model.requests).toHaveLength(0);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('add-tool: 存在しないデータソースはプロファイル解決に失敗して却下される', async () => {
    const { useCase, agentRef } = await setup({ withToolCreation: true });
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'ghost', displayName: 'Ghost', purpose: 'p', dataSourceId: 'ds-missing', sideEffect: 'read-only' }, rationale: 'r' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/data source not found/);
  });

  it('add-skill: 既存Toolを参照する新Skillを保存しAgent新版のskillsへ追加する', async () => {
    const { agentRepo, skillRepo, useCase, agentRef, skillId } = await setup();
    const proposal: ImprovementProposal = {
      kind: 'add-skill',
      plan: {
        key: 'explain', displayName: 'Explain Anomalies', responsibility: 'Explain unusual sales rows.',
        activationCondition: 'user asks why a number looks odd', instructions: 'Fetch rows with lookup_sales, then explain the outliers.',
        toolRefs: ['lookup_sales'], // Tool契約名でも解決できる。
      },
      rationale: 'no skill covers anomaly explanations',
    };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.resultingVersion).toEqual({ internalId: 'new-1', version: '1.0.0' });

    const savedSkill = await skillRepo.findVersion(scope, 'new-1', SemVer.of(1, 0, 0));
    expect(savedSkill?.instructions).toContain('explain the outliers');
    expect(savedSkill?.metadata.owner).toBe('agent-factory');
    expect(savedSkill?.tools.map((ref) => ref.internalId)).toEqual(['tool-1']);
    // 未指定のinput/outputDescriptionはresponsibilityから決定的に補われる。
    expect(savedSkill?.inputDescription).toContain('Explain unusual sales rows.');

    const newAgent = await agentRepo.findVersion(scope, agentRef.internalId, SemVer.parse(result.newAgentRef.version));
    expect(newAgent?.skills.map((ref) => ref.internalId)).toEqual([skillId, 'new-1']);
  });

  it('add-skill: Agentが持たないToolを参照すると却下される', async () => {
    const { useCase, agentRef } = await setup();
    const proposal: ImprovementProposal = {
      kind: 'add-skill',
      plan: {
        key: 'ghost', displayName: 'Ghost', responsibility: 'r', activationCondition: 'c', instructions: 'i',
        toolRefs: ['tool_that_does_not_exist'],
      },
      rationale: 'r',
    };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/add-skill references a tool that the agent does not have: tool_that_does_not_exist/);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('add-tool + add-skill: 同一イテレーションで追加したToolをplan.keyで参照できる', async () => {
    const { agentRepo, skillRepo, model, useCase, agentRef } = await setup({ withToolCreation: true });
    model.enqueue({ message: { role: 'assistant', content: validToolSmithProposalJson() }, finishReason: 'stop' });
    const proposals: ImprovementProposal[] = [
      { kind: 'add-tool', plan: { key: 'summary', displayName: 'Summarize Sales', purpose: 'Summarize all sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'aggregate' },
      {
        kind: 'add-skill',
        plan: { key: 'report', displayName: 'Report', responsibility: 'Report monthly totals.', activationCondition: 'user asks for totals', instructions: 'Call summarize_sales and report the totals.', toolRefs: ['summary'] },
        rationale: 'wrap the new tool',
      },
    ];

    const result = await useCase.execute({ scope, agentRef, proposals, maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(2);
    const savedSkill = await skillRepo.findVersion(scope, 'new-2', SemVer.of(1, 0, 0));
    expect(savedSkill?.tools.map((ref) => ref.internalId)).toEqual(['new-1']);

    const newAgent = await agentRepo.findVersion(scope, agentRef.internalId, SemVer.parse(result.newAgentRef.version));
    expect(newAgent?.tools.map((ref) => ref.internalId)).toContain('new-1');
    expect(newAgent?.skills.map((ref) => ref.internalId)).toContain('new-2');
  });

  it('既存Agentの設定（kind/agents/mcpServers/harness/output/state/wikis）を新版でも保持する', async () => {
    const { agentRepo, skillRepo, saveAgent, useCase, skillId } = await setup();
    // 委譲先のサブエージェント（能力なし）を1件用意する。
    const sub = await saveAgent.execute({
      scope, internalId: 'sub-1', workingName: 'helper (draft)', displayName: 'Helper', publishName: 'helper_agent', owner: 'human',
      kind: 'normal', systemPrompt: 'You help.', tools: [],
    });
    const skill = await skillRepo.findVersion(scope, skillId, SemVer.of(1, 0, 0));
    if (skill === null) throw new Error('expected the seeded skill');
    const rich = await saveAgent.execute({
      scope, internalId: 'agent-rich', workingName: 'rich (draft)', displayName: 'Rich Assistant', publishName: 'rich_agent', owner: 'human',
      kind: 'evaluator',
      systemPrompt: '# Role\nYou evaluate.\n\n# Extra rules\nBe strict.',
      skills: [{ internalId: skill.metadata.internalId, version: skill.metadata.version }],
      tools: skill.tools.map((ref) => ({ internalId: ref.internalId, version: ref.version })),
      agents: [{ internalId: sub.metadata.internalId, version: sub.metadata.version, usage: 'delegate research' }],
      mcpServers: ['docs-server'],
      harness: { fileMemory: true, todoProvider: false, compaction: true, webSearch: false, toolApproval: true, functionInvocation: true },
      output: { name: 'verdict_output', fields: [{ name: 'verdict', type: 'string', required: true }] },
      state: 'published',
    });
    const richRef: VersionRef = { internalId: rich.metadata.internalId, version: rich.metadata.version.toString() };
    const proposal: ImprovementProposal = { kind: 'skill-instructions-revision', skillId, instructions: 'Use lookup_sales, then explain the verdict.', rationale: 'sharpen' };

    const result = await useCase.execute({ scope, agentRef: richRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    const newAgent = await agentRepo.findVersion(scope, richRef.internalId, SemVer.parse(result.newAgentRef.version));
    expect(newAgent?.kind).toBe('evaluator');
    expect(newAgent?.agents).toEqual([{ internalId: 'sub-1', version: SemVer.of(1, 0, 0), usage: 'delegate research' }]);
    expect(newAgent?.mcpServers).toEqual(['docs-server']);
    expect(newAgent?.harness).toEqual({ fileMemory: true, todoProvider: false, compaction: true, webSearch: false, toolApproval: true, functionInvocation: true });
    expect(newAgent?.output).toEqual({ name: 'verdict_output', fields: [{ name: 'verdict', type: 'string', required: true }] });
    expect(newAgent?.metadata.state).toBe('published');
    // Skillは新版へ引き上がっている（保全と改訂が両立する）。
    expect(newAgent?.skills[0]?.version.toString()).toBe('1.0.1');
  });

  it('system-prompt-revision: role/rules双方があれば新しいAgent版を組み立てる', async () => {
    const { agentRepo, useCase, agentRef } = await setup();
    const proposal: ImprovementProposal = { kind: 'system-prompt-revision', agentId: agentRef.internalId, sections: { role: '# Role\nYou are the Sales Assistant, an expert in monthly trends.', rules: '# Extra rules\nAlways state the period covered.' }, rationale: 'clarify scope' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.rejected).toHaveLength(0);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.resultingVersion).toEqual(result.newAgentRef);
    const newAgent = await agentRepo.findVersion(scope, agentRef.internalId, SemVer.parse(result.newAgentRef.version));
    expect(newAgent?.systemPrompt).toContain('expert in monthly trends');
    expect(newAgent?.systemPrompt).toContain('Always state the period covered');
  });

  it('system-prompt-revision: role/rulesの片方が欠けているとrejectedになる', async () => {
    const { useCase, agentRef } = await setup();
    const proposal: ImprovementProposal = { kind: 'system-prompt-revision', agentId: agentRef.internalId, sections: { role: 'only role' }, rationale: 'incomplete' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/requires both sections.role and sections.rules/);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('2件目のsystem-prompt-revisionはrejectedになる（1イテレーション1件まで）', async () => {
    const { useCase, agentRef } = await setup();
    const first: ImprovementProposal = { kind: 'system-prompt-revision', agentId: agentRef.internalId, sections: { role: 'role A', rules: 'rules A' }, rationale: 'a' };
    const second: ImprovementProposal = { kind: 'system-prompt-revision', agentId: agentRef.internalId, sections: { role: 'role B', rules: 'rules B' }, rationale: 'b' };

    const result = await useCase.execute({ scope, agentRef, proposals: [first, second], maxProposals: 4 });

    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.proposal).toEqual(first);
    expect(result.rejected).toEqual([{ proposal: second, reason: 'a system-prompt-revision was already applied for this iteration' }]);
  });

  it('maxProposalsを超える分はexceeds maxProposalsPerIterationとしてrejectedになる', async () => {
    const { useCase, agentRef, skillId } = await setup();
    const proposals: ImprovementProposal[] = [
      { kind: 'skill-instructions-revision', skillId, instructions: 'v2', rationale: 'r' },
      { kind: 'add-tool', plan: { key: 'x', displayName: 'X', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'r' },
    ];

    const result = await useCase.execute({ scope, agentRef, proposals, maxProposals: 1 });

    expect(result.applied).toHaveLength(1);
    expect(result.rejected).toEqual([{ proposal: proposals[1], reason: 'exceeds maxProposalsPerIteration' }]);
  });

  it('すべて却下された場合（no-op）は同じagentRefを返す', async () => {
    const { useCase, agentRef, toolId } = await setup();
    const proposals: ImprovementProposal[] = [
      { kind: 'tool-graph-revision', toolId, graph: invalidGraph, rationale: 'broken' },
      { kind: 'add-tool', plan: { key: 'x', displayName: 'X', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'r' },
    ];

    const result = await useCase.execute({ scope, agentRef, proposals, maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.newAgentRef).toEqual(agentRef);
  });

  it('存在しないAgent版はFactoryValidationErrorを投げる', async () => {
    const { useCase } = await setup();
    await expect(useCase.execute({ scope, agentRef: { internalId: 'missing', version: '1.0.0' }, proposals: [], maxProposals: 4 })).rejects.toThrow(/agent not found/);
  });
});
