import { describe, expect, it } from 'vitest';
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

async function setup() {
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
  const useCase = new ApplyImprovementsUseCase(agentRepo, skillRepo, toolRepo, saveAgent, saveSkill, saveTool, generateAgentPrompt, engine);

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

  return { agentRepo, skillRepo, toolRepo, useCase, agentRef, toolId: tool.metadata.internalId, skillId: skill.metadata.internalId };
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
    expect(newTool?.inputSchema).toEqual({ columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] });
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

  it('add-tool提案は常にrejectedになる（M4スコープ外）', async () => {
    const { useCase, agentRef } = await setup();
    const proposal: ImprovementProposal = { kind: 'add-tool', plan: { key: 'extra', displayName: 'Extra', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only' }, rationale: 'need more data' };

    const result = await useCase.execute({ scope, agentRef, proposals: [proposal], maxProposals: 4 });

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toEqual([{ proposal, reason: 'add-tool application is a later slice' }]);
    expect(result.newAgentRef).toEqual(agentRef);
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
