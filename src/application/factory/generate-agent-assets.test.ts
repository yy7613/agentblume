import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { Agent } from '../../domain/agent/agent';
import { createAgent } from '../../domain/agent/agent';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { agentToolArgumentsOf, GenerateAgentAssetsUseCase, makeArgumentsOptional, mergeAgentInputDeclarations, replaceGuideSections, resolveReuseTarget } from './generate-agent-assets';
import { ProfileDataSourcesUseCase } from './profile-data-sources';
import { buildExistingToolCatalog, type ExistingToolCatalogEntry } from './tool-catalog';
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

/** 組み込みツール（`src/builtin-tools.ts` と同じ契約）の再利用を含む計画。 */
const BUILTIN_DATETIME_ID = 'builtin-current-datetime';

const reusePlan: FactoryPlan = {
  agentBrief: { displayName: 'Sales Assistant', role: 'Answers sales questions using the sales data source.' },
  tools: [
    { key: 'today', displayName: 'Current Datetime', purpose: 'Resolve "this month" to a concrete year-month.', dataSourceId: '', sideEffect: 'read-only', reuse: { internalId: BUILTIN_DATETIME_ID, rationale: 'the builtin tool already returns now/date/yearMonth' } },
    { key: 'lookup', displayName: 'Lookup Sales', purpose: 'Look up sales rows.', dataSourceId: 'ds-1', sideEffect: 'read-only' },
  ],
  skills: [{ key: 'summarize', displayName: 'Summarize', responsibility: 'Summarize sales trends.', activationCondition: 'user asks for a summary', toolKeys: ['lookup', 'today'] }],
  personas: [],
  scenarios: [],
};

/** 過去のFactory実行・手作りで既に保存されているToolを模して、組み込みの現在日時ツールを直接保存する。 */
async function seedBuiltinDatetimeTool(toolRepo: InMemoryToolRepository): Promise<void> {
  await toolRepo.save(createTool({
    metadata: {
      internalId: BUILTIN_DATETIME_ID, workingName: 'Current datetime draft', displayName: 'Current Datetime', publishName: 'current_datetime',
      version: SemVer.of(1, 0, 0), owner: 'builtin', state: 'draft', tenant: scope,
    },
    sideEffect: 'read-only',
    graph: {
      nodes: [
        { id: 'now', type: 'current-datetime', config: {} },
        { id: 'agent-result', type: 'agent-output', config: { shape: 'first-row', format: 'json', maxRows: 1, maxBytes: 4096, overflow: 'error' } },
      ],
      edges: [{ from: 'now', to: 'agent-result' }],
    },
    agentTool: { name: 'current_datetime', description: 'Returns the current date and time (now, date, yearMonth, time, weekday).' },
  }));
}

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

/**
 * 検索条件をエージェント引数として宣言する提案。未接続の agent-input が引数を宣言し、
 * filter の各条件が `valueBinding`（値）/ `opBinding`（演算子）でそれを消費する。
 */
function argumentToolProposalJson(overrides?: { readonly undeclaredBinding?: string; readonly unusedArgument?: boolean; readonly operatorArgument?: boolean }): string {
  const columns = [{ name: 'minimumAmount', type: 'number', nullable: false }];
  const sample: Record<string, unknown> = { minimumAmount: 100 };
  if (overrides?.unusedArgument === true) {
    columns.push({ name: 'unusedFlag', type: 'boolean', nullable: false });
    sample['unusedFlag'] = true;
  }
  if (overrides?.operatorArgument === true) {
    columns.push({ name: 'amountOp', type: 'string', nullable: false });
    sample['amountOp'] = 'gte';
  }
  const opBinding = overrides?.operatorArgument === true
    ? { opBinding: { source: 'agent-input', field: 'amountOp', allowed: ['gte', 'lte'] } }
    : {};
  const conditions: unknown[] = [{ column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' }, ...opBinding }];
  if (overrides?.undeclaredBinding !== undefined) {
    conditions.push({ column: 'id', op: 'gte', value: 1, valueBinding: { source: 'agent-input', field: overrides.undeclaredBinding } });
  }
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'filter', type: 'filter', config: { conditions, combine: 'and' } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns }, sample } },
      ],
      edges: [{ from: 'src', to: 'filter' }, { from: 'filter', to: 'out' }],
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows at or above minimumAmount.' },
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

  it('agent-inputで引数を宣言した提案はinputSchema付きで保存し、Tool使用ガイドへ引数を出す', async () => {
    const { model, toolRepo, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: argumentToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    // agent-inputノードのschemaがTool Calling契約（inputSchema）になる。Factory経路は
    // 全引数をoptionalへ正規化する（モデルがnullable指示に従わなくても省略可能な契約を保証）。
    expect(tool?.inputSchema).toEqual({ columns: [{ name: 'minimumAmount', type: 'number', nullable: true }] });
    // Tool使用ガイドは inputSchema から決定的に導出されるので引数が見える（optionalは`?`付き表記）。
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).toContain('input [minimumAmount?:number]');
  });

  it('引数を使わない提案は従来どおりinputSchema無しで保存する', async () => {
    const { model, toolRepo, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.inputSchema).toBeUndefined();
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).toContain('input [なし]');
  });

  it('opBindingだけで消費される演算子引数は未使用エラーにならず、inputSchemaへ含めて保存する', async () => {
    const { model, toolRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: argumentToolProposalJson({ operatorArgument: true }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 0, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    // 演算子引数 amountOp は valueBinding を持たないが opBinding が消費するので、修復ループへ回らない。
    expect(messages).toEqual([]);
    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.inputSchema).toEqual({ columns: [
      { name: 'minimumAmount', type: 'number', nullable: true },
      { name: 'amountOp', type: 'string', nullable: true },
    ] });
  });

  it('未宣言fieldへのbindingや未使用の引数宣言は修復ループへ回す', async () => {
    const { model, toolRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: argumentToolProposalJson({ undeclaredBinding: 'notDeclared' }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: argumentToolProposalJson({ unusedArgument: true }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: argumentToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/unknown field 'notDeclared'/);
    expect(messages[1]).toMatch(/never used by a filter: unusedFlag/);
    expect(result.toolRefs).toHaveLength(1);
    expect((await toolRepo.list(scope))).toHaveLength(1);
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

  it('reuse指定のToolはToolSmithを呼ばず、既存Toolの最新版を参照してAgent/Skillへ組み込む', async () => {
    const { model, toolRepo, skillRepo, agentRepo, profiles, useCase } = await setup();
    await seedBuiltinDatetimeTool(toolRepo);
    const existingTools = (await buildExistingToolCatalog(toolRepo, scope)).entries;
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' }, // lookup（新規）だけToolSmithを呼ぶ
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: reusePlan, profiles, maxRepairAttempts: 2, existingTools, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    // 再利用したToolはロール呼び出しを消費せず、新しいバージョンも作らない。
    expect(result.roleCallsUsed).toBe(3); // tool-smith(lookup) + skill-writer + assembler
    expect(model.requests).toHaveLength(3);
    expect(await toolRepo.listVersions(scope, BUILTIN_DATETIME_ID)).toHaveLength(1);
    expect(result.toolKeyToRef.get('today')).toEqual({ internalId: BUILTIN_DATETIME_ID, version: '1.0.0' });
    expect(result.toolKeyToPublishName.get('today')).toBe('current_datetime');
    expect(result.toolRefs).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'tool_reused')).toEqual([{ kind: 'tool_reused', message: 'today: current_datetime' }]);
    expect(events.filter((event) => event.kind === 'tool_generated')).toHaveLength(1);

    // Skill・Agentは既存Tool版をSemVer固定で参照する（Tool使用ガイドにも既存Toolの契約が載る）。
    const skillRef = result.skillRefs[0];
    if (skillRef === undefined) throw new Error('expected a skill ref');
    const skill = await skillRepo.findVersion(scope, skillRef.internalId, SemVer.parse(skillRef.version));
    expect(skill?.tools.map((ref) => ref.internalId)).toContain(BUILTIN_DATETIME_ID);
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.tools.map((ref) => ref.internalId)).toContain(BUILTIN_DATETIME_ID);
    expect(agent?.systemPrompt).toContain('current_datetime');
  });

  it('reuse先がカタログに無い場合は理由を記録して新規生成へフォールバックする', async () => {
    const { model, profiles, useCase } = await setup();
    const plan: FactoryPlan = { ...onePlan, tools: [{ ...onePlan.tools[0]!, reuse: { internalId: 'tool-deleted' } }] };
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan, profiles, maxRepairAttempts: 2, existingTools: [], onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    expect(events.find((event) => event.kind === 'tool_repair_attempted')?.message).toMatch(/reuse target 'tool-deleted' is not available for reuse/);
    expect(events.some((event) => event.kind === 'tool_reused')).toBe(false);
    expect(result.toolRefs).toHaveLength(1);
    expect(result.toolKeyToRef.get('lookup')?.internalId).not.toBe('tool-deleted');
  });

  it('再利用が許されない副作用（write）の既存Toolを指すreuseも新規生成へフォールバックする', async () => {
    const { model, profiles, useCase } = await setup();
    const writeTool: ExistingToolCatalogEntry = {
      internalId: 'tool-writer', latestVersion: '1.0.0', publishName: 'writes_rows', displayName: 'Writes rows',
      toolName: 'writes_rows', description: 'Writes rows somewhere.', inputs: [], sideEffect: 'write', owner: 'human',
    };
    const plan: FactoryPlan = { ...onePlan, tools: [{ ...onePlan.tools[0]!, reuse: { internalId: 'tool-writer' } }] };
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan, profiles, maxRepairAttempts: 2, existingTools: [writeTool], onEvent: (event) => events.push(event.kind) });

    expect(events).toContain('tool_repair_attempted');
    expect(events).toContain('tool_generated');
    expect(result.toolRefs.some((ref) => ref.internalId === 'tool-writer')).toBe(false);
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

describe('GenerateAgentAssetsUseCase（強化モードの promptStrategy）', () => {
  const BASE_AGENT_ID = 'base-agent';
  /** 決定的ガイド2節（Tool/Skillとも0件の文面）+ 利用者が手で書いた節を持つ、Builder標準書式のプロンプト。 */
  const BASE_AGENT_PROMPT = [
    '# 役割\nあなたは「Base Assistant」です。経理担当者へ社内の言葉づかいで答えてください。',
    '# Skillガイド\n適用するSkillはありません。',
    '# Tool使用ガイド\n利用可能なToolはありません。',
    '# 独自メモ\n利用者が手で書いた節。Factoryの強化で消えてはならない。',
    '# 実行規則\n- 数字には必ず出典を添える。',
  ].join('\n\n');

  const noAdditionPlan: FactoryPlan = { agentBrief: onePlan.agentBrief, tools: [], skills: [], personas: [], scenarios: [] };

  async function seedBaseAgent(agentRepo: InMemoryAgentRepository, systemPrompt: string = BASE_AGENT_PROMPT): Promise<Agent> {
    const agent = createAgent({
      metadata: {
        internalId: BASE_AGENT_ID, workingName: 'Base agent draft', displayName: 'Base Assistant', publishName: 'base_assistant',
        version: SemVer.of(1, 0, 0), owner: 'alice', state: 'draft', tenant: scope,
      },
      kind: 'normal',
      systemPrompt,
      skills: [],
      tools: [],
      agents: [],
    });
    await agentRepo.save(agent);
    return agent;
  }

  it('preserve（既定）: Assemblerを呼ばず、役割文・利用者の節・実行規則をそのまま残す', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    const baseAgent = await seedBaseAgent(agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, baseAgent });

    // tool-smith(1) + skill-writer(1) のみ。Assemblerは呼ばれない。
    expect(result.roleCallsUsed).toBe(2);
    expect(model.requests).toHaveLength(2);
    expect(result.agentChanged).toBe(true);
    expect(result.agentRef).toEqual({ internalId: BASE_AGENT_ID, version: '1.0.1' });

    const enhanced = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    expect(enhanced?.systemPrompt).toContain('# 役割\nあなたは「Base Assistant」です。経理担当者へ社内の言葉づかいで答えてください。');
    expect(enhanced?.systemPrompt).toContain('# 独自メモ\n利用者が手で書いた節。Factoryの強化で消えてはならない。');
    expect(enhanced?.systemPrompt).toContain('# 実行規則\n- 数字には必ず出典を添える。');
    expect(enhanced?.systemPrompt).toContain('lookup_sales@1.0.0'); // ガイド2節だけが新しい構成へ差し替わる
  });

  it('rewrite: Assemblerの role/rules と決定的ガイドで systemPrompt を組み直し、ロール呼び出しが1回増える', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    const baseAgent = await seedBaseAgent(agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({
      scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite',
      onEvent: (event) => { if (event.message !== undefined) messages.push(event.message); },
    });

    // tool-smith(1) + skill-writer(1) + assembler(1)。
    expect(result.roleCallsUsed).toBe(3);
    expect(result.agentChanged).toBe(true);
    expect(messages).toContain('enhanced Base Assistant (prompt rewritten by assembler)');

    const enhanced = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    // 役割文 → Skillガイド → Tool使用ガイド → 実行規則（生成モードと同じ組み立て）。
    expect(enhanced?.systemPrompt.startsWith('# Role\nYou are the Sales Assistant')).toBe(true);
    expect(enhanced?.systemPrompt.endsWith('# Extra rules\nAlways cite the rows returned by the lookup tool.')).toBe(true);
    expect(enhanced?.systemPrompt).toContain('lookup_sales@1.0.0');
    // 書き直しなので、既存の役割文・利用者の節は残らない（それが rewrite を選んだ意味）。
    expect(enhanced?.systemPrompt).not.toContain('独自メモ');

    // Assemblerには既存プロンプトが untrusted data として渡る（改訂であって作り直しではない、と指示する）。
    const assemblerRequest = model.requests[2];
    expect(String(assemblerRequest?.messages.find((message) => message.role === 'user')?.content)).toContain('独自メモ');
    expect(String(assemblerRequest?.messages.find((message) => message.role === 'system')?.content)).toContain('Revise it; do NOT rebuild it from scratch.');
  });

  it('rewrite でAssemblerが失敗したら preserve へフォールバックし、理由をイベントへ残して続行する', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    const baseAgent = await seedBaseAgent(agentRepo);
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: '{not json' }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({
      scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite',
      onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }),
    });

    // Runは落とさない。試行した呼び出しは消費として数える（`generateToolWithRepair` と同じ規律）。
    expect(result.roleCallsUsed).toBe(3);
    expect(result.agentChanged).toBe(true);
    expect(events.find((event) => event.kind === 'proposal_rejected')?.message).toMatch(/prompt rewrite failed, kept the existing prompt: AssemblerRole: invalid JSON/);
    expect(events.some((event) => event.message === 'enhanced Base Assistant (prompt guides spliced)')).toBe(true);

    const enhanced = await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1));
    expect(enhanced?.systemPrompt).toContain('# 独自メモ\n利用者が手で書いた節。Factoryの強化で消えてはならない。');
  });

  it('追加0件でも rewrite ならプロンプト改訂のために新版を作る（preserve は新版を作らない）', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    const baseAgent = await seedBaseAgent(agentRepo);

    const preserved = await useCase.execute({ scope, runId: 'run-1', goal, plan: noAdditionPlan, profiles, maxRepairAttempts: 2, baseAgent });
    expect(preserved.agentChanged).toBe(false);
    expect(preserved.agentRef).toEqual({ internalId: BASE_AGENT_ID, version: '1.0.0' });
    expect(model.requests).toHaveLength(0);

    model.enqueue({ message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' });
    const rewritten = await useCase.execute({ scope, runId: 'run-1', goal, plan: noAdditionPlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite' });

    expect(rewritten.roleCallsUsed).toBe(1);
    expect(rewritten.agentChanged).toBe(true);
    expect(rewritten.agentRef).toEqual({ internalId: BASE_AGENT_ID, version: '1.0.1' });
    expect((await agentRepo.findVersion(scope, BASE_AGENT_ID, SemVer.of(1, 0, 1)))?.systemPrompt).toContain('# Role\nYou are the Sales Assistant');
  });

  it('rewrite の結果が既存プロンプトと完全一致なら新版を作らない（無意味な版を増やさない）', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    const role = '# 役割\nあなたは「Base Assistant」です。';
    const rules = '# 実行規則\n- 数字には必ず出典を添える。';
    const baseAgent = await seedBaseAgent(agentRepo, [role, '# Skillガイド\n適用するSkillはありません。', '# Tool使用ガイド\n利用可能なToolはありません。', rules].join('\n\n'));
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ role, rules }) }, finishReason: 'stop' });

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: noAdditionPlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite' });

    expect(result.roleCallsUsed).toBe(1); // Assemblerは呼ばれた（消費した）が…
    expect(result.agentChanged).toBe(false); // …結果が同じなので保存はしない。
    expect(await agentRepo.listVersions(scope, BASE_AGENT_ID)).toHaveLength(1);
  });
});

describe('agentToolArgumentsOf', () => {
  /** agent-input（引数宣言）+ それを消費する filter を持つ最小グラフ。 */
  function graphWith(argumentsConfig: unknown, filterConfig: unknown = { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } }): ToolGraph {
    return {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'filter', type: 'filter', config: filterConfig },
        { id: 'args', type: 'agent-input', config: argumentsConfig },
      ],
      edges: [{ from: 'src', to: 'filter' }],
    };
  }

  const validArguments = { schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] }, sample: { minimumAmount: 100 } };

  it('agent-inputが無ければundefined（引数無しToolは従来どおり）', () => {
    expect(agentToolArgumentsOf({ nodes: [{ id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } }], edges: [] })).toBeUndefined();
  });

  it('宣言をそのままTool引数スキーマへ写す（nullable引数はサンプル値を省ける）', () => {
    expect(agentToolArgumentsOf(graphWith(validArguments))).toEqual({ columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] });
    const optional = {
      schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }, { name: 'region', type: 'string', nullable: true }] },
      sample: { minimumAmount: 100 },
    };
    const filterConfig = { conditions: [
      { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } },
      { column: 'id', op: 'gte', value: 1, valueBinding: { source: 'agent-input', field: 'region' } },
    ], combine: 'and' };
    expect(agentToolArgumentsOf(graphWith(optional, filterConfig))?.columns).toHaveLength(2);
  });

  it('opBindingだけで消費される引数は「never used by a filter」エラーにならない', () => {
    const args = {
      schema: { columns: [
        { name: 'minimumAmount', type: 'number', nullable: false },
        { name: 'amountOp', type: 'string', nullable: false },
      ] },
      sample: { minimumAmount: 100, amountOp: 'gte' },
    };
    const filterConfig = { conditions: [
      { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' }, opBinding: { source: 'agent-input', field: 'amountOp', allowed: ['gte', 'lte'] } },
    ], combine: 'and' };
    expect(agentToolArgumentsOf(graphWith(args, filterConfig))?.columns.map((column) => column.name)).toEqual(['minimumAmount', 'amountOp']);
  });

  it('旧形式フラットconfigのopBinding（allowed省略）も引数の消費として数える', () => {
    const args = { schema: { columns: [{ name: 'amountOp', type: 'string', nullable: true }] }, sample: {} };
    const flat = { column: 'amount', op: 'gte', value: 100, opBinding: { source: 'agent-input', field: 'amountOp' } };
    expect(agentToolArgumentsOf(graphWith(args, flat))).toEqual({ columns: [{ name: 'amountOp', type: 'string', nullable: true }] });
  });

  it('valueBindingもopBindingも無い引数は従来どおり未使用エラーになる', () => {
    const args = {
      schema: { columns: [
        { name: 'amountOp', type: 'string', nullable: false },
        { name: 'unusedFlag', type: 'boolean', nullable: false },
      ] },
      sample: { amountOp: 'gte', unusedFlag: true },
    };
    const filterConfig = { conditions: [
      { column: 'amount', op: 'gte', value: 100, opBinding: { source: 'agent-input', field: 'amountOp', allowed: ['gte', 'lte'] } },
    ], combine: 'and' };
    expect(() => agentToolArgumentsOf(graphWith(args, filterConfig))).toThrow(/never used by a filter: unusedFlag/);
  });

  it('壊れた宣言・未使用の引数は修復ループ用のFactoryValidationErrorになる', () => {
    const twice: ToolGraph = { nodes: [...graphWith(validArguments).nodes, { id: 'args2', type: 'agent-input', config: validArguments }], edges: [] };
    expect(() => agentToolArgumentsOf(twice)).toThrow(/keep exactly one agent-input node/);
    expect(() => agentToolArgumentsOf(graphWith({ schema: { columns: [] }, sample: {} }))).toThrow(/config\.schema\.columns/);
    expect(() => agentToolArgumentsOf(graphWith({ schema: { columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] } }))).toThrow(/config\.sample/);
    expect(() => agentToolArgumentsOf(graphWith({ ...validArguments, schema: { columns: [{ name: '  ', type: 'number', nullable: false }] } }))).toThrow(/non-empty name/);
    expect(() => agentToolArgumentsOf(graphWith({ ...validArguments, schema: { columns: [{ name: 'minimumAmount', type: 'object', nullable: false }] } }))).toThrow(/must use type string\|number\|boolean\|date/);
    expect(() => agentToolArgumentsOf(graphWith({ schema: validArguments.schema, sample: {} }))).toThrow(/missing a representative value for 'minimumAmount'/);
    expect(() => agentToolArgumentsOf(graphWith(validArguments, { column: 'amount', op: 'gte', value: 100 }))).toThrow(/never used by a filter: minimumAmount/);
  });
});

describe('resolveReuseTarget', () => {
  const entry = (internalId: string, publishName: string, toolName = publishName): ExistingToolCatalogEntry => ({
    internalId, latestVersion: '1.0.0', publishName, displayName: internalId, toolName, description: 'd', inputs: [], sideEffect: 'read-only', owner: 'builtin',
  });
  const catalog = [entry('builtin-current-datetime', 'current_datetime'), entry('tool-b', 'lookup_sales', 'sales_lookup')];

  it('internalId/publishName/toolNameの完全一致で解決する', () => {
    expect(resolveReuseTarget(catalog, 'builtin-current-datetime')?.internalId).toBe('builtin-current-datetime');
    expect(resolveReuseTarget(catalog, 'current_datetime')?.internalId).toBe('builtin-current-datetime');
    expect(resolveReuseTarget(catalog, 'sales_lookup')?.internalId).toBe('tool-b');
  });

  it('区切り文字の混同(実測: builtin-current_datetime)は正規化一致で救う', () => {
    expect(resolveReuseTarget(catalog, 'builtin-current_datetime')?.internalId).toBe('builtin-current-datetime');
    expect(resolveReuseTarget(catalog, 'Current-Datetime')?.internalId).toBe('builtin-current-datetime');
  });

  it('未知・空・曖昧(複数候補)は解決しない', () => {
    expect(resolveReuseTarget(catalog, 'unknown-tool')).toBeUndefined();
    expect(resolveReuseTarget(catalog, '---')).toBeUndefined();
    const ambiguous = [...catalog, entry('current-datetime', 'current_datetime_v2')];
    expect(resolveReuseTarget(ambiguous, 'currentdatetime')).toBeUndefined();
  });
});

describe('makeArgumentsOptional', () => {
  it('agent-inputの全引数をnullable: trueへ正規化する(sampleは不変)', () => {
    const graph: ToolGraph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns: [
          { name: 'region', type: 'string', nullable: false },
          { name: 'month', type: 'string', nullable: true },
        ] }, sample: { region: 'East', month: '2026-05' } } },
      ],
      edges: [],
    };
    const normalized = makeArgumentsOptional(graph);
    const config = normalized.nodes.find((node) => node.type === 'agent-input')?.config as { schema: { columns: { nullable: boolean }[] }; sample: unknown };
    expect(config.schema.columns.every((column) => column.nullable)).toBe(true);
    expect(config.sample).toEqual({ region: 'East', month: '2026-05' });
  });

  it('agent-inputが無い・列が空のグラフは変更しない', () => {
    const plain: ToolGraph = { nodes: [{ id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } }], edges: [] };
    expect(makeArgumentsOptional(plain)).toBe(plain);
    const empty: ToolGraph = { nodes: [{ id: 'args', type: 'agent-input', config: { schema: { columns: [] }, sample: {} } }], edges: [] };
    expect(makeArgumentsOptional(empty)).toBe(empty);
  });
});

describe('mergeAgentInputDeclarations', () => {
  const base: ToolGraph = {
    nodes: [
      { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
      { id: 'filter', type: 'filter', config: { conditions: [
        { column: 'region', op: 'eq', value: 'East', valueBinding: { source: 'agent-input', field: 'region' } },
        { column: 'month', op: 'eq', value: '2026-05', valueBinding: { source: 'agent-input', field: 'month' } },
      ], combine: 'and' } },
      { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
    ],
    edges: [{ from: 'src', to: 'filter' }, { from: 'filter', to: 'out' }],
  };

  it('未接続agent-inputが複数あれば1ノードへ先勝ちマージする(モデルの典型的誤生成の正規化)', () => {
    const graph: ToolGraph = { nodes: [...base.nodes,
      { id: 'args1', type: 'agent-input', config: { schema: { columns: [{ name: 'region', type: 'string', nullable: false }] }, sample: { region: 'East' } } },
      { id: 'args2', type: 'agent-input', config: { schema: { columns: [{ name: 'month', type: 'string', nullable: false }, { name: 'region', type: 'number', nullable: false }] }, sample: { month: '2026-05' } } },
    ], edges: base.edges };
    const merged = mergeAgentInputDeclarations(graph);
    const declarations = merged.nodes.filter((node) => node.type === 'agent-input');
    expect(declarations).toHaveLength(1);
    expect(declarations[0]?.config).toEqual({
      schema: { columns: [
        { name: 'region', type: 'string', nullable: false },
        { name: 'month', type: 'string', nullable: false },
      ] },
      sample: { region: 'East', month: '2026-05' },
    });
    expect(agentToolArgumentsOf(merged)?.columns.map((column) => column.name)).toEqual(['region', 'month']);
  });

  it('agent-inputが1つ以下、またはエッジ接続されたagent-inputが混在する場合は変更しない', () => {
    expect(mergeAgentInputDeclarations(base)).toBe(base);
    const connected: ToolGraph = { nodes: [...base.nodes,
      { id: 'args1', type: 'agent-input', config: { schema: { columns: [{ name: 'region', type: 'string', nullable: false }] }, sample: { region: 'East' } } },
      { id: 'args2', type: 'agent-input', config: { schema: { columns: [{ name: 'month', type: 'string', nullable: false }] }, sample: { month: '2026-05' } } },
    ], edges: [...base.edges, { from: 'args1', to: 'filter' }] };
    expect(mergeAgentInputDeclarations(connected)).toBe(connected);
  });
});

describe('replaceGuideSections（既存Agent強化モードのsystem prompt再合成）', () => {
  const skillGuide = '# Skillガイド\n- new_skill@1.0.0: 新しい責務\n  発火条件: いつでも\n  instructions: 手順';
  const toolUsageGuide = '# Tool使用ガイド\n- new_tool@1.0.0（説明）: input [なし] / output [なし] / side-effect read-only';

  it('決定的合成の2セクションだけを差し替え、役割文・独自セクション・実行規則は一字一句残す', () => {
    const prompt = [
      '# 役割\nあなたは「Base」です。',
      '# Skillガイド\n- old_skill@1.0.0: 古い責務',
      '# Tool使用ガイド\n- old_tool@1.0.0（古い）: input [なし] / output [なし] / side-effect read-only',
      '# 独自メモ\n利用者が書いた節。',
      '# 実行規則\n- 独自ルール。',
    ].join('\n\n');

    const result = replaceGuideSections(prompt, { skillGuide, toolUsageGuide });

    expect(result.strategy).toBe('spliced');
    expect(result.systemPrompt).toBe([
      '# 役割\nあなたは「Base」です。',
      skillGuide,
      toolUsageGuide,
      '# 独自メモ\n利用者が書いた節。',
      '# 実行規則\n- 独自ルール。',
    ].join('\n\n'));
    // 差し替えであって追記ではない（見出しが増えない）。
    expect(result.systemPrompt.match(/^# Skillガイド$/gm)).toHaveLength(1);
    expect(result.systemPrompt.match(/^# Tool使用ガイド$/gm)).toHaveLength(1);
    expect(result.systemPrompt).not.toContain('old_skill');
    expect(result.systemPrompt).not.toContain('old_tool');
  });

  it('ガイド見出しが無いprompt（自由記述）は、実行規則の手前へ差し込む', () => {
    const prompt = '# 役割\n自由に書いたプロンプト。\n\n# 実行規則\n- 独自ルール。';
    const result = replaceGuideSections(prompt, { skillGuide, toolUsageGuide });
    expect(result.strategy).toBe('appended');
    expect(result.systemPrompt).toBe(['# 役割\n自由に書いたプロンプト。', skillGuide, toolUsageGuide, '# 実行規則\n- 独自ルール。'].join('\n\n'));
  });

  it('見出しがまったく無いpromptは末尾へ追記し、本文はそのまま残す', () => {
    const result = replaceGuideSections('見出しのない自由記述のプロンプト。', { skillGuide, toolUsageGuide });
    expect(result.strategy).toBe('appended');
    expect(result.systemPrompt).toBe(['見出しのない自由記述のプロンプト。', skillGuide, toolUsageGuide].join('\n\n'));
  });

  it('片方だけ存在する場合は、あるほうは差し替え、無いほうだけを差し込む', () => {
    const prompt = '# 役割\nR\n\n# Tool使用ガイド\n- old_tool@1.0.0（古い）\n\n# 実行規則\n- ルール。';
    const result = replaceGuideSections(prompt, { skillGuide, toolUsageGuide });
    expect(result.strategy).toBe('appended');
    expect(result.systemPrompt).toBe(['# 役割\nR', toolUsageGuide, skillGuide, '# 実行規則\n- ルール。'].join('\n\n'));
  });
});
