import { join } from 'node:path';
import { bundledPrompts } from '../../test-support/prompts';
import { describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../../adapters/model/scripted-model-provider';
import { FsToolTemplateCatalog } from '../../adapters/templates/fs-tool-template-catalog';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { Agent } from '../../domain/agent/agent';
import { createAgent } from '../../domain/agent/agent';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { FactoryAbortedError } from '../../domain/factory/errors';
import type { FactoryPlan } from '../../domain/factory/factory-plan';
import type { FactoryGoalInput } from '../../domain/factory/factory-run';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import { GenerateAgentPromptUseCase } from '../agent/generate-agent-prompt';
import { SaveAgentUseCase } from '../agent/save-agent';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { EtlEngine } from '../etl/engine';
import { ModelProviderError, type ModelCompletion, type ModelCompletionRequest } from '../model/model-provider';
import { SaveSkillUseCase } from '../skill/save-skill';
import { SaveToolUseCase } from '../tool/save-tool';
import { agentToolArgumentsOf, describeGraphShapeViolations, describeMultiCategoryStrategy, describeToolSemanticViolations, extractAnswerGuardBlock, factoryAnswerGuardBlock, FACTORY_ANSWER_GUARD_HEADING, GenerateAgentAssetsUseCase, hasOmittableFilters, makeArgumentsOptional, mergeAgentInputDeclarations, replaceGuideSections, resolveReuseTarget, withAnswerGuard, type ToolSemanticContext } from './generate-agent-assets';
import { hasComputedColumns } from './generate-agent-assets';
import { StagedToolGeneration } from './staged-tool-generation';
import { TemplateToolGeneration } from './template-tool-generation';
import { SuggestCalculateExpressionUseCase } from '../tool/suggest-calculate-expression';
import { supportsMultiValueFilterOps } from './roles/tool-smith-role';
import { describeJoinDesignViolations, describeOffendingConfig, escalateRepairFeedback } from './generate-agent-assets';
import { MAX_TOOL_CALLS } from '../agent/run-agent-preview';
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

async function setup(options?: {
  readonly model?: ScriptedModelProvider;
  readonly csv?: string;
  readonly sources?: readonly { readonly id: string; readonly csv: string }[];
  /** 段階的ツール生成（v42）を注入するか。設計タスクと式の台本は本体のモデルと別インスタンスにする。 */
  readonly staged?: boolean;
  /** テンプレート経路（v43）を注入するか。カタログは同梱の `templates/tools` をそのまま読む。 */
  readonly templates?: boolean;
}) {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Sales', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: 30, createdAt: '', updatedAt: '' }, options?.csv ?? 'id,amount\n1,100\n2,200');
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiler = new ProfileDataSourcesUseCase(dataSources, resolver, engine);
  // 追加のデータソース（結合するToolの検証で使う）。既定は従来どおり ds-1 だけ。
  for (const source of options?.sources ?? []) {
    await dataSources.save({ id: source.id, tenant: scope, name: source.id, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: source.csv.length, createdAt: '', updatedAt: '' }, source.csv);
  }
  const profiles = await profiler.executeAll(scope, ['ds-1', ...(options?.sources ?? []).map((source) => source.id)]);

  const model = options?.model ?? new ScriptedModelProvider();
  const toolSmith = new ToolSmithRole(model, bundledPrompts());
  const skillWriter = new SkillWriterRole(model, bundledPrompts());
  const assembler = new AssemblerRole(model, bundledPrompts());

  const toolRepo = new InMemoryToolRepository();
  const skillRepo = new InMemorySkillRepository();
  const agentRepo = new InMemoryAgentRepository();
  const saveTool = new SaveToolUseCase(toolRepo, engine, resolver);
  const saveSkill = new SaveSkillUseCase(skillRepo, toolRepo);
  const saveAgent = new SaveAgentUseCase(agentRepo, toolRepo, skillRepo);
  const generateAgentPrompt = new GenerateAgentPromptUseCase(toolRepo, skillRepo, agentRepo);

  // 段階的経路の台本は本体のモデルと分ける（「ToolSmithを呼んでいない」ことを台本の消費で確かめられる）。
  const stagedTasks = new ScriptedModelProvider();
  const stagedExpressions = new ScriptedModelProvider();
  const staged = options?.staged === true
    ? new StagedToolGeneration(stagedTasks, engine, new SuggestCalculateExpressionUseCase(engine, stagedExpressions, () => true, bundledPrompts()), resolver, bundledPrompts())
    : undefined;

  // テンプレート経路の台本も本体・段階的経路と分ける（「どの経路が走ったか」を台本の消費で見分ける）。
  const templateTasks = new ScriptedModelProvider();
  const templateExpressions = new ScriptedModelProvider();
  const registry = createDefaultRegistry();
  const templates = options?.templates === true
    ? new TemplateToolGeneration(
      templateTasks,
      engine,
      new FsToolTemplateCatalog({ directories: [join(process.cwd(), 'templates', 'tools')], registry }),
      new SuggestCalculateExpressionUseCase(engine, templateExpressions, () => true, bundledPrompts()),
      resolver,
      bundledPrompts(),
    )
    : undefined;

  const useCase = new GenerateAgentAssetsUseCase(toolSmith, skillWriter, assembler, saveTool, saveSkill, saveAgent, generateAgentPrompt, engine, resolver, staged, templates);
  return { model, toolRepo, skillRepo, agentRepo, profiles, useCase, stagedTasks, stagedExpressions, templateTasks, templateExpressions };
}

/** 設計タスク / 式の台本を1件積む。 */
function scripted(value: unknown): ModelCompletion {
  return { message: { role: 'assistant', content: JSON.stringify(value) }, finishReason: 'stop' };
}

/** 既定のデータソース（id,amount）に対する段階的経路の台本（計算列の有無を選べる）。 */
function enqueueStagedTasks(model: ScriptedModelProvider, options?: { readonly computation?: boolean }): void {
  model.enqueue(
    scripted({ period: null, categoryFilters: [] }),
    scripted({ computations: options?.computation === true ? [{ outputColumn: 'doubled', intent: 'amount を2倍にした値' }] : [] }),
    scripted({ columns: [], sort: 'none', limit: 20 }),
  );
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
    // 期待Tool名は publishName ではなく、エージェントが呼ぶ関数名（agentTool.name）で持つ（ADR-0047）。
    expect(result.toolKeyToToolName.get('lookup')).toBe(tool?.agentTool?.name);

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
    expect(result.toolKeyToToolName.has('lookup')).toBe(true);
    expect(result.toolKeyToToolName.has('broken')).toBe(false);
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
    expect(result.toolKeyToToolName.get('today')).toBe('current_datetime');
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
    expect(enhanced?.systemPrompt).toContain('# Extra rules\nAlways cite the rows returned by the lookup tool.');
    // 回答の規律は決定的合成の最後尾に必ず付く（Assemblerの起草物ではない・ADR-0047）。
    expect(enhanced?.systemPrompt.endsWith(factoryAnswerGuardBlock('ja'))).toBe(true);
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
    // 回答の規律ブロックも既存側に持たせる（rewrite の決定的合成は必ずこれを最後尾へ付けるため・ADR-0047）。
    const baseAgent = await seedBaseAgent(agentRepo, [role, '# Skillガイド\n適用するSkillはありません。', '# Tool使用ガイド\n利用可能なToolはありません。', rules, factoryAnswerGuardBlock('ja')].join('\n\n'));
    model.enqueue({ message: { role: 'assistant', content: JSON.stringify({ role, rules }) }, finishReason: 'stop' });

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: noAdditionPlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite' });

    expect(result.roleCallsUsed).toBe(1); // Assemblerは呼ばれた（消費した）が…
    expect(result.agentChanged).toBe(false); // …結果が同じなので保存はしない。
    expect(await agentRepo.listVersions(scope, BASE_AGENT_ID)).toHaveLength(1);
  });
});

/** N回目の呼び出しで「接続中に abort された」adapter を模す: signal を abort してから**独自の**例外で失敗する（FactoryAbortedError ではない）。 */
class MidflightAbortingModel extends ScriptedModelProvider {
  calls = 0;
  constructor(private readonly controller: AbortController, private readonly abortAt: number) { super(); }
  override async complete(request: ModelCompletionRequest, signal?: AbortSignal): Promise<ModelCompletion> {
    this.calls += 1;
    if (this.calls !== this.abortAt) return super.complete(request, signal);
    this.controller.abort(new FactoryAbortedError('Cancelled by user'));
    throw new ModelProviderError('connection reset');
  }
}

describe('GenerateAgentAssetsUseCase（中断: signal は各ロールへ届き、修復ループの再試行や preserve フォールバックへ丸めない）', () => {
  const userCancel = (): FactoryAbortedError => new FactoryAbortedError('Cancelled by user');

  it('abort 済みの signal では ToolSmith を1回も呼ばず FactoryAbortedError で抜ける', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue({ message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' });
    const controller = new AbortController();
    controller.abort(userCancel());

    await expect(useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, signal: controller.signal }))
      .rejects.toBeInstanceOf(FactoryAbortedError);
    expect(model.requests).toHaveLength(0);
  });

  it('修復ループ: 1回目の提案が失敗した後に abort されると再提案せず（次のモデル呼び出しは無い）、Tool は保存されない', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: invalidToolGraphProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
    );
    const controller = new AbortController();
    const kinds: string[] = [];

    await expect(useCase.execute({
      scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, signal: controller.signal,
      onEvent: (event) => { kinds.push(event.kind); if (event.kind === 'tool_repair_attempted') controller.abort(userCancel()); },
    })).rejects.toBeInstanceOf(FactoryAbortedError);

    expect(model.requests).toHaveLength(1);
    expect(kinds).toEqual(['tool_repair_attempted']); // tool_generated / artifact_saved は無い = 保存されていない。
  });

  it('adapter が中断を独自の例外で報告しても（FactoryAbortedError でなくても）signal を見て修復再試行へ回さない', async () => {
    const controller = new AbortController();
    const model = new MidflightAbortingModel(controller, 1);
    const { profiles, useCase } = await setup({ model });
    const kinds: string[] = [];

    await expect(useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, signal: controller.signal, onEvent: (event) => { kinds.push(event.kind); } }))
      .rejects.toBeInstanceOf(FactoryAbortedError);

    expect(model.calls).toBe(1); // 再提案（2回目の呼び出し）は無い。
    expect(kinds).toEqual([]);   // 中断は「失敗した試行」としても記録しない。
  });

  it('Tool 保存直後（tool_generated）に abort されると SkillWriter / Assembler は呼ばれず、Skill / Agent は保存されない', async () => {
    const { model, profiles, useCase, agentRepo } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const controller = new AbortController();
    const kinds: string[] = [];

    await expect(useCase.execute({
      scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, signal: controller.signal,
      onEvent: (event) => { kinds.push(event.kind); if (event.kind === 'tool_generated') controller.abort(userCancel()); },
    })).rejects.toBeInstanceOf(FactoryAbortedError);

    expect(model.requests).toHaveLength(1);
    expect(kinds).toEqual(['tool_generated', 'artifact_saved']); // Skill / Agent の artifact_saved は無い。
    expect(await agentRepo.list(scope)).toHaveLength(0);
  });

  it('rewrite: Assembler が abort で失敗しても preserve へフォールバックせず、既存 Agent の新版を作らない', async () => {
    const controller = new AbortController();
    const model = new MidflightAbortingModel(controller, 3); // tool-smith / skill-writer は通し、assembler で中断する。
    const { profiles, useCase, agentRepo } = await setup({ model });
    const baseAgent = createAgent({
      metadata: { internalId: 'base-agent', workingName: 'Base agent draft', displayName: 'Base Assistant', publishName: 'base_assistant', version: SemVer.of(1, 0, 0), owner: 'alice', state: 'draft', tenant: scope },
      kind: 'normal', systemPrompt: '# 役割\n既存の役割文。', skills: [], tools: [], agents: [],
    });
    await agentRepo.save(baseAgent);
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
    );
    const kinds: string[] = [];

    await expect(useCase.execute({
      scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, baseAgent, promptStrategy: 'rewrite', signal: controller.signal,
      onEvent: (event) => { kinds.push(event.kind); },
    })).rejects.toBeInstanceOf(FactoryAbortedError);

    expect(model.calls).toBe(3);
    expect(kinds).not.toContain('proposal_rejected'); // 「rewrite に失敗したので preserve」の記録は残さない。
    expect(await agentRepo.listVersions(scope, 'base-agent')).toHaveLength(1);
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

  it('旧形式フラットconfigのvalueBindingも引数の消費として数える（domainのvalueBindingsOfへ委譲後も同じ集合）', () => {
    const flat = { column: 'amount', op: 'gte', value: 100, valueBinding: { source: 'agent-input', field: 'minimumAmount' } };
    expect(agentToolArgumentsOf(graphWith(validArguments, flat))).toEqual({ columns: [{ name: 'minimumAmount', type: 'number', nullable: false }] });
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

// ─── ADR-0047: 生成Toolの構造検査・既定呼び出しの溢れ・回答の規律 ──────────────────────────
/** 終端 agent-output の maxRows を差し替えた提案（既定呼び出しで溢れる形を作るため）。 */
function boundedToolProposalJson(options: { readonly maxRows: number; readonly limit?: number; readonly shape?: string }): string {
  const limitNodes = options.limit === undefined ? [] : [{ id: 'cap', type: 'limit', config: { count: options.limit } }];
  const limitEdges = options.limit === undefined
    ? [{ from: 'src', to: 'out' }]
    : [{ from: 'src', to: 'cap' }, { from: 'cap', to: 'out' }];
  return JSON.stringify({
    graph: {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        ...limitNodes,
        { id: 'out', type: 'agent-output', config: { shape: options.shape ?? 'rows', format: 'json', maxRows: options.maxRows, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: limitEdges,
    },
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
  });
}

describe('describeGraphShapeViolations（ノード語彙・木の形の構造検査）', () => {
  const expected = { sources: [{ sourceType: 'csv-source', dataSourceId: 'ds-1' }] };
  const node = (id: string, type: string, config: unknown = {}): { id: string; type: string; config: unknown } => ({ id, type, config });
  const sink = node('out', 'agent-output', { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' });

  it('正常: source → 許可された変換 → agent-output の単一チェーンは違反なし', () => {
    const graph = {
      nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' }), node('p', 'parse-period', { column: 'id' }), node('l', 'limit', { count: 10 }), sink],
      edges: [{ from: 'src', to: 'p' }, { from: 'p', to: 'l' }, { from: 'l', to: 'out' }],
    } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(graph, expected)).toBeUndefined();
  });

  it('異常: 語彙外のノード型は、許可語彙を添えて差し戻す', () => {
    const graph = {
      nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' }), node('db', 'database-source', {}), sink],
      edges: [{ from: 'src', to: 'out' }],
    } as unknown as ToolGraph;
    const message = describeGraphShapeViolations(graph, expected);
    expect(message).toMatch(/node type\(s\) not allowed: database-source/);
    expect(message).toContain('parse-period');
    // join は round 3 で語彙に入ったので、もう語彙外ではない。
    expect(message).toContain('join');
  });

  it('異常: 計画と違うdataSourceId・違うsource種別は具体的に差し戻す', () => {
    const wrongId = { nodes: [node('src', 'csv-source', { dataSourceId: 'other' }), sink], edges: [{ from: 'src', to: 'out' }] } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(wrongId, expected)).toMatch(/which this tool plan does not use. Read exactly "ds-1"/);
    expect(describeGraphShapeViolations(wrongId, expected)).toMatch(/data source "ds-1" is never read/);
    const wrongType = { nodes: [node('src', 'json-source', { dataSourceId: 'ds-1' }), sink], edges: [{ from: 'src', to: 'out' }] } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(wrongType, expected)).toMatch(/use 'csv-source'/);
  });

  it('異常: agent-input をデータ経路へ繋いだら「引数の宣言であってデータ源ではない」と差し戻す', () => {
    const graph = {
      nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' }), node('args', 'agent-input', { schema: { columns: [] } }), sink],
      edges: [{ from: 'src', to: 'out' }, { from: 'args', to: 'out' }],
    } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(graph, expected)).toMatch(/must stay unconnected/);
  });

  it('境界: 枝分かれ（1ノードが2つへ流れる）と、join 以外での合流は差し戻す', () => {
    const graph = {
      nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' }), node('a', 'select', { columns: ['id'] }), node('b', 'select', { columns: ['id'] }), sink],
      edges: [{ from: 'src', to: 'a' }, { from: 'src', to: 'b' }, { from: 'a', to: 'out' }, { from: 'b', to: 'out' }],
    } as unknown as ToolGraph;
    const message = describeGraphShapeViolations(graph, expected);
    expect(message).toMatch(/feed more than one node/);
    expect(message).toMatch(/branches only ever MERGE/);
    expect(message).toMatch(/node 'out' receives 2 inputs, but only a 'join' may merge branches/);
  });

  it('例外: agent-output が無い / 2つある提案も差し戻す', () => {
    const none = { nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' })], edges: [] } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(none, expected)).toMatch(/exactly one 'agent-output' node, found 0/);
    const two = {
      nodes: [node('src', 'csv-source', { dataSourceId: 'ds-1' }), sink, node('out2', 'agent-output', sink.config)],
      edges: [{ from: 'src', to: 'out' }],
    } as unknown as ToolGraph;
    expect(describeGraphShapeViolations(two, expected)).toMatch(/exactly one 'agent-output' node, found 2/);
  });
});

describe('GenerateAgentAssetsUseCase（既定呼び出しの溢れガードと構造検査を修復ループへ回す）', () => {
  it('異常: 引数なしの呼び出しが maxRows を超えるToolは、直し方を添えて修復ループへ回す', async () => {
    const { model, toolRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: boundedToolProposalJson({ maxRows: 1 }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: boundedToolProposalJson({ maxRows: 1, limit: 1 }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/calling this tool with no arguments returns 2 rows, which overflows/);
    expect(messages[0]).toMatch(/append a 'limit' node with count <= 1/);
    // 2回目の提案（limitで縛った形）は通る。
    expect(result.toolRefs).toHaveLength(1);
    const toolRef = result.toolRefs[0]!;
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.graph.nodes.some((node) => node.type === 'limit')).toBe(true);
    // 差し戻し文言はそのまま次の提案へ priorError として渡る。
    expect(String(model.requests[1]?.messages.find((message) => message.role === 'user')?.content)).toContain('priorValidationError');
  });

  it('境界(回帰固定): 行数がちょうど maxRows なら溢れとみなさず、従来どおり保存できる', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: boundedToolProposalJson({ maxRows: 2 }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages).toEqual([]);
    expect(result.toolRefs).toHaveLength(1);
  });

  it('境界(回帰固定): shape が summary のToolは行数を載せないので、従来どおり溢れガードに掛からない', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: boundedToolProposalJson({ maxRows: 1, shape: 'summary' }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages).toEqual([]);
  });

  it('異常: 語彙外ノードを含む提案は、エンジン検証より手前で構造違反として差し戻す', async () => {
    const { model, profiles, useCase } = await setup();
    const withWorkspaceOutput = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'ws', type: 'workspace-output', config: { name: 'x', artifactKind: 'table', writeMode: 'create', onConflict: 'new-revision', previewRows: 10 } },
        ],
        edges: [{ from: 'src', to: 'ws' }],
      },
      agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
    });
    model.enqueue(
      { message: { role: 'assistant', content: withWorkspaceOutput }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/tool graph shape is invalid: node type\(s\) not allowed: workspace-output/);
    expect(result.toolRefs).toHaveLength(1);
  });
});

describe('回答の規律ブロック（決定的・プロンプト改訂で消えない）', () => {
  it('正常: 生成Agentのsystem promptの末尾へ必ず入り、0行・時点/単位・注記の規律を含む', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt.endsWith(factoryAnswerGuardBlock('ja'))).toBe(true);
    expect(agent?.systemPrompt).toContain(FACTORY_ANSWER_GUARD_HEADING);
    expect(agent?.systemPrompt).toMatch(/ツールが返した行から引き写す/);
    expect(agent?.systemPrompt).toMatch(/0 件を「値が 0 である」と書き換えない/);
    expect(agent?.systemPrompt).toMatch(/時点（期間）と単位を必ず併記/);
    expect(agent?.systemPrompt).toMatch(/注記（備考）/);
  });

  it('正常: goal.language が en なら英語の規律ブロックを使う', () => {
    expect(factoryAnswerGuardBlock('en')).toContain('Take every number, count and ranking verbatim');
    expect(factoryAnswerGuardBlock('en').startsWith(FACTORY_ANSWER_GUARD_HEADING)).toBe(true);
  });

  it('境界: 既に規律ブロックを含む合成結果には二重に付けない', () => {
    const composed = withAnswerGuard(['# Role\nx', factoryAnswerGuardBlock('ja'), '# Extra rules\ny']);
    expect(composed.split(FACTORY_ANSWER_GUARD_HEADING)).toHaveLength(2);
  });

  it('境界: 後続のトップレベル見出しで規律ブロックの範囲が切れる（利用者の節を巻き込まない）', () => {
    const prompt = [factoryAnswerGuardBlock('ja'), '# 独自メモ\n利用者が書いた節。'].join('\n\n');
    const extracted = extractAnswerGuardBlock(prompt);
    expect(extracted).toBe(factoryAnswerGuardBlock('ja'));
    expect(extracted).not.toContain('独自メモ');
  });

  it('例外: 規律ブロックが無いプロンプトからは undefined を返す', () => {
    expect(extractAnswerGuardBlock('# Role\nx')).toBeUndefined();
  });
});

// ─── ADR-0047 round 2: 証拠列の保全・範囲で引けること・1回で複数カテゴリ ────────────────────
/** e-Stat 風のCSV（粒度混在の期間列・48地域に見立てた3地域・値の列・注記列）。 */
const ESTAT_CSV = [
  '時点,地域,総人口（総数）【人】,注記',
  '2022年,東京都,14038000,推計値',
  '2023年,東京都,14212596,推計値',
  '2022年,大阪府,8782000,推計値',
  '2023年,大阪府,8763000,推計値',
  '2023年10月,全国,124352000,月次の参考値',
].join('\n');

const ESTAT_COLUMNS = ['時点', '地域', '総人口（総数）【人】', '注記'];

/**
 * 期間列を扱うTool提案を組み立てる。既定は「実測で生成された、答えられないTool」の形
 * （select が 時点/注記 を落とし、同じ引数を gte と lte へ束縛し、string型、sortなし）。
 */
function periodToolProposalJson(overrides?: {
  readonly selectColumns?: readonly string[] | null;
  readonly argumentType?: string;
  readonly splitRange?: boolean;
  readonly sort?: 'asc' | 'desc' | null;
}): string {
  const split = overrides?.splitRange === true;
  const columns = split
    ? [{ name: 'period_from', type: overrides?.argumentType ?? 'date', nullable: true }, { name: 'period_to', type: overrides?.argumentType ?? 'date', nullable: true }]
    : [{ name: 'time_point', type: overrides?.argumentType ?? 'string', nullable: true }];
  const conditions = split
    ? [
        { column: 'periodStart', op: 'gte', value: '2022-01-01', valueBinding: { source: 'agent-input', field: 'period_from' } },
        { column: 'periodStart', op: 'lte', value: '2023-12-31', valueBinding: { source: 'agent-input', field: 'period_to' } },
      ]
    : [
        { column: 'periodStart', op: 'gte', value: '2023-01-01', valueBinding: { source: 'agent-input', field: 'time_point' } },
        { column: 'periodStart', op: 'lte', value: '2023-01-01', valueBinding: { source: 'agent-input', field: 'time_point' } },
      ];
  const sortDirection = overrides?.sort === undefined ? null : overrides.sort;
  const selectColumns = overrides?.selectColumns === undefined ? ['地域', '総人口（総数）【人】'] : overrides.selectColumns;

  const nodes: unknown[] = [
    { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'period', type: 'parse-period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 } },
    { id: 'gran', type: 'filter', config: { column: 'periodGranularity', op: 'eq', value: 'year' } },
    { id: 'range', type: 'filter', config: { conditions, combine: 'and' } },
  ];
  const chain = ['src', 'period', 'gran', 'range'];
  // 並べ替えは select より前に置く（select が periodStart を落としても sort が成立する現実の形）。
  if (sortDirection !== null) { nodes.push({ id: 'ord', type: 'sort', config: { keys: [{ column: 'periodStart', direction: sortDirection }] } }); chain.push('ord'); }
  if (selectColumns !== null) { nodes.push({ id: 'sel', type: 'select', config: { columns: selectColumns } }); chain.push('sel'); }
  nodes.push({ id: 'cap', type: 'limit', config: { count: 100 } }); chain.push('cap');
  nodes.push({ id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } }); chain.push('out');
  nodes.push({ id: 'args', type: 'agent-input', config: { schema: { columns }, sample: {} } });

  const edges = chain.slice(0, -1).map((from, index) => ({ from, to: chain[index + 1]! }));
  return JSON.stringify({ graph: { nodes, edges }, agentTool: { name: 'lookup_population', description: 'Look up population rows.' } });
}

/** 期間列を持つ計画（「最新」を求めない既定の目的）。 */
const periodPlan: FactoryPlan = {
  agentBrief: { displayName: 'Population Assistant', role: 'Answers population questions.' },
  tools: [{ key: 'lookup', displayName: 'Lookup Population', purpose: '期間を指定した人口の推移に答える。', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
  skills: [],
  personas: [],
  scenarios: [],
};

/** 「最新」を求める計画（並べ替えの向きまで検査される）。 */
const latestPlan: FactoryPlan = {
  ...periodPlan,
  tools: [{ ...periodPlan.tools[0]!, purpose: '最新の人口を答える。' }],
};

/** `describeToolSemanticViolations` を実データのスキーマ伝播つきで呼ぶ（本番と同じ経路）。 */
async function semanticViolationOf(proposalJson: string, plan: FactoryPlan = periodPlan, csv: string = ESTAT_CSV): Promise<string | undefined> {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Population', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: csv.length, createdAt: '', updatedAt: '' }, csv);
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profile = (await new ProfileDataSourcesUseCase(dataSources, resolver, engine).executeAll(scope, ['ds-1']))[0]!;
  const graph = makeArgumentsOptional(mergeAgentInputDeclarations(JSON.parse(proposalJson).graph as ToolGraph));
  const propagation = engine.propagateSchemas(await resolver.execute(scope, graph));
  expect(propagation.hasErrors).toBe(false);
  return describeToolSemanticViolations({ graph, profile, toolPlan: plan.tools[0]!, inputSchema: agentToolArgumentsOf(graph), propagation });
}

describe('describeToolSemanticViolations（証拠列の保全・Defect A）', () => {
  it('異常: selectが期間ラベル列を落としたら、それを残せという文面で差し戻す', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ['地域', '総人口（総数）【人】'], splitRange: true, argumentType: 'date', sort: 'desc' }));

    expect(message).toMatch(/do not contain the period column '時点'/);
    expect(message).toMatch(/add it to select.columns, or drop the select node/);
    // periodStart で代替させない（エージェントが引用するのはデータが使っているラベル）。
    expect(message).toMatch(/'periodStart' is not a replacement/);
  });

  it('異常: 値の列まで落ちていたら「答えるものが無い」と指摘する', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ['時点', '地域'], splitRange: true, argumentType: 'date', sort: 'desc' }));

    expect(message).toMatch(/contain none of the value columns \('総人口（総数）【人】'\)/);
  });

  it('正常: 期間ラベル列と値の列を残していれば違反なし（selectを置くこと自体は禁じない）', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'date', sort: 'desc' }));

    expect(message).toBeUndefined();
  });

  it('境界: selectが無い（全列を返す）Toolは証拠列の検査を必ず通る', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: null, splitRange: true, argumentType: 'date', sort: 'desc' }));

    expect(message).toBeUndefined();
  });

  it('境界(回帰固定): 期間列を持たないデータソースでは、従来どおり証拠列の検査を行わない', async () => {
    const plain = 'id,amount\n1,100\n2,200';
    const proposal = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'sel', type: 'select', config: { columns: ['id'] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
      },
      agentTool: { name: 'lookup_sales', description: 'Look up sales rows.' },
    });

    expect(await semanticViolationOf(proposal, periodPlan, plain)).toBeUndefined();
  });
});

describe('describeToolSemanticViolations（範囲で引けること・Defect B）', () => {
  it('異常: 同じ引数を下限と上限の両方へ束縛したら、2つのnullable引数へ分けろと差し戻す', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, sort: 'desc' }));

    expect(message).toMatch(/argument 'time_point' is bound to both a lower bound \(gte\) and an upper bound \(lte\)/);
    expect(message).toMatch(/only ever matches one exact point in time/);
    expect(message).toMatch(/'time_point_from'.*'time_point_to'/);
  });

  it('異常: date列を絞る引数がstring宣言なら、date型で宣言し直せと差し戻す', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'string', sort: 'desc' }));

    expect(message).toMatch(/filters the date column 'periodStart' but is declared "type": "string"/);
    expect(message).toMatch(/"type": "date", "nullable": true/);
  });

  it('異常: 期間を開いたのに開始日で並べ替えていないToolは「最新が分からない」として差し戻す', async () => {
    const message = await semanticViolationOf(periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'date', sort: null }));

    expect(message).toMatch(/never sorts by 'periodStart'/);
    expect(message).toMatch(/"direction": "desc"/);
  });

  it('境界: 目的が「最新」を求めるのに昇順で並べ替えていたら向きまで差し戻す', async () => {
    const ascending = periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'date', sort: 'asc' });

    // 「最新」を求めない目的なら昇順のままでも通す（向きの強制はキーワードがある場合だけ）。
    expect(await semanticViolationOf(ascending, periodPlan)).toBeUndefined();
    const message = await semanticViolationOf(ascending, latestPlan);
    expect(message).toMatch(/sorts 'periodStart' ascending, so a limit keeps the OLDEST rows/);
  });

  it('例外: 集計して返すTool（shape: summary）には並べ替え・証拠列の検査を掛けない', async () => {
    const summarised = periodToolProposalJson({ selectColumns: ['地域', '総人口（総数）【人】'], splitRange: true, argumentType: 'date', sort: null })
      .replace('"shape":"rows"', '"shape":"summary"');

    expect(await semanticViolationOf(summarised, latestPlan)).toBeUndefined();
  });
});

describe('GenerateAgentAssetsUseCase（意味の違反は修復ループへ回る）', () => {
  it('異常: 証拠列を落とした提案は修復ループへ回り、直した2回目の提案が保存される', async () => {
    const { model, toolRepo, profiles, useCase } = await setup({ csv: ESTAT_CSV });
    model.enqueue(
      { message: { role: 'assistant', content: periodToolProposalJson({ selectColumns: ['地域', '総人口（総数）【人】'], splitRange: true, argumentType: 'date', sort: 'desc' }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'date', sort: 'desc' }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: periodPlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/tool cannot answer the plan: the rows this tool returns do not contain the period column '時点'/);
    expect(result.toolRefs).toHaveLength(1);
    const toolRef = result.toolRefs[0]!;
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.inputSchema?.columns.map((column) => `${column.name}:${column.type}`)).toEqual(['period_from:date', 'period_to:date']);
  });
});

describe('回答の規律ブロック（複数カテゴリを1回で・Defect C）', () => {
  it('正常: 引数を省略できるToolがあるときだけ「1回だけ呼んで行を選ぶ」規律を足す', () => {
    const withFilters = factoryAnswerGuardBlock('ja', { omittableFilters: true });
    expect(withFilters).toMatch(/対象ごとにツールを呼び分けない/);
    expect(withFilters).toMatch(/絞り込み引数を省略して1回だけ呼び/);
    // 引数なしのTool構成では、守れない指示を書かない。
    expect(factoryAnswerGuardBlock('ja')).not.toMatch(/呼び分けない/);
    expect(factoryAnswerGuardBlock('en', { omittableFilters: true })).toMatch(/do NOT call the tool once per item/);
  });

  it('正常: nullable引数を持つToolを生成したAgentのpromptには、その規律が入る', async () => {
    const { model, agentRepo, profiles, useCase } = await setup({ csv: ESTAT_CSV });
    model.enqueue(
      { message: { role: 'assistant', content: periodToolProposalJson({ selectColumns: ESTAT_COLUMNS, splitRange: true, argumentType: 'date', sort: 'desc' }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: periodPlan, profiles, maxRepairAttempts: 2 });

    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).toMatch(/対象ごとにツールを呼び分けない/);
  });

  it('境界: 引数を宣言しないToolだけのAgentには、その規律を足さない', async () => {
    const { model, agentRepo, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).toContain(FACTORY_ANSWER_GUARD_HEADING);
    expect(agent?.systemPrompt).not.toMatch(/呼び分けない/);
  });

  it('正常: hasOmittableFilters は inputSchema の nullable 宣言だけを根拠にする', () => {
    const tool = (columns: { name: string; type: 'string'; nullable: boolean }[] | undefined) => ({
      inputSchema: columns === undefined ? undefined : { columns },
    } as unknown as Parameters<typeof hasOmittableFilters>[0][number]);

    expect(hasOmittableFilters([tool(undefined)])).toBe(false);
    expect(hasOmittableFilters([tool([{ name: 'region', type: 'string', nullable: false }])])).toBe(false);
    expect(hasOmittableFilters([tool([{ name: 'region', type: 'string', nullable: true }])])).toBe(true);
  });

  it('正常: Assemblerへ会話あたりのツール呼び出し上限を渡し、1対象1呼び出しの規則を書かせない', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });

    const assemblerRequest = model.requests[2];
    expect(String(assemblerRequest?.messages.find((message) => message.role === 'user')?.content)).toContain(`"toolCallBudget":${MAX_TOOL_CALLS}`);
    expect(String(assemblerRequest?.messages.find((message) => message.role === 'system')?.content)).toMatch(/Never write a rule that implies one call per item/);
  });
});

// ─── ADR-0047 round 3: 複数データソースを結合するTool ─────────────────────────────────
/** 賃金のファイル（主データソース `ds-1` として登録する）。 */
const WAGE_CSV = [
  '時点,地域コード,地域,現金給与総額【円】,注記',
  '2023年,01000,北海道,280000,推計値',
  '2023年,13000,東京都,390000,推計値',
  '2024年,01000,北海道,285000,推計値',
  '2024年,13000,東京都,398000,推計値',
].join('\n');
/** 労働時間のファイル（結合先 `ds-hours`）。同じキー列を持ち、値の列だけが違う。 */
const HOURS_CSV = [
  '時点,地域コード,地域,総実労働時間【時間】,注記',
  '2023年,01000,北海道,138,確報',
  '2023年,13000,東京都,141,確報',
  '2024年,01000,北海道,137,速報',
  '2024年,13000,東京都,140,速報',
].join('\n');

const joinedPlan: FactoryPlan = {
  agentBrief: { displayName: 'Wage Assistant', role: '賃金と労働時間を説明する。' },
  tools: [{
    key: 'joined', displayName: 'Wage and hours', purpose: '同じ時点・同じ地域の賃金と労働時間を並べる。',
    dataSourceId: 'ds-1', sideEffect: 'read-only', additionalDataSourceIds: ['ds-hours'],
  }],
  skills: [], personas: [], scenarios: [],
};

/**
 * 2ソースを結合する提案。既定は「正しい形」で、overrides で実測の失敗を再現する。
 * 形: ds-1 → ┐ join(時点 + 地域コード, inner) → [select] → limit → agent-output
 *     ds-hours → ┘（右の注記/地域は suffix 付きで残る）
 */
function joinedProposalJson(overrides?: {
  readonly keys?: readonly { readonly left: string; readonly right: string }[];
  readonly mode?: string;
  readonly selectColumns?: readonly string[];
  readonly toInputs?: readonly [number, number];
}): string {
  const keys = overrides?.keys ?? [{ left: '時点', right: '時点' }, { left: '地域コード', right: '地域コード' }];
  const toInputs = overrides?.toInputs ?? [0, 1];
  const nodes: unknown[] = [
    { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'hours', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
    { id: 'j', type: 'join', config: { mode: overrides?.mode ?? 'inner', keys, rightSuffix: '_right' } },
  ];
  const chain: string[] = ['j'];
  if (overrides?.selectColumns !== undefined) { nodes.push({ id: 'sel', type: 'select', config: { columns: overrides.selectColumns } }); chain.push('sel'); }
  nodes.push({ id: 'cap', type: 'limit', config: { count: 100 } }); chain.push('cap');
  nodes.push({ id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } }); chain.push('out');

  const edges: unknown[] = [
    { from: 'wage', to: 'j', toInput: toInputs[0] },
    { from: 'hours', to: 'j', toInput: toInputs[1] },
    ...chain.slice(0, -1).map((from, index) => ({ from, to: chain[index + 1]! })),
  ];
  return JSON.stringify({ graph: { nodes, edges }, agentTool: { name: 'wage_and_hours', description: '同じ時点・地域の賃金と労働時間を返す。' } });
}

/** 結合Toolを本番と同じ経路（実エンジン・実データ）で検証し、違反文面を返す。 */
async function joinedViolationOf(proposalJson: string): Promise<string | undefined> {
  const dataSources = new InMemoryDataSourceRepository();
  await dataSources.save({ id: 'ds-1', tenant: scope, name: 'Wage', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: WAGE_CSV.length, createdAt: '', updatedAt: '' }, WAGE_CSV);
  await dataSources.save({ id: 'ds-hours', tenant: scope, name: 'Hours', kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: HOURS_CSV.length, createdAt: '', updatedAt: '' }, HOURS_CSV);
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiles = await new ProfileDataSourcesUseCase(dataSources, resolver, engine).executeAll(scope, ['ds-1', 'ds-hours']);
  const graph = makeArgumentsOptional(mergeAgentInputDeclarations(JSON.parse(proposalJson).graph as ToolGraph));
  const resolved = await resolver.execute(scope, graph);
  const propagation = engine.propagateSchemas(resolved);
  if (propagation.hasErrors) {
    return `graph validation failed: ${Object.values(propagation.nodes).flatMap((node) => node.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message)).join('; ')}`;
  }
  return describeToolSemanticViolations({
    graph, profile: profiles[0]!, additionalProfiles: [profiles[1]!], toolPlan: joinedPlan.tools[0]!,
    inputSchema: agentToolArgumentsOf(graph), propagation, preview: engine.preview(resolved),
  });
}

describe('describeGraphShapeViolations（複数ソースが join で合流する木）', () => {
  const twoSources = { sources: [{ dataSourceId: 'ds-1', sourceType: 'csv-source' }, { dataSourceId: 'ds-hours', sourceType: 'csv-source' }] };
  const graphOf = (json: string): ToolGraph => JSON.parse(json).graph as ToolGraph;

  it('正常: 各ソースが自分の枝を持ち join で1回だけ合流する木は違反なし', () => {
    expect(describeGraphShapeViolations(graphOf(joinedProposalJson()), twoSources)).toBeUndefined();
  });

  it('異常: 計画にあるデータソースを読んでいなければ、追加すべきノードを名指しで差し戻す', () => {
    const singleSource = JSON.stringify({
      graph: {
        nodes: [
          { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'wage', to: 'out' }],
      },
    });
    const message = describeGraphShapeViolations(graphOf(singleSource), twoSources);
    expect(message).toMatch(/data source "ds-hours" is never read: add a 'csv-source' node/);
  });

  it('異常: 同じデータソースを2回読む提案は差し戻す', () => {
    const twice = JSON.parse(joinedProposalJson()) as { graph: ToolGraph };
    const graph = { ...twice.graph, nodes: twice.graph.nodes.map((node) => node.id === 'hours' ? { ...node, config: { dataSourceId: 'ds-1' } } : node) };
    expect(describeGraphShapeViolations(graph, twoSources)).toMatch(/data source "ds-1" is read 2 times/);
  });

  it('異常: join の2本のエッジに toInput 0/1 が揃っていなければ差し戻す', () => {
    const message = describeGraphShapeViolations(graphOf(joinedProposalJson({ toInputs: [0, 0] })), twoSources);
    expect(message).toMatch(/must carry "toInput": 0 \(left\) and "toInput": 1 \(right\)/);
  });

  it('境界: join 以外のノードで枝が合流したら「join を置け」と差し戻す', () => {
    const merged = JSON.stringify({
      graph: {
        nodes: [
          { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'hours', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'wage', to: 'out' }, { from: 'hours', to: 'out' }],
      },
    });
    expect(describeGraphShapeViolations(graphOf(merged), twoSources)).toMatch(/only a 'join' may merge branches/);
  });

  it('例外: sourceノードへ入力を繋いだ提案も差し戻す', () => {
    const intoSource = JSON.parse(joinedProposalJson()) as { graph: ToolGraph };
    const graph = { ...intoSource.graph, edges: [...intoSource.graph.edges, { from: 'cap', to: 'hours' }] };
    expect(describeGraphShapeViolations(graph, twoSources)).toMatch(/the source node 'hours' must not receive any input/);
  });
});

describe('describeToolSemanticViolations（結合の検査・実データ）', () => {
  it('正常(回帰固定): 正しく組まれた結合Toolは従来どおり素通りする（新しい検査で誤検知しない）', async () => {
    // 時点/地域コードで結合すると右側の同名列は出力から消えるが、左側の '時点' が残るので期間の検査も通る。
    expect(await joinedViolationOf(joinedProposalJson())).toBeUndefined();
  });

  it('異常: 片方のソースの値列だけ残す select は「答えるものが無い」と差し戻す', async () => {
    const message = await joinedViolationOf(joinedProposalJson({ selectColumns: ['時点', '地域コード', '現金給与総額【円】'] }));

    expect(message).toMatch(/contain none of the value columns of the joined source "ds-hours"/);
    expect(message).toMatch(/rename it before the join if both sides use the same name/);
  });

  it('異常: キーが足りず行が増える結合は、足すべきキー列を名指しで差し戻す', async () => {
    const message = await joinedViolationOf(joinedProposalJson({ keys: [{ left: '時点', right: '時点' }] }));

    expect(message).toMatch(/produced 8 rows from 4 × 4 input rows, so the rows multiplied/);
    expect(message).toMatch(/key is not unique: join also on '地域コード'/);
  });

  it('異常(回帰固定): 左右に無いキー列は、従来どおりエンジンのスキーマ検証が列名つきで捕まえる', async () => {
    const message = await joinedViolationOf(joinedProposalJson({ keys: [{ left: '時点', right: '存在しない列' }] }));

    expect(message).toMatch(/join: right key column not found: 存在しない列/);
  });

  it('境界(回帰固定): join を持たないToolには、従来どおり結合の検査を掛けない', async () => {
    const singleSource = JSON.stringify({
      graph: {
        nodes: [
          { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'wage', to: 'out' }],
      },
    });
    const message = await joinedViolationOf(singleSource);
    // ds-hours の値列が無いことだけが残る（結合そのものの検査は走らない）。
    expect(message).toMatch(/joined source "ds-hours"/);
    expect(message).not.toMatch(/rows multiplied/);
  });
});

describe('GenerateAgentAssetsUseCase（結合Toolの生成と複数ソースの解決）', () => {
  it('正常: 2つのCSVを読む1つのToolを保存し、両方のデータソースが実行時に解決される', async () => {
    const { model, toolRepo, profiles, useCase } = await setup({ csv: WAGE_CSV, sources: [{ id: 'ds-hours', csv: HOURS_CSV }] });
    model.enqueue(
      { message: { role: 'assistant', content: joinedProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: joinedPlan, profiles, maxRepairAttempts: 2 });

    expect(result.toolRefs).toHaveLength(1);
    const toolRef = result.toolRefs[0]!;
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    const sourceIds = (tool?.graph.nodes ?? []).filter((node) => node.type === 'csv-source').map((node) => (node.config as { dataSourceId?: string }).dataSourceId);
    expect(sourceIds).toEqual(['ds-1', 'ds-hours']);
    expect(tool?.graph.nodes.some((node) => node.type === 'join')).toBe(true);
    // ToolSmithには両方のプロファイルが渡る。
    expect(String(model.requests[0]?.messages.find((message) => message.role === 'user')?.content)).toContain('総実労働時間【時間】');
  });

  it('異常: キー不足で行が増える提案は修復ループへ回り、直した2回目が保存される', async () => {
    const { model, profiles, useCase } = await setup({ csv: WAGE_CSV, sources: [{ id: 'ds-hours', csv: HOURS_CSV }] });
    model.enqueue(
      { message: { role: 'assistant', content: joinedProposalJson({ keys: [{ left: '時点', right: '時点' }] }) }, finishReason: 'stop' },
      { message: { role: 'assistant', content: joinedProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: joinedPlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/the rows multiplied/);
    expect(result.toolRefs).toHaveLength(1);
  });

  it('例外: 結合先のプロファイルが無い計画は、そのToolだけ欠落として記録して続行する', async () => {
    const { model, profiles, useCase } = await setup({ csv: WAGE_CSV });
    model.enqueue({ message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' });
    const messages: string[] = [];

    await expect(useCase.execute({ scope, runId: 'run-1', goal, plan: joinedPlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } }))
      .rejects.toThrow(/no tools could be generated/);
    expect(messages[0]).toMatch(/no data profile available for one of additionalDataSourceIds \[ds-hours\]/);
    // ToolSmithは呼ばれない（結合が組めないと分かっている計画にモデル呼び出しを使わない）。
    expect(model.requests).toHaveLength(0);
  });
});

describe('回答の規律（複数カテゴリの頼み方は保存済みToolの契約から決める）', () => {
  const toolWith = (graph: unknown, inputSchema: unknown): Parameters<typeof describeMultiCategoryStrategy>[0][number] =>
    ({ graph, inputSchema }) as unknown as Parameters<typeof describeMultiCategoryStrategy>[0][number];
  const inGraph = {
    nodes: [{ id: 'f', type: 'filter', config: { conditions: [{ column: '地域', op: 'in', values: ['東京都'], valueBinding: { source: 'agent-input', field: 'regions' } }] } }],
    edges: [],
  };
  const eqGraph = {
    nodes: [{ id: 'f', type: 'filter', config: { column: '地域', op: 'eq', value: '東京都', valueBinding: { source: 'agent-input', field: 'region' } } }],
    edges: [],
  };

  it('正常: in で束縛された省略可能な引数があれば「カンマ区切りで1回」と書く', () => {
    const strategy = describeMultiCategoryStrategy([toolWith(inGraph, { columns: [{ name: 'regions', type: 'string', nullable: true }] })]);

    expect(strategy).toBe('in-list');
    const block = factoryAnswerGuardBlock('ja', { multiCategory: strategy });
    expect(block).toMatch(/カンマ区切りで並べて/);
    expect(block).toMatch(/引数を省略すれば全カテゴリが返る/);
    expect(factoryAnswerGuardBlock('en', { multiCategory: strategy })).toMatch(/comma-separated list/);
  });

  it('正常: 単一値（eq）のカテゴリ引数しか無ければ、従来どおり「省略して1回」と書く', () => {
    const strategy = describeMultiCategoryStrategy([toolWith(eqGraph, { columns: [{ name: 'region', type: 'string', nullable: true }] })]);

    expect(strategy).toBe('omit-filter');
    expect(factoryAnswerGuardBlock('ja', { multiCategory: strategy })).toMatch(/絞り込み引数を省略して1回だけ呼び/);
  });

  it('境界: 引数を宣言しないToolだけなら、どちらの言い回しも書かない', () => {
    expect(describeMultiCategoryStrategy([toolWith(eqGraph, undefined)])).toBeUndefined();
    expect(factoryAnswerGuardBlock('ja', { multiCategory: undefined })).not.toMatch(/呼び分けない/);
  });

  it('境界: in で束縛されていても引数が必須（nullable でない）なら、どちらの言い回しも書かない', () => {
    // 省略もできず「全カテゴリ」も返せない契約なので、書ける規律が無い。
    expect(describeMultiCategoryStrategy([toolWith(inGraph, { columns: [{ name: 'regions', type: 'string', nullable: false }] })])).toBeUndefined();
  });

  it('例外: グラフの形が壊れているToolでも落ちず、判定は他のToolに委ねる', () => {
    expect(describeMultiCategoryStrategy([toolWith(undefined, undefined)])).toBeUndefined();
    expect(describeMultiCategoryStrategy([toolWith({ nodes: [null, { type: 'filter', config: null }] }, undefined)])).toBeUndefined();
  });
});

describe('describeToolSemanticViolations（複数値カテゴリ引数・Part 2）', () => {
  /** `in` を含むグラフはエンジンの語彙に依存するので、伝播結果は手で組んで検査だけを回す。 */
  function contextFor(op: string, argumentType: string): ToolSemanticContext {
    const graph = {
      nodes: [
        { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'f', type: 'filter', config: { column: '地域', op, ...(op === 'in' ? { values: ['東京都'] } : { value: '東京都' }), valueBinding: { source: 'agent-input', field: 'regions' } } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'regions', type: argumentType, nullable: true }] }, sample: {} } },
      ],
      edges: [{ from: 'src', to: 'f' }, { from: 'f', to: 'out' }],
    } as unknown as ToolGraph;
    const schema = { columns: [{ name: '時点', type: 'string' as const, nullable: false }, { name: '地域', type: 'string' as const, nullable: false }, { name: '値', type: 'number' as const, nullable: true }] };
    return {
      graph,
      profile: {
        dataSourceId: 'ds-1', name: 'S', kind: 'file', format: 'csv', columns: schema.columns,
        sampleRowCount: 0, sampleRows: [], rowCount: 4,
        periodColumns: [{ column: '時点', granularities: { year: 4 }, minStart: '2023-01-01', maxStart: '2024-01-01', mixed: false }],
        categoricalColumns: [{ column: '地域', distinctCount: 2, values: ['北海道', '東京都'] }],
        joinCandidates: [],
      },
      toolPlan: { key: 't', displayName: 'T', purpose: '地域別の値を返す。', dataSourceId: 'ds-1', sideEffect: 'read-only' },
      inputSchema: { columns: [{ name: 'regions', type: argumentType as 'string', nullable: true }] },
      propagation: {
        order: ['src', 'f', 'out'],
        terminalId: 'out',
        nodes: {
          src: { nodeId: 'src', schema, state: 'confirmed', issues: [] },
          f: { nodeId: 'f', schema, state: 'confirmed', issues: [] },
          out: { nodeId: 'out', schema, state: 'confirmed', issues: [] },
        },
        hasErrors: false,
      },
    };
  }

  it('異常: in で束縛した引数が string でなければ、カンマ区切りの一覧だと添えて差し戻す', () => {
    const message = describeToolSemanticViolations(contextFor('in', 'number'));

    expect(message).toMatch(/argument 'regions' is bound to an 'in' condition on '地域' but is declared "type": "number"/);
    expect(message).toMatch(/single STRING holding a comma-separated list/);
  });

  it('正常(回帰固定): in で束縛した string 引数は従来どおり素通りする（誤検知しない）', () => {
    expect(describeToolSemanticViolations(contextFor('in', 'string'))).toBeUndefined();
  });

  it('境界: eq のカテゴリ引数を差し戻すのは、filter が複数値演算子を持つビルドだけ', () => {
    const message = describeToolSemanticViolations(contextFor('eq', 'string'));

    if (supportsMultiValueFilterOps()) {
      expect(message).toMatch(/filters the category column '地域' with 'eq'/);
      expect(message).toMatch(/"op": "in"/);
    } else {
      // エンジンが受け付けない演算子を強制すると、修復ループが空回りしてRunごと落ちる。
      expect(message).toBeUndefined();
    }
  });
});

describe('describeToolSemanticViolations（結合キーの検査・伝播を手で組んだ単体）', () => {
  /**
   * 現行エンジンでは「キー列が無い」「キーの型が違う」は `propagateSchemas` が先に error にするため、
   * 本番経路ではこの検査は控えの砦になる。文面の質と、エンジンの規則が変わったときの安全網を固定する。
   */
  function joinContext(keys: readonly { readonly left: string; readonly right: string }[]): ToolSemanticContext {
    const leftSchema = { columns: [{ name: '時点', type: 'string' as const, nullable: false }, { name: '賃金', type: 'number' as const, nullable: true }] };
    const rightSchema = { columns: [{ name: '時点', type: 'number' as const, nullable: false }, { name: '労働時間', type: 'number' as const, nullable: true }] };
    const graph = {
      nodes: [
        { id: 'l', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
        { id: 'r', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
        { id: 'j', type: 'join', config: { mode: 'inner', keys } },
        { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
      ],
      edges: [{ from: 'l', to: 'j', toInput: 0 }, { from: 'r', to: 'j', toInput: 1 }, { from: 'j', to: 'out' }],
    } as unknown as ToolGraph;
    const emptyProfile = { sampleRowCount: 0, sampleRows: [], periodColumns: [], categoricalColumns: [], joinCandidates: [] } as const;
    return {
      graph,
      profile: { dataSourceId: 'ds-1', name: 'L', kind: 'file', format: 'csv', columns: leftSchema.columns, rowCount: 4, ...emptyProfile },
      additionalProfiles: [{ dataSourceId: 'ds-hours', name: 'R', kind: 'file', format: 'csv', columns: rightSchema.columns, rowCount: 4, ...emptyProfile }],
      toolPlan: { key: 't', displayName: 'T', purpose: 'p', dataSourceId: 'ds-1', sideEffect: 'read-only', additionalDataSourceIds: ['ds-hours'] },
      inputSchema: undefined,
      propagation: {
        order: ['l', 'r', 'j', 'out'],
        terminalId: 'out',
        nodes: {
          l: { nodeId: 'l', schema: leftSchema, state: 'confirmed', issues: [] },
          r: { nodeId: 'r', schema: rightSchema, state: 'confirmed', issues: [] },
          j: { nodeId: 'j', schema: leftSchema, state: 'confirmed', issues: [] },
          out: { nodeId: 'out', schema: leftSchema, state: 'confirmed', issues: [] },
        },
        hasErrors: false,
      },
    };
  }

  it('異常: 右の枝に無いキー列を指したら、その枝が出す列を添えて差し戻す', () => {
    const message = describeToolSemanticViolations(joinContext([{ left: '時点', right: '存在しない列' }]));

    expect(message).toMatch(/joins on right column "存在しない列", which the right branch does not produce/);
    expect(message).toMatch(/'労働時間'/);
  });

  it('異常: キーの型が食い違っていたら、揃え方を添えて差し戻す', () => {
    const message = describeToolSemanticViolations(joinContext([{ left: '時点', right: '時点' }]));

    expect(message).toMatch(/joins '時点' \('string'\) to '時点' \('number'\): the key types must match/);
    expect(message).toMatch(/Cast one side/);
  });

  it('例外: キーを1つも宣言しない結合は差し戻す', () => {
    expect(describeToolSemanticViolations(joinContext([]))).toMatch(/declares no keys/);
  });
});

// ─── ADR-0047 第4ラウンド: 機械的な書き間違いの正規化と差し戻し文面 ─────────────────────
describe('describeOffendingConfig / escalateRepairFeedback（差し戻しで「書いたもの」と「正しい形」を見せる）', () => {
  const graph = {
    nodes: [
      { id: 'f1', type: 'filter', config: { where: { columnName: '地域' } } },
      { id: 'j1', type: 'join', config: { mode: 'inner', keys: ['時点'] } },
    ],
    edges: [],
  } as unknown as ToolGraph;

  it('正常: エラー文面の nodeId から、その config JSON と最小の正しい例を添える', () => {
    const message = describeOffendingConfig('f1: filter: invalid config: column: expected string, received undefined', graph);

    expect(message).toContain("This is the config you wrote for node 'f1' (type 'filter')");
    expect(message).toContain('<untrusted-data label="factory-node-config">{"where":{"columnName":"地域"}}</untrusted-data>');
    expect(message).toContain('A minimal correct config for \'filter\' is:');
    expect(message).toContain('"op": "in", "values"');
  });

  it('正常: join の例には、同名列の省略記法も載せる（coordinator が domain へ足した書き方）', () => {
    const message = describeOffendingConfig('j1: join: invalid config: keys.0: expected object, received string', graph);

    expect(message).toContain('"keys": [{ "left": "<column>", "right": "<column>" }]');
    expect(message).toMatch(/Shorthand|shorthand/);
  });

  it('境界: 長い config は約400文字で切り詰める（プロンプトを膨らませない）', () => {
    const long = { nodes: [{ id: 'f1', type: 'filter', config: { note: 'あ'.repeat(600) } }], edges: [] } as unknown as ToolGraph;

    const message = describeOffendingConfig('f1: filter: invalid config: column: expected string', long);
    const shown = /<untrusted-data label="factory-node-config">([\s\S]*?)<\/untrusted-data>/.exec(message)?.[1] ?? '';
    expect(shown.length).toBeLessThanOrEqual(400);
    expect(shown.endsWith('…')).toBe(true);
  });

  it('例外: ノードを特定できない文面・グラフ未確定なら、元の文面をそのまま返す', () => {
    expect(describeOffendingConfig('graph validation failed: something', graph)).toBe('graph validation failed: something');
    expect(describeOffendingConfig('f1: filter: broken', undefined)).toBe('f1: filter: broken');
  });

  it('異常: 直前と同じ違反なら「同じ間違いを繰り返した」と明示して差し戻す', () => {
    const raw = 'j1: join: invalid config: keys.0: expected object';
    const escalated = escalateRepairFeedback('feedback text', raw, `${raw}\nprevious extra`);

    expect(escalated).toMatch(/^You repeated the SAME mistake as your previous attempt\./);
    expect(escalated).toContain('feedback text');
  });

  it('境界(回帰固定): 違反が変わっていれば、従来どおり文面をそのまま使う', () => {
    expect(escalateRepairFeedback('new feedback', 'new violation', 'old violation')).toBe('new feedback');
    expect(escalateRepairFeedback('first', 'first violation', undefined)).toBe('first');
  });
});

/** Skill を持たない単一ソースの計画（SkillWriter 呼び出しを台本から外すため）。 */
const singleSourcePlan: FactoryPlan = {
  agentBrief: { displayName: 'Wage Assistant', role: '賃金を説明する。' },
  tools: [{ key: 'lookup', displayName: 'Lookup', purpose: '地域別の賃金を返す。', dataSourceId: 'ds-1', sideEffect: 'read-only' }],
  skills: [], personas: [], scenarios: [],
};

describe('GenerateAgentAssetsUseCase（実測の3つの書き間違いを修復試行を使わずに吸収する）', () => {
  /** 実測（P3）と同じ崩れ方: keys を文字列で書き、join のエッジに toInput を片方しか書かない。 */
  function sloppyJoinProposalJson(): string {
    return JSON.stringify({
      graph: {
        nodes: [
          { id: 'wage', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'hours', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
          { id: 'j', type: 'join', config: { mode: 'inner', keys: ['時点', '地域コード'] } },
          { id: 'cap', type: 'limit', config: { count: 100 } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [
          { from: 'wage', to: 'j' },
          { from: 'hours', to: 'j', toInput: 1 },
          { from: 'j', to: 'cap' },
          { from: 'cap', to: 'out' },
        ],
      },
      agentTool: { name: 'wage_and_hours', description: '同じ時点・地域の賃金と労働時間を返す。' },
    });
  }

  it('正常: keys の省略記法と toInput の欠落を吸収し、1回目の提案でToolを保存する', async () => {
    const { model, toolRepo, profiles, useCase } = await setup({ csv: WAGE_CSV, sources: [{ id: 'ds-hours', csv: HOURS_CSV }] });
    model.enqueue(
      { message: { role: 'assistant', content: sloppyJoinProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: joinedPlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) })

    // 修復試行は1回も消費していない（ToolSmith呼び出しは1回）。
    if (events.some((event) => event.kind === 'tool_repair_attempted')) throw new Error(JSON.stringify(events.filter((e) => e.kind === 'tool_repair_attempted'), null, 1).slice(0, 1500));
    expect(events.filter((event) => event.kind === 'tool_repair_attempted')).toEqual([]);
    expect(result.toolRefs).toHaveLength(1);
    const tool = await toolRepo.findVersion(scope, result.toolRefs[0]!.internalId, SemVer.parse(result.toolRefs[0]!.version));
    const joinEdges = (tool?.graph.edges ?? []).filter((edge) => edge.to === 'j').map((edge) => edge.toInput);
    expect(joinEdges).toEqual([0, 1]);
    // 直した内容は生成イベントに残る（黙って直さない）。
    const generated = events.find((event) => event.kind === 'tool_generated');
    expect(generated?.message).toMatch(/normalized: join 'j': set "toInput": 0 on the edge from 'wage'/);
  });

  it('正常: 引数バインドの in 条件に設計時の values が無くても、実在値を種にして保存できる', async () => {
    const { model, toolRepo, profiles, useCase } = await setup({ csv: WAGE_CSV });
    const boundInProposal = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'f', type: 'filter', config: { column: '地域', op: 'in', valueBinding: { source: 'agent-input', field: 'regions' } } },
          { id: 'cap', type: 'limit', config: { count: 100 } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
          { id: 'args', type: 'agent-input', config: { schema: { columns: [{ name: 'regions', type: 'string', nullable: true }] }, sample: {} } },
        ],
        edges: [{ from: 'src', to: 'f' }, { from: 'f', to: 'cap' }, { from: 'cap', to: 'out' }],
      },
      agentTool: { name: 'wage_by_region', description: 'regions: カンマ区切り、省略で全地域。' },
    });
    model.enqueue(
      { message: { role: 'assistant', content: boundInProposal }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: singleSourcePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages).toEqual([]);
    const tool = await toolRepo.findVersion(scope, result.toolRefs[0]!.internalId, SemVer.parse(result.toolRefs[0]!.version));
    const filterConfig = tool?.graph.nodes.find((node) => node.id === 'f')?.config as { values?: unknown[] };
    // データに実在する地域名だけが種として入る（発明しない）。
    expect(filterConfig.values?.length).toBeGreaterThan(0);
    for (const value of filterConfig.values ?? []) expect(['北海道', '東京都']).toContain(value);
  });

  it('異常: 直せない崩れ方は、書いた config と正しい例を添えて修復ループへ回す', async () => {
    const { model, profiles, useCase } = await setup({ csv: WAGE_CSV });
    const brokenFilter = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'f', type: 'filter', config: { somethingElse: true } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'f' }, { from: 'f', to: 'out' }],
      },
      agentTool: { name: 'broken', description: 'x' },
    });
    model.enqueue(
      { message: { role: 'assistant', content: brokenFilter }, finishReason: 'stop' },
      { message: { role: 'assistant', content: brokenFilter }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    await useCase.execute({ scope, runId: 'run-1', goal, plan: singleSourcePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toContain("This is the config you wrote for node 'f' (type 'filter')");
    expect(messages[0]).toContain('{"somethingElse":true}');
    expect(messages[0]).toContain("A minimal correct config for 'filter' is:");
    // 2回目に同じ違反を返したら、繰り返していることを明示する。
    expect(messages[1]).toMatch(/^lookup attempt 2\/3: You repeated the SAME mistake/);
    // 差し戻し文面はそのまま次の提案へ priorError として渡る。
    expect(String(model.requests[1]?.messages.find((message) => message.role === 'user')?.content)).toContain('factory-node-config');
  });
});

// ─── ADR-0047 第5ラウンド: 3ソース結合の設計検査・まとめて差し戻し・5つの書き癖 ─────────────
/** 3つ目の e-Stat 風ファイル（同じキー列 + もう1つの値列）。 */
const PRICE_CSV = [
  '時点,地域コード,地域,消費者物価指数,注記',
  '2023年,01000,北海道,104,確報',
  '2023年,13000,東京都,106,確報',
  '2024年,01000,北海道,107,速報',
  '2024年,13000,東京都,109,速報',
].join('\n');

const threeSourcePlan: FactoryPlan = {
  agentBrief: { displayName: 'Wage Assistant', role: '賃金・労働時間・物価を説明する。' },
  tools: [{
    key: 'joined3', displayName: 'Wage, hours and prices', purpose: '同じ時点・同じ地域の賃金・労働時間・物価を並べる。',
    dataSourceId: 'ds-1', sideEffect: 'read-only', additionalDataSourceIds: ['ds-hours', 'ds-price'],
  }],
  skills: [], personas: [], scenarios: [],
};

/** 3ソースを2段の join で束ねる提案。実測の設計ミスを overrides で再現できる。 */
function threeSourceProposalJson(overrides?: {
  readonly parsePeriodOnBranches?: boolean;
  readonly keys?: readonly string[];
  readonly sameSuffix?: boolean;
}): string {
  const keys = overrides?.keys ?? ['時点', '地域コード'];
  const branchParse = overrides?.parsePeriodOnBranches === true;
  const suffixB = '_b';
  const suffixC = overrides?.sameSuffix === true ? '_b' : '_c';

  const nodes: unknown[] = [
    { id: 'a', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'b', type: 'csv-source', config: { dataSourceId: 'ds-hours' } },
    { id: 'c', type: 'csv-source', config: { dataSourceId: 'ds-price' } },
    { id: 'bs', type: 'select', config: { columns: ['時点', '地域コード', '総実労働時間【時間】'] } },
    { id: 'cs', type: 'select', config: { columns: ['時点', '地域コード', '消費者物価指数'] } },
    { id: 'j1', type: 'join', config: { mode: 'inner', keys, rightSuffix: suffixB } },
    { id: 'j2', type: 'join', config: { mode: 'inner', keys, rightSuffix: suffixC } },
    { id: 'pp', type: 'parse-period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 } },
    { id: 'ord', type: 'sort', config: { keys: [{ column: 'periodStart', direction: 'desc' }] } },
    { id: 'cap', type: 'limit', config: { count: 100 } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
  ];
  const edges: unknown[] = [
    { from: 'b', to: 'bs' }, { from: 'c', to: 'cs' },
    { from: 'a', to: 'j1', toInput: 0 }, { from: 'bs', to: 'j1', toInput: 1 },
    { from: 'j1', to: 'j2', toInput: 0 }, { from: 'cs', to: 'j2', toInput: 1 },
    { from: 'j2', to: 'pp' }, { from: 'pp', to: 'ord' }, { from: 'ord', to: 'cap' }, { from: 'cap', to: 'out' },
  ];

  if (branchParse) {
    // 実測の崩れ方: 枝ごとに parse-period を走らせる（2つ目の join で periodStart が衝突する）。
    nodes.push({ id: 'ppa', type: 'parse-period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 } });
    const index = edges.findIndex((edge) => (edge as { from: string }).from === 'a');
    edges.splice(index, 1, { from: 'a', to: 'ppa' }, { from: 'ppa', to: 'j1', toInput: 0 });
  }
  return JSON.stringify({ graph: { nodes, edges }, agentTool: { name: 'wage_hours_prices', description: '同じ時点・地域の3指標を返す。' } });
}

/** 3CSVの実データで意味検査まで回し、違反文面を返す。 */
async function threeSourceViolationOf(proposalJson: string): Promise<string | undefined> {
  const dataSources = new InMemoryDataSourceRepository();
  for (const [id, csv] of [['ds-1', WAGE_CSV], ['ds-hours', HOURS_CSV], ['ds-price', PRICE_CSV]] as const) {
    await dataSources.save({ id, tenant: scope, name: id, kind: 'file', format: 'csv', contentType: 'text/csv', sizeBytes: csv.length, createdAt: '', updatedAt: '' }, csv);
  }
  const engine = new EtlEngine(createDefaultRegistry());
  const resolver = new ResolveDataSourceGraphUseCase(dataSources);
  const profiles = await new ProfileDataSourcesUseCase(dataSources, resolver, engine).executeAll(scope, ['ds-1', 'ds-hours', 'ds-price']);
  const graph = makeArgumentsOptional(mergeAgentInputDeclarations(JSON.parse(proposalJson).graph as ToolGraph));
  // 結合の設計検査は本番と同じくスキーマ伝播より手前（エンジンの曖昧なエラーより先に直し方を返す）。
  const design = describeJoinDesignViolations(graph, profiles[0]!, [profiles[1]!, profiles[2]!]);
  if (design !== undefined) return design;
  const resolved = await resolver.execute(scope, graph);
  const propagation = engine.propagateSchemas(resolved);
  if (propagation.hasErrors) {
    return `graph validation failed: ${Object.values(propagation.nodes).flatMap((node) => node.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message)).join('; ')}`;
  }
  return describeToolSemanticViolations({
    graph, profile: profiles[0]!, additionalProfiles: [profiles[1]!, profiles[2]!], toolPlan: threeSourcePlan.tools[0]!,
    inputSchema: agentToolArgumentsOf(graph), propagation, preview: engine.preview(resolved),
  });
}

describe('describeToolSemanticViolations（3ソース結合の設計・実データ）', () => {
  it('正常(回帰固定): 枝はselectだけ・結合後に1回 parse-period・suffix が別なら違反なし', async () => {
    expect(await threeSourceViolationOf(threeSourceProposalJson())).toBeUndefined();
  });

  it('異常: 枝ごとに parse-period を走らせたら「最後の結合の後で1回だけ」と差し戻す', async () => {
    const message = await threeSourceViolationOf(threeSourceProposalJson({ parsePeriodOnBranches: true }));

    expect(message).toMatch(/runs 'parse-period' 2 times/);
    expect(message).toMatch(/Run it exactly ONCE, after the LAST join/);
    expect(message).toMatch(/still conflicts after suffix/);
  });

  it('異常: 注記のような自由記述列を結合キーにしたら、外すべきキーを名指しで差し戻す', async () => {
    const message = await threeSourceViolationOf(threeSourceProposalJson({ keys: ['時点', '地域コード', '注記'] }));

    expect(message).toMatch(/joins on '注記', which is free-text \(a note\/remark column\)/);
    expect(message).toMatch(/rows whose notes differ are silently dropped/);
    expect(message).toMatch(/Remove '注記' from "keys"/);
  });

  it('境界: コードと名前を両方キーにするのは許すが、コードだけで足りると添える', async () => {
    const message = await threeSourceViolationOf(threeSourceProposalJson({ keys: ['時点', '地域コード', '地域', '注記'] }));

    expect(message).toMatch(/The code column alone already identifies the row/);
    // 地域 は joinCandidates に載っているキーなので、それ自体は違反にしない。
    expect(message).not.toMatch(/Remove '地域',/);
  });

  it('例外: 単一の parse-period が結合の後にあれば、位置の検査は通る', async () => {
    const message = await threeSourceViolationOf(threeSourceProposalJson({ keys: ['時点', '地域コード'] }));

    expect(message).toBeUndefined();
  });
});

describe('GenerateAgentAssetsUseCase（違反はまとめて1回で差し戻す）', () => {
  it('正常: 意味の違反と既定呼び出しの溢れを、1回の差し戻しで両方伝える', async () => {
    const { model, profiles, useCase } = await setup({ csv: WAGE_CSV });
    // 期間ラベル列を落とし（証拠列違反）、かつ limit を置かない（引数なしで4行 > maxRows 1 で溢れる）。
    const broken = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
          { id: 'sel', type: 'select', config: { columns: ['地域', '現金給与総額【円】'] } },
          { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 1, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'sel' }, { from: 'sel', to: 'out' }],
      },
      agentTool: { name: 'broken', description: 'x' },
    });
    model.enqueue(
      { message: { role: 'assistant', content: broken }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const messages: string[] = [];

    await useCase.execute({ scope, runId: 'run-1', goal, plan: singleSourcePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } });

    expect(messages[0]).toMatch(/do not contain the period column '時点'/);
    expect(messages[0]).toMatch(/which overflows the terminal 'agent-output'/);
  });

  it('正常: 結合するToolには修復試行を1回多く与える（単一ソースは従来どおり）', async () => {
    const { model, profiles, useCase } = await setup({ csv: WAGE_CSV, sources: [{ id: 'ds-hours', csv: HOURS_CSV }] });
    const unusable = JSON.stringify({ graph: { nodes: [], edges: [] }, agentTool: { name: 'x', description: 'x' } });
    // maxRepairAttempts: 0 なら単一ソースは1回、結合Toolは2回 ToolSmith を呼ぶ。
    model.enqueue(...Array.from({ length: 4 }, () => ({ message: { role: 'assistant' as const, content: unusable }, finishReason: 'stop' as const })));
    const messages: string[] = [];

    await expect(useCase.execute({ scope, runId: 'run-1', goal, plan: joinedPlan, profiles, maxRepairAttempts: 0, onEvent: (event) => { if (event.kind === 'tool_repair_attempted') messages.push(event.message ?? ''); } }))
      .rejects.toThrow(/no tools could be generated/);

    expect(messages.map((message) => message.split(':')[0])).toEqual(['joined attempt 1/2', 'joined attempt 2/2']);
  });
});

describe('GenerateAgentAssetsUseCase（実測5つの書き癖を1つの提案で吸収する）', () => {
  it('正常: 種別の綴り・source id の欠落・agent-input の形と欠落・引数の型を、修復試行ゼロで直す', async () => {
    const { model, toolRepo, profiles, useCase } = await setup({ csv: WAGE_CSV });
    // 実測の5つを1つの提案に詰めた形:
    //  (1) valueBinding があるのに agent-input が無い → 合成
    //  (2) （合成なので sample の位置ずれは (1) に吸収される。別ノードで下記 (3) と同時に効く）
    //  (3) 種別が parse_period（下線）
    //  (4) csv-source の dataSourceId が null
    //  (5) period_from/period_to を string で宣言（合成時は列型から date になる）
    const sloppy = JSON.stringify({
      graph: {
        nodes: [
          { id: 'src', type: 'csv_source', config: { dataSourceId: null } },
          { id: 'pp', type: 'parse_period', config: { column: '時点', startColumn: 'periodStart', granularityColumn: 'periodGranularity', fiscalYearStartMonth: 4 } },
          { id: 'range', type: 'filter', config: { conditions: [
            { columnName: 'periodStart', operator: '>=', value: '2023-01-01', valueBinding: { source: 'agent-input', field: 'period_from' } },
            { columnName: 'periodStart', operator: '<=', value: '2024-12-31', valueBinding: { source: 'agent-input', field: 'period_to' } },
            { column: '地域', op: 'IN', value: '東京都', valueBinding: { source: 'agent-input', field: 'regions' } },
          ], combine: 'and' } },
          { id: 'ord', type: 'sort', config: { keys: [{ column: 'periodStart', direction: 'desc' }] } },
          { id: 'cap', type: 'limit', config: { count: 100 } },
          { id: 'out', type: 'agent_output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
        ],
        edges: [{ from: 'src', to: 'pp' }, { from: 'pp', to: 'range' }, { from: 'range', to: 'ord' }, { from: 'ord', to: 'cap' }, { from: 'cap', to: 'out' }],
      },
      agentTool: { name: 'wage_by_period', description: 'period_from/period_to: ISO日付。regions: カンマ区切り、省略で全地域。' },
    });
    model.enqueue(
      { message: { role: 'assistant', content: sloppy }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: singleSourcePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    // 修復試行ゼロ（ToolSmith 呼び出しは1回）。
    if (events.some((event) => event.kind === 'tool_repair_attempted')) throw new Error(JSON.stringify(events.filter((e) => e.kind === 'tool_repair_attempted'), null, 1).slice(0, 1500));
    expect(events.filter((event) => event.kind === 'tool_repair_attempted')).toEqual([]);
    expect(result.toolRefs).toHaveLength(1);

    const tool = await toolRepo.findVersion(scope, result.toolRefs[0]!.internalId, SemVer.parse(result.toolRefs[0]!.version));
    expect(tool?.graph.nodes.map((node) => node.type)).toContain('parse-period');
    expect(tool?.graph.nodes.map((node) => node.type)).toContain('agent-output');
    expect((tool?.graph.nodes.find((node) => node.id === 'src')?.config as { dataSourceId?: unknown }).dataSourceId).toBe('ds-1');
    // 引数は date / string で宣言され、すべて省略可能。
    expect(tool?.inputSchema?.columns).toEqual([
      { name: 'period_from', type: 'date', nullable: true },
      { name: 'period_to', type: 'date', nullable: true },
      { name: 'regions', type: 'string', nullable: true },
    ]);
    const note = events.find((event) => event.kind === 'tool_generated')?.message ?? '';
    expect(note).toContain('normalized:');
    expect(note).toContain("rewrote the node type 'parse_period'");
    expect(note).toContain('filled in the missing data source id "ds-1"');
    expect(note).toMatch(/added the missing 'agent-input' node/);
  });
});

describe('GenerateAgentAssetsUseCase（段階的ツール生成の組み込み・v42）', () => {
  it('正常: 段階的経路が成功したらToolSmithを呼ばずに保存し、走ったタスクをイベントへ残す', async () => {
    const { model, toolRepo, profiles, useCase, stagedTasks, stagedExpressions } = await setup({ staged: true });
    enqueueStagedTasks(stagedTasks, { computation: true });
    stagedExpressions.enqueue(scripted({ expression: '[amount] * 2', outputColumn: 'doubled', rationale: [], warnings: [] }));
    // 本体のモデルにはSkillWriterとAssemblerの応答だけを積む（ToolSmithを呼べば必ず食い違う）。
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    expect(model.requests.some((request) => request.responseFormat?.name === 'factory_tool_proposal')).toBe(false);
    expect(model.requests).toHaveLength(2);
    // ロール呼び出し: 段階的タスク3 + 式1 + SkillWriter1 + Assembler1。
    expect(result.roleCallsUsed).toBe(6);

    const generated = events.find((event) => event.kind === 'tool_generated');
    expect(generated?.message).toBe('lookup (staged: decide-filters, decide-computations, decide-output, write-expression×1)');

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.graph.nodes.some((node) => node.type === 'calculate')).toBe(true);
    // Tool契約はコンパイラが決定的に作った名前・説明をそのまま使う。
    expect(tool?.agentTool?.name).toBe('lookup');
    expect(result.toolKeyToToolName.get('lookup')).toBe('lookup');
  });

  it('正常: 計算列があるAgentには「計算済みの列をそのまま読む」規律が入る', async () => {
    const { model, agentRepo, profiles, useCase, stagedTasks, stagedExpressions } = await setup({ staged: true });
    enqueueStagedTasks(stagedTasks, { computation: true });
    stagedExpressions.enqueue(scripted({ expression: '[amount] * 2', outputColumn: 'doubled', rationale: [], warnings: [] }));
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).toContain('計算済みの列と違う数字を書かない');
  });

  it('境界: 計算列が無いときはその規律を書かない（守れない指示を増やさない）', async () => {
    const { model, agentRepo, profiles, useCase, stagedTasks } = await setup({ staged: true });
    enqueueStagedTasks(stagedTasks);
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    expect(agent?.systemPrompt).not.toContain('計算済みの列と違う数字を書かない');
  });

  it('異常: 段階的経路が失敗したら理由をイベントへ残して従来の一括ToolSmithへフォールバックする', async () => {
    const { model, toolRepo, profiles, useCase, stagedTasks } = await setup({ staged: true });
    // 2回とも読めない応答 → decide-filters が失敗 → 段階的経路は ok:false。
    stagedTasks.enqueue(
      { message: { role: 'assistant', content: 'not json' }, finishReason: 'stop' },
      { message: { role: 'assistant', content: 'still not json' }, finishReason: 'stop' },
    );
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    const fallback = events.find((event) => event.kind === 'tool_repair_attempted');
    expect(fallback?.message).toContain('staged generation failed:');
    expect(fallback?.message).toContain('falling back to one-shot ToolSmith');
    expect(model.requests.some((request) => request.responseFormat?.name === 'factory_tool_proposal')).toBe(true);
    // 段階的の2回 + ToolSmith1 + SkillWriter1 + Assembler1。
    expect(result.roleCallsUsed).toBe(5);

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.agentTool?.name).toBe('lookup_sales');
  });

  it('境界: toolGeneration:"one-shot" は段階的経路を試さない（従来どおり）', async () => {
    const { model, toolRepo, profiles, useCase, stagedTasks } = await setup({ staged: true });
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, toolGeneration: 'one-shot' });

    expect(stagedTasks.requests).toHaveLength(0);
    expect(result.roleCallsUsed).toBe(3);
    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.agentTool?.name).toBe('lookup_sales');
  });

  it('境界: 段階的経路を注入していない配線は従来どおり一括ToolSmithだけで生成する', async () => {
    const { model, profiles, useCase } = await setup();
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });
    expect(result.roleCallsUsed).toBe(3);
    expect(model.requests[0]?.responseFormat?.name).toBe('factory_tool_proposal');
  });
});

// ─── テンプレート経路の組み込み（v43 / ADR-0049） ─────────────────────────────────────

/** 月次 × 2 地域（同梱テンプレートの必須スロットが埋まる形）。 */
const TEMPLATE_CSV = [
  '時点,地域,売上',
  ...Array.from({ length: 14 }, (_unused, index) => {
    const year = index < 12 ? 2022 : 2023;
    const month = index < 12 ? index + 1 : index - 11;
    return [`${year}年${month}月,北海道,${100 + (10 * index)}`, `${year}年${month}月,東京都,${200 + (20 * index)}`];
  }).flat(),
].join('\n');

/** `period-series` のスロットを埋める応答（`ds-1` の月次データ向け）。 */
const PERIOD_SERIES_SLOTS = { periodColumn: '時点', valueColumns: ['売上'], categoryColumn: '地域', defaultGranularity: 'month', limit: 20 };
/** `period-change`（前年同月比を決定的に計算する構成）のスロット。 */
const PERIOD_CHANGE_SLOTS = { periodColumn: '時点', valueColumns: ['売上'], categoryColumn: '地域', lag: '12', limit: 30 };

describe('GenerateAgentAssetsUseCase（テンプレート経路の組み込み・v43）', () => {
  it('正常: テンプレート経路が成功したら段階的経路もToolSmithも呼ばず、どのテンプレートで作ったかをイベントへ残す', async () => {
    const { model, toolRepo, profiles, useCase, templateTasks, stagedTasks } = await setup({ csv: TEMPLATE_CSV, staged: true, templates: true });
    templateTasks.enqueue(
      scripted({ templateId: 'period-series', reason: '推移を返す目的だから' }),
      scripted(PERIOD_SERIES_SLOTS),
    );
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    // 段階的経路の台本も ToolSmith の台本も一切消費していない。
    expect(stagedTasks.requests).toHaveLength(0);
    expect(model.requests.some((request) => request.responseFormat?.name === 'factory_tool_proposal')).toBe(false);
    expect(model.requests).toHaveLength(2);
    // ロール呼び出し: テンプレートの選択1 + スロット1 + SkillWriter1 + Assembler1。
    expect(result.roleCallsUsed).toBe(4);

    const generated = events.find((event) => event.kind === 'tool_generated');
    // 版は同梱ファイルの現行値（テンプレートを直すたびに上がる）。ここでは形式だけを見る。
    expect(generated?.message).toMatch(/^lookup \(template: period-series@\d+\.\d+\.\d+; /u);
    expect(generated?.message?.replace(/@\d+\.\d+\.\d+/u, '')).toBe('lookup (template: period-series; slots: periodColumn=時点, valueColumns=[売上], categoryColumn=地域, defaultGranularity=month, limit=20)');

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.graph.nodes.some((node) => node.type === 'parse-period')).toBe(true);
    expect(tool?.agentTool?.name).toBe('lookup');
    expect(result.toolKeyToToolName.get('lookup')).toBe('lookup');
  });

  it('正常: 数を計算するテンプレート（前期比）で作ったAgentにも「計算済みの列をそのまま読む」規律が入る', async () => {
    const { model, agentRepo, profiles, useCase, templateTasks } = await setup({ csv: TEMPLATE_CSV, staged: true, templates: true });
    templateTasks.enqueue(
      scripted({ templateId: 'period-change', reason: '前年同月比が要るから' }),
      scripted(PERIOD_CHANGE_SLOTS),
    );
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2 });
    const agent = await agentRepo.findVersion(scope, result.agentRef.internalId, SemVer.parse(result.agentRef.version));
    // `calculate` が無くても、時系列分析の比較は「決定的に計算した列」なので同じ規律を書く。
    expect(agent?.systemPrompt).toContain('計算済みの列と違う数字を書かない');
  });

  it('異常: テンプレート経路が失敗したら理由をイベントへ残し、段階的経路 → 一括の順で落ちる', async () => {
    const { model, toolRepo, profiles, useCase, templateTasks, stagedTasks } = await setup({ csv: TEMPLATE_CSV, staged: true, templates: true });
    // テンプレートは選べたが、スロットを 2 回とも埋め損ねる。
    templateTasks.enqueue(
      scripted({ templateId: 'period-series', reason: '推移だから' }),
      scripted({ ...PERIOD_SERIES_SLOTS, valueColumns: ['存在しない列'] }),
      scripted({ ...PERIOD_SERIES_SLOTS, valueColumns: ['やはり存在しない列'] }),
    );
    enqueueStagedTasks(stagedTasks);
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    const fallback = events.find((event) => event.kind === 'tool_repair_attempted');
    expect(fallback?.message).toContain('template period-series failed:');
    expect(fallback?.message).toContain('falling back to staged generation');
    // 次の経路（段階的生成）が実際に走り、一括 ToolSmith までは落ちない。
    expect(stagedTasks.requests).toHaveLength(3);
    expect(model.requests.some((request) => request.responseFormat?.name === 'factory_tool_proposal')).toBe(false);

    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.agentTool?.name).toBe('lookup');
    const generated = events.find((event) => event.kind === 'tool_generated');
    expect(generated?.message).toContain('staged:');
  });

  it('境界: toolGeneration:"one-shot" はテンプレートも段階的経路も試さない（従来どおり）', async () => {
    const { model, toolRepo, profiles, useCase, templateTasks, stagedTasks } = await setup({ csv: TEMPLATE_CSV, staged: true, templates: true });
    model.enqueue(
      { message: { role: 'assistant', content: validToolProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );

    const result = await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, toolGeneration: 'one-shot' });

    expect(templateTasks.requests).toHaveLength(0);
    expect(stagedTasks.requests).toHaveLength(0);
    expect(result.roleCallsUsed).toBe(3);
    const toolRef = result.toolRefs[0];
    if (toolRef === undefined) throw new Error('expected a tool ref');
    const tool = await toolRepo.findVersion(scope, toolRef.internalId, SemVer.parse(toolRef.version));
    expect(tool?.agentTool?.name).toBe('lookup_sales');
  });

  it('境界: 当てはまるテンプレートが無いデータでは、モデルを呼ばずイベントも出さずに段階的経路へ進む', async () => {
    // 既定の `id,amount` には期間ラベル列が無く、どの同梱テンプレートも使えない。
    const { model, profiles, useCase, templateTasks, stagedTasks } = await setup({ staged: true, templates: true });
    enqueueStagedTasks(stagedTasks);
    model.enqueue(
      { message: { role: 'assistant', content: validSkillProposalJson() }, finishReason: 'stop' },
      { message: { role: 'assistant', content: validAssemblerProposalJson() }, finishReason: 'stop' },
    );
    const events: { kind: string; message?: string }[] = [];

    await useCase.execute({ scope, runId: 'run-1', goal, plan: onePlan, profiles, maxRepairAttempts: 2, onEvent: (event) => events.push({ kind: event.kind, ...(event.message === undefined ? {} : { message: event.message }) }) });

    expect(templateTasks.requests).toHaveLength(0);
    // 試していないものを「失敗した」と書かない（記録を無意味に増やさない）。
    if (events.some((event) => event.kind === 'tool_repair_attempted')) throw new Error(JSON.stringify(events.filter((e) => e.kind === 'tool_repair_attempted'), null, 1).slice(0, 1500));
    expect(events.filter((event) => event.kind === 'tool_repair_attempted')).toEqual([]);
    expect(events.find((event) => event.kind === 'tool_generated')?.message).toContain('staged:');
  });
});

describe('hasComputedColumns', () => {
  const toolWith = (nodes: unknown[]): never => ({ graph: { nodes, edges: [] } }) as never;

  it('正常: calculate ノードを持つToolがあれば true', () => {
    expect(hasComputedColumns([toolWith([{ id: 'calc_1', type: 'calculate', config: {} }])])).toBe(true);
  });

  it('境界: calculate が無ければ false', () => {
    expect(hasComputedColumns([toolWith([{ id: 'src', type: 'csv-source', config: {} }])])).toBe(false);
    expect(hasComputedColumns([])).toBe(false);
  });

  it('異常: グラフが壊れていても落ちない（保存済みToolのconfigは形が保証されない）', () => {
    expect(hasComputedColumns([{ graph: { nodes: null } } as never, {} as never])).toBe(false);
  });
});
