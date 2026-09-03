/**
 * DiagnoseAgentToolsUseCase のテスト。
 *
 * InMemory リポジトリ + 実 EtlEngine で、実行時に失敗する構成が「実行せずに」
 * 対応する検査項目のエラーとして報告されることを検証する。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemoryMcpServerRepository } from '../../adapters/storage/in-memory-mcp-server-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { DEFAULT_AGENT_RUNTIME_HARNESS, createAgent, type Agent } from '../../domain/agent/agent';
import type { Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { createMcpServerConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { createSkill } from '../../domain/skill/skill';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type CreateToolProps, type Tool } from '../../domain/tool/tool';
import { EtlEngine } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import type { ModelCapability } from '../model/model-provider';
import { DiagnoseAgentToolsUseCase, buildDraftAgent, type AgentDiagnostics, type DiagnoseAgentToolsOptions, type DiagnosticCheck } from './diagnose-agent-tools';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const inputSchema: Schema = { columns: [{ name: 'minimumScore', type: 'number', nullable: false }] };

function makeTool(overrides?: Partial<CreateToolProps> & { readonly internalId?: string; readonly publishName?: string }): Tool {
  const internalId = overrides?.internalId ?? 'score-tool';
  return createTool({
    metadata: { internalId, workingName: 'w', displayName: 'Score', publishName: overrides?.publishName ?? 'score_lookup', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    sideEffect: 'read-only',
    graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
      { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, valueBinding: { source: 'agent-input', field: 'minimumScore' } } },
      { id: 'arguments', type: 'agent-input', config: { schema: inputSchema, sample: { minimumScore: 0 } } },
    ], edges: [{ from: 'data', to: 'filter' }] },
    inputSchema,
    ...overrides,
  });
}

function makeAgent(overrides?: Partial<Parameters<typeof createAgent>[0]>): Agent {
  return createAgent({
    metadata: { internalId: 'assistant', workingName: 'w', displayName: 'Assistant', publishName: 'assistant', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal',
    systemPrompt: 'Use tools.',
    skills: [],
    tools: [{ internalId: 'score-tool', version: SemVer.of(1, 0, 0) }],
    ...overrides,
  });
}

function check(diagnostics: AgentDiagnostics, id: string): DiagnosticCheck | undefined {
  return diagnostics.checks.find((candidate) => candidate.id === id);
}
function toolCheck(diagnostics: AgentDiagnostics, id: string, index = 0): DiagnosticCheck | undefined {
  return diagnostics.tools[index]?.checks.find((candidate) => candidate.id === id);
}

async function diagnose(input?: {
  readonly tools?: readonly Tool[];
  readonly agent?: Agent;
  readonly skills?: InMemorySkillRepository;
  readonly agents?: InMemoryAgentRepository;
  readonly resolveDataSources?: ResolveDataSourceGraphUseCase;
  readonly options?: DiagnoseAgentToolsOptions;
}): Promise<AgentDiagnostics> {
  const repo = new InMemoryToolRepository();
  for (const tool of input?.tools ?? [makeTool()]) await repo.save(tool);
  const usecase = new DiagnoseAgentToolsUseCase(
    repo, new EtlEngine(createDefaultRegistry()),
    input?.skills ?? new InMemorySkillRepository(), input?.agents ?? new InMemoryAgentRepository(),
    input?.resolveDataSources, input?.options ?? {},
  );
  return usecase.execute(scope, input?.agent ?? makeAgent());
}

const chatOnly = async (): Promise<readonly ['chat']> => ['chat'];

describe('DiagnoseAgentToolsUseCase', () => {
  it('健全な構成では全項目 ok で、公開 function 名を報告する', async () => {
    const diagnostics = await diagnose();
    expect(diagnostics.status).toBe('ok');
    expect(diagnostics.checks.every((item) => item.status === 'ok')).toBe(true);
    expect(diagnostics.tools).toHaveLength(1);
    expect(diagnostics.tools[0]).toMatchObject({ internalId: 'score-tool', version: '1.0.0', source: 'direct', functionName: 'score_lookup', status: 'ok' });
    for (const id of ['resolved', 'state', 'function-definition', 'agent-input', 'data-sources', 'graph', 'execution']) {
      expect(toolCheck(diagnostics, id)?.status).toBe('ok');
    }
    for (const id of ['skills', 'tool-versions', 'sub-agents', 'function-names', 'mcp-servers', 'harness']) {
      expect(check(diagnostics, id)?.status).toBe('ok');
    }
    // モデル配線が無ければ model 検査は項目自体を出さない（「未検査」を ok と誤読させない）。
    expect(check(diagnostics, 'model')).toBeUndefined();
  });

  it('Tool の公開状態を委譲先の state 検査として報告する（archived は error）', async () => {
    const archived = createTool({ ...makeTool(), metadata: { ...makeTool().metadata, state: 'archived' } });
    const diagnostics = await diagnose({ tools: [archived] });
    expect(toolCheck(diagnostics, 'state')).toMatchObject({ status: 'error', detail: 'tool is archived, so it should not be attached to an agent' });
    expect(diagnostics.status).toBe('error');
  });

  it('MCP サーバー参照の未登録は error、disabled は warning として報告する（実行時は黙ってスキップされる）', async () => {
    const mcpServers = new InMemoryMcpServerRepository();
    const transport = { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} } as const;
    await mcpServers.save(createMcpServerConfig({ scope, name: 'files', transport, updatedAt: '2026-07-26T00:00:00.000Z' }));
    await mcpServers.save(createMcpServerConfig({ scope, name: 'paused', transport, disabled: true, updatedAt: '2026-07-26T00:00:00.000Z' }));

    const healthy = await diagnose({ agent: makeAgent({ mcpServers: ['files'] }), options: { mcpServers } });
    expect(check(healthy, 'mcp-servers')).toEqual({ id: 'mcp-servers', status: 'ok' });

    const paused = await diagnose({ agent: makeAgent({ mcpServers: ['paused'] }), options: { mcpServers } });
    expect(check(paused, 'mcp-servers')).toEqual({ id: 'mcp-servers', status: 'warning', detail: "MCP server 'paused' is disabled, so its tools are skipped at run time" });

    const missing = await diagnose({ agent: makeAgent({ mcpServers: ['ghost', 'paused'] }), options: { mcpServers } });
    expect(check(missing, 'mcp-servers')).toEqual({ id: 'mcp-servers', status: 'error', detail: "referenced MCP server not found: ghost; MCP server 'paused' is disabled, so its tools are skipped at run time" });
    expect(missing.status).toBe('error');

    // リポジトリ未配線なら検査しない。
    const unwired = await diagnose({ agent: makeAgent({ mcpServers: ['ghost'] }) });
    expect(check(unwired, 'mcp-servers')?.status).toBe('ok');
  });

  it('設定中モデルの能力を実行時ガードと同じメッセージで報告する', async () => {
    const noToolCalling = await diagnose({ options: { modelCapabilities: chatOnly } });
    expect(check(noToolCalling, 'model')).toEqual({ id: 'model', status: 'error', detail: 'configured model provider does not support tool-calling' });

    // functionInvocation:false はモデルへツールを渡さないので tool-calling を要求しない。
    const noInvocation = await diagnose({ agent: makeAgent({ harness: { ...DEFAULT_AGENT_RUNTIME_HARNESS, functionInvocation: false } }), options: { modelCapabilities: chatOnly } });
    expect(check(noInvocation, 'model')).toEqual({ id: 'model', status: 'ok' });

    // Tool が無くてもサブエージェント・MCP があれば呼び出し可能物がある。
    const mcpOnly = await diagnose({ agent: makeAgent({ tools: [], mcpServers: ['files'] }), options: { modelCapabilities: chatOnly } });
    expect(check(mcpOnly, 'model')?.status).toBe('error');
    const nothingToCall = await diagnose({ agent: makeAgent({ tools: [] }), options: { modelCapabilities: chatOnly } });
    expect(check(nothingToCall, 'model')?.status).toBe('ok');

    // 構造化出力の指定は structured-output を要求する。両方欠けると '; ' で連結。
    const structured = await diagnose({
      agent: makeAgent({ output: { name: 'answer', fields: [{ name: 'text', type: 'string', required: true }] } }),
      options: { modelCapabilities: chatOnly },
    });
    expect(check(structured, 'model')).toEqual({ id: 'model', status: 'error', detail: 'configured model provider does not support tool-calling; configured model provider does not support structured output' });

    const capable = await diagnose({ options: { modelCapabilities: async () => ['chat', 'tool-calling', 'structured-output'] } });
    expect(check(capable, 'model')).toEqual({ id: 'model', status: 'ok' });

    // 設定の解決自体が失敗したら、その理由を error として返す（診断全体は落とさない）。
    const failing = await diagnose({ options: { modelCapabilities: async () => { throw new Error('settings row is corrupt'); } } });
    expect(check(failing, 'model')).toEqual({ id: 'model', status: 'error', detail: 'model settings could not be resolved: settings row is corrupt' });
  });

  it('ハーネス機能の前提が揃わないときは warning（実行時はツールが黙って提示されない）', async () => {
    const harness = { ...DEFAULT_AGENT_RUNTIME_HARNESS, webSearch: true, fileMemory: true };
    const both = await diagnose({ agent: makeAgent({ harness }), options: { webSearchConfigured: () => false } });
    expect(check(both, 'harness')).toEqual({
      id: 'harness', status: 'warning',
      detail: 'harness enables web search but no search provider is configured, so the web_search tool is not offered; harness enables file memory but the agent references no wiki, so memory tools have nothing to read',
    });
    expect(both.status).toBe('warning');

    const satisfied = await diagnose({ agent: makeAgent({ harness, wikis: [{ wikiId: 'notes' }] }), options: { webSearchConfigured: () => true } });
    expect(check(satisfied, 'harness')).toEqual({ id: 'harness', status: 'ok' });

    // 検索の配線が注入されていなければ web search については判定しない。
    const unknownSearch = await diagnose({ agent: makeAgent({ harness: { ...DEFAULT_AGENT_RUNTIME_HARNESS, webSearch: true } }) });
    expect(check(unknownSearch, 'harness')?.status).toBe('ok');
  });

  it('委譲ツール名 ask_{publishName} が function 名の形式でなければ sub-agents をエラーにする', async () => {
    const agents = new InMemoryAgentRepository();
    await agents.save(makeAgent({ metadata: { internalId: 'helper', workingName: 'w', displayName: 'Helper', publishName: 'bad name', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, tools: [] }));
    const diagnostics = await diagnose({ agents, agent: makeAgent({ agents: [{ internalId: 'helper', version: SemVer.of(1, 0, 0), usage: 'delegate' }] }) });
    expect(check(diagnostics, 'sub-agents')).toEqual({ id: 'sub-agents', status: 'error', detail: 'sub-agent tool name is not a valid function name: ask_bad name' });
  });

  it('参照先の Tool version が無ければ resolved がエラーになる', async () => {
    const diagnostics = await diagnose({ agent: makeAgent({ tools: [{ internalId: 'score-tool', version: SemVer.of(9, 9, 9) }] }) });
    expect(diagnostics.status).toBe('error');
    expect(toolCheck(diagnostics, 'resolved')).toMatchObject({ status: 'error', detail: 'referenced tool not found: score-tool@9.9.9' });
    // 未解決の Tool は以降の検査を持たない。
    expect(diagnostics.tools[0]?.checks).toHaveLength(1);
  });

  it('inputSchema と agent-input ノードの不一致を実行前に報告する', async () => {
    const drifted = makeTool({ inputSchema: { columns: [{ name: 'other', type: 'string', nullable: false }] } });
    const diagnostics = await diagnose({ tools: [drifted] });
    expect(toolCheck(diagnostics, 'agent-input')).toMatchObject({ status: 'error', detail: "tool inputSchema does not match agent-input node 'arguments'" });
    expect(diagnostics.status).toBe('error');
  });

  it('宣言 outputSchema と推論終端の不整合（実行時に爆発する保存物）を報告する', async () => {
    const legacy = makeTool({ outputSchema: { columns: [{ name: 'only', type: 'string', nullable: false }] } });
    const diagnostics = await diagnose({ tools: [legacy] });
    expect(toolCheck(diagnostics, 'output-schema')?.status).toBe('error');
    expect(toolCheck(diagnostics, 'output-schema')?.detail).toContain('column count mismatch: expected 1, received 2');
  });

  it('データソース解決の失敗を報告し、依存する後段の検査は行わない', async () => {
    const failing = { execute: async () => { throw new Error('data source is unavailable or not a file: ds-1'); } } as unknown as ResolveDataSourceGraphUseCase;
    const diagnostics = await diagnose({ resolveDataSources: failing });
    expect(toolCheck(diagnostics, 'data-sources')).toMatchObject({ status: 'error', detail: 'data source is unavailable or not a file: ds-1' });
    expect(toolCheck(diagnostics, 'graph')).toBeUndefined();
    expect(toolCheck(diagnostics, 'execution')).toBeUndefined();
  });

  it('function 名の重複を「後の Tool へ届かない」問題として報告する', async () => {
    const first = makeTool();
    const second = makeTool({ internalId: 'other-tool', publishName: 'other_lookup', agentTool: { name: 'score_lookup', description: 'duplicate name' } });
    const agent = makeAgent({ tools: [
      { internalId: 'score-tool', version: SemVer.of(1, 0, 0) },
      { internalId: 'other-tool', version: SemVer.of(1, 0, 0) },
    ] });
    const diagnostics = await diagnose({ tools: [first, second], agent });
    expect(check(diagnostics, 'function-names')).toMatchObject({ status: 'error' });
    expect(check(diagnostics, 'function-names')?.detail).toContain('score_lookup');
  });

  it('Skill 参照切れと Skill 経由 Tool の出所を報告する', async () => {
    const skills = new InMemorySkillRepository();
    await skills.save(createSkill({
      metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'use it',
      tools: [{ internalId: 'score-tool', version: SemVer.of(1, 0, 0) }],
    }));
    const viaSkill = await diagnose({ skills, agent: makeAgent({ tools: [], skills: [{ internalId: 'analysis', version: SemVer.of(1, 0, 0) }] }) });
    expect(check(viaSkill, 'skills')?.status).toBe('ok');
    expect(viaSkill.tools[0]).toMatchObject({ source: 'skill', skillId: 'analysis' });

    const missing = await diagnose({ agent: makeAgent({ tools: [], skills: [{ internalId: 'missing', version: SemVer.of(1, 0, 0) }] }) });
    expect(check(missing, 'skills')).toMatchObject({ status: 'error', detail: 'referenced skill not found: missing@1.0.0' });

    // 直付けと同一版をスキルも束ねる場合は先勝ち＝direct のまま（「スキル経由」と誤表示しない）。
    const both = await diagnose({ skills, agent: makeAgent({ skills: [{ internalId: 'analysis', version: SemVer.of(1, 0, 0) }] }) });
    expect(both.tools).toHaveLength(1);
    expect(both.tools[0]).toMatchObject({ source: 'direct' });
    expect(both.tools[0]?.skillId).toBeUndefined();
  });

  it('同一 Tool の版曖昧性（直付けと Skill 由来の食い違い）を報告する', async () => {
    const skills = new InMemorySkillRepository();
    await skills.save(createSkill({
      metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
      responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'use it',
      tools: [{ internalId: 'score-tool', version: SemVer.of(2, 0, 0) }],
    }));
    const diagnostics = await diagnose({ skills, agent: makeAgent({ skills: [{ internalId: 'analysis', version: SemVer.of(1, 0, 0) }] }) });
    expect(check(diagnostics, 'tool-versions')).toMatchObject({ status: 'error', detail: 'ambiguous tool versions: score-tool@1.0.0 and score-tool@2.0.0' });
  });

  it('サブエージェント参照切れと委譲ツール名の衝突を報告する', async () => {
    const agents = new InMemoryAgentRepository();
    await agents.save(makeAgent({ metadata: { internalId: 'helper', workingName: 'w', displayName: 'Helper', publishName: 'helper', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, tools: [] }));
    const withSub = await diagnose({ agents, agent: makeAgent({ agents: [{ internalId: 'helper', version: SemVer.of(1, 0, 0), usage: 'delegate' }] }) });
    expect(check(withSub, 'sub-agents')?.status).toBe('ok');

    const missing = await diagnose({ agents, agent: makeAgent({ agents: [{ internalId: 'ghost', version: SemVer.of(1, 0, 0), usage: 'delegate' }] }) });
    expect(check(missing, 'sub-agents')).toMatchObject({ status: 'error', detail: 'referenced sub-agent not found: ghost@1.0.0' });
  });

  it('非 read-only の副作用は warning（承認待ちで止まる説明つき）として報告する', async () => {
    const writer = makeTool({ sideEffect: 'write' });
    const diagnostics = await diagnose({ tools: [writer] });
    expect(toolCheck(diagnostics, 'side-effect')).toMatchObject({ status: 'warning' });
    expect(diagnostics.status).toBe('warning');
  });

  it('opBinding の引数が inputSchema に宣言されていなければ warning（実行時は不活性）', async () => {
    const tool = makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice', score: 42 }] } },
      { id: 'filter', type: 'filter', config: { column: 'score', op: 'gte', value: 0, opBinding: { source: 'agent-input', field: 'undeclaredOp', allowed: ['gte', 'lte'] } } },
    ], edges: [{ from: 'data', to: 'filter' }] }, inputSchema: undefined });
    const diagnostics = await diagnose({ tools: [tool] });
    expect(toolCheck(diagnostics, 'operator-arguments')).toMatchObject({ status: 'warning' });
    expect(toolCheck(diagnostics, 'operator-arguments')?.detail).toContain('undeclaredOp');
  });

  it('グラフのスキーマエラー（存在しない列参照）を graph 検査として報告する', async () => {
    const broken = makeTool({ graph: { nodes: [
      { id: 'data', type: 'json-source', config: { rows: [{ name: 'Alice' }] } },
      { id: 'sel', type: 'select', config: { columns: ['missing'] } },
    ], edges: [{ from: 'data', to: 'sel' }] }, inputSchema: undefined });
    const diagnostics = await diagnose({ tools: [broken] });
    expect(toolCheck(diagnostics, 'graph')?.status).toBe('error');
    expect(toolCheck(diagnostics, 'graph')?.detail).toContain('missing');
    expect(toolCheck(diagnostics, 'graph')?.nodeId).toBe('sel');
  });
});

describe('buildDraftAgent', () => {
  const draft = {
    scope, internalId: 'assistant', workingName: 'w', displayName: 'Assistant', publishName: 'assistant', owner: 'owner',
    kind: 'normal' as const, systemPrompt: 'Use tools.', tools: [{ internalId: 'score-tool', version: SemVer.of(1, 0, 0) }],
  };

  it('SaveAgent と同じ形で Agent を組み立て、版は未保存の印 0.0.0・state 既定 draft', () => {
    const agent = buildDraftAgent({ ...draft, mcpServers: ['files'], harness: DEFAULT_AGENT_RUNTIME_HARNESS });
    expect(agent.metadata.version.toString()).toBe('0.0.0');
    expect(agent.metadata.state).toBe('draft');
    expect(agent.skills).toEqual([]);
    expect(agent.agents).toEqual([]);
    expect(agent.mcpServers).toEqual(['files']);
    expect(agent.harness).toEqual(DEFAULT_AGENT_RUNTIME_HARNESS);
    expect(buildDraftAgent({ ...draft, state: 'published' }, SemVer.of(1, 2, 3)).metadata).toMatchObject({ state: 'published', version: SemVer.of(1, 2, 3) });
  });

  it('保存と同じ createAgent 検証を通す（pseudo-user に Tool は付けられない）', () => {
    expect(() => buildDraftAgent({ ...draft, kind: 'pseudo-user' })).toThrow(/pseudo-user/);
  });
});

describe('DiagnoseAgentToolsUseCase 境界・異常系', () => {
  const output = { name: 'answer', fields: [{ name: 'text', type: 'string' as const, required: true }] };
  const analysisSkill = createSkill({
    metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'use it',
    tools: [{ internalId: 'score-tool', version: SemVer.of(1, 0, 0) }],
  });
  function subAgent(internalId: string, publishName: string): Agent {
    return makeAgent({ metadata: { internalId, workingName: 'w', displayName: internalId, publishName, version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope }, tools: [] });
  }
  const subRef = (internalId: string) => ({ internalId, version: SemVer.of(1, 0, 0), usage: 'delegate' });
  async function subAgents(...agents: readonly Agent[]): Promise<InMemoryAgentRepository> {
    const repo = new InMemoryAgentRepository();
    for (const agent of agents) await repo.save(agent);
    return repo;
  }

  it('Tool・Skill・サブエージェント・MCP を持たない Agent は全項目 ok で tools は空、model は配線が無ければ出ない', async () => {
    const diagnostics = await diagnose({ tools: [], agent: makeAgent({ tools: [] }) });
    expect(diagnostics.status).toBe('ok');
    expect(diagnostics.tools).toEqual([]);
    expect(diagnostics.checks.map((item) => item.id)).toEqual(['skills', 'tool-versions', 'sub-agents', 'function-names', 'mcp-servers', 'harness']);
    expect(diagnostics.checks.every((item) => item.status === 'ok')).toBe(true);
  });

  it('model: 構造化出力だけなら structured-output があれば ok、tool-calling があっても structured-output が無ければその1件だけ error', async () => {
    const structuredOnly = await diagnose({ tools: [], agent: makeAgent({ tools: [], output }), options: { modelCapabilities: async () => ['chat', 'structured-output'] } });
    expect(check(structuredOnly, 'model')).toEqual({ id: 'model', status: 'ok' });
    const noStructured = await diagnose({ agent: makeAgent({ output }), options: { modelCapabilities: async () => ['chat', 'tool-calling'] } });
    expect(check(noStructured, 'model')).toEqual({ id: 'model', status: 'error', detail: 'configured model provider does not support structured output' });
  });

  it('model: Skill 経由の Tool だけでも呼び出し可能物として tool-calling を要求する', async () => {
    const skills = new InMemorySkillRepository();
    await skills.save(analysisSkill);
    const diagnostics = await diagnose({ skills, agent: makeAgent({ tools: [], skills: [{ internalId: 'analysis', version: SemVer.of(1, 0, 0) }] }), options: { modelCapabilities: chatOnly } });
    expect(check(diagnostics, 'model')).toEqual({ id: 'model', status: 'error', detail: 'configured model provider does not support tool-calling' });
  });

  it('model: 設定の解決が Error 以外で reject しても・同期的に投げても、model の error として文字列化する', async () => {
    const rejected = await diagnose({ options: { modelCapabilities: async () => { throw 'settings unavailable'; } } });
    expect(check(rejected, 'model')).toEqual({ id: 'model', status: 'error', detail: 'model settings could not be resolved: settings unavailable' });
    const throwing = (() => { throw new Error('sync failure'); }) as unknown as () => Promise<readonly ModelCapability[]>;
    const thrown = await diagnose({ options: { modelCapabilities: throwing } });
    expect(check(thrown, 'model')).toEqual({ id: 'model', status: 'error', detail: 'model settings could not be resolved: sync failure' });
  });

  it('harness: 検索プロバイダ設定の解決が投げても診断全体は落ちず、harness の error として他の warning と束ねる', async () => {
    const harness = { ...DEFAULT_AGENT_RUNTIME_HARNESS, webSearch: true, fileMemory: true };
    const diagnostics = await diagnose({ agent: makeAgent({ harness }), options: { webSearchConfigured: () => { throw new Error('catalog unavailable'); } } });
    expect(check(diagnostics, 'harness')).toEqual({
      id: 'harness', status: 'error',
      detail: 'search provider configuration could not be resolved: catalog unavailable; harness enables file memory but the agent references no wiki, so memory tools have nothing to read',
    });
    expect(diagnostics.status).toBe('error');
    // webSearch を有効にしていなければ検索設定は参照すらしない。
    let consulted = false;
    const untouched = await diagnose({ agent: makeAgent({ harness: DEFAULT_AGENT_RUNTIME_HARNESS }), options: { webSearchConfigured: () => { consulted = true; return false; } } });
    expect(check(untouched, 'harness')).toEqual({ id: 'harness', status: 'ok' });
    expect(consulted).toBe(false);
  });

  it('mcp-servers: リポジトリの障害は 500 ではなく mcp-servers の error として報告する', async () => {
    const failing = { find: async () => { throw new Error('sqlite is locked'); } } as unknown as McpServerRepository;
    const diagnostics = await diagnose({ agent: makeAgent({ mcpServers: ['files'] }), options: { mcpServers: failing } });
    expect(check(diagnostics, 'mcp-servers')).toEqual({ id: 'mcp-servers', status: 'error', detail: "MCP server 'files' could not be resolved: sqlite is locked" });
    expect(diagnostics.status).toBe('error');
    const rejectingWithString = { find: async () => { throw 'boom'; } } as unknown as McpServerRepository;
    expect(check(await diagnose({ agent: makeAgent({ mcpServers: ['files'] }), options: { mcpServers: rejectingWithString } }), 'mcp-servers'))
      .toEqual({ id: 'mcp-servers', status: 'error', detail: "MCP server 'files' could not be resolved: boom" });
  });

  it('mcp-servers: 同名の重複参照は1件だけ報告し、error（未登録）は warning（disabled）より先に並べる', async () => {
    const mcpServers = new InMemoryMcpServerRepository();
    const transport = { kind: 'stdio', command: 'npx', args: ['-y', 'server'], env: {} } as const;
    await mcpServers.save(createMcpServerConfig({ scope, name: 'paused', transport, disabled: true, updatedAt: '2026-07-26T00:00:00.000Z' }));
    // createAgent は重複を拒否するので、集約を迂回した Agent で防御を確かめる。
    const duplicated: Agent = { ...makeAgent({ tools: [] }), mcpServers: ['ghost', 'ghost'] };
    expect(check(await diagnose({ tools: [], agent: duplicated, options: { mcpServers } }), 'mcp-servers'))
      .toEqual({ id: 'mcp-servers', status: 'error', detail: 'referenced MCP server not found: ghost' });
    const reversed = await diagnose({ agent: makeAgent({ mcpServers: ['paused', 'ghost'] }), options: { mcpServers } });
    expect(check(reversed, 'mcp-servers')?.detail).toBe("referenced MCP server not found: ghost; MCP server 'paused' is disabled, so its tools are skipped at run time");
  });

  it('sub-agents: 委譲ツール名 ask_{publishName} は 64 文字まで有効で、65 文字・日本語は無効', async () => {
    const agents = await subAgents(subAgent('sixty', 'a'.repeat(60)), subAgent('sixty-one', 'a'.repeat(61)), subAgent('ja', 'ヘルパー'));
    expect(check(await diagnose({ agents, agent: makeAgent({ agents: [subRef('sixty')] }) }), 'sub-agents')).toEqual({ id: 'sub-agents', status: 'ok' });
    expect(check(await diagnose({ agents, agent: makeAgent({ agents: [subRef('sixty-one')] }) }), 'sub-agents'))
      .toEqual({ id: 'sub-agents', status: 'error', detail: `sub-agent tool name is not a valid function name: ask_${'a'.repeat(61)}` });
    expect(check(await diagnose({ agents, agent: makeAgent({ agents: [subRef('ja')] }) }), 'sub-agents'))
      .toEqual({ id: 'sub-agents', status: 'error', detail: 'sub-agent tool name is not a valid function name: ask_ヘルパー' });
  });

  it('sub-agents: 参照切れと別サブエージェントの不正名は両方を Agent の参照順に報告する', async () => {
    const agents = await subAgents(subAgent('helper', 'bad name'));
    const diagnostics = await diagnose({ agents, agent: makeAgent({ agents: [subRef('ghost'), subRef('helper')] }) });
    expect(check(diagnostics, 'sub-agents')).toEqual({ id: 'sub-agents', status: 'error', detail: 'referenced sub-agent not found: ghost@1.0.0; sub-agent tool name is not a valid function name: ask_bad name' });
  });

  it('sub-agents: 委譲ツール名は Tool の publishName と衝突し、同じ不正名のサブ同士では2つ目が衝突として報告される', async () => {
    const agents = await subAgents(subAgent('helper', 'helper'), subAgent('first', 'bad name'), subAgent('second', 'bad name'));
    const shadowing = makeTool({ publishName: 'ask_helper' });
    const collision = await diagnose({ tools: [shadowing], agents, agent: makeAgent({ agents: [subRef('helper')] }) });
    expect(check(collision, 'sub-agents')).toEqual({ id: 'sub-agents', status: 'error', detail: 'sub-agent tool name collides with an existing tool or sub-agent: ask_helper' });
    // 衝突したサブは委譲ツールとして提示されないので function-names の重複には数えない。
    expect(check(collision, 'function-names')).toEqual({ id: 'function-names', status: 'ok' });
    const sameInvalid = await diagnose({ agents, agent: makeAgent({ agents: [subRef('first'), subRef('second')] }) });
    expect(check(sameInvalid, 'sub-agents')?.detail)
      .toBe('sub-agent tool name is not a valid function name: ask_bad name; sub-agent tool name collides with an existing tool or sub-agent: ask_bad name');
  });

  it('Tool の deprecated は Tool と Agent 全体の status を warning に下げる', async () => {
    const deprecated = createTool({ ...makeTool(), metadata: { ...makeTool().metadata, state: 'deprecated' } });
    const diagnostics = await diagnose({ tools: [deprecated] });
    expect(toolCheck(diagnostics, 'state')).toEqual({ id: 'state', status: 'warning', detail: 'tool is deprecated and may be archived later' });
    expect(diagnostics.tools[0]?.status).toBe('warning');
    expect(diagnostics.status).toBe('warning');
  });

  it('Skill / Agent リポジトリが配線されていなければ参照を解決できない旨を error にし、Tool 単位の診断は続ける', async () => {
    const repo = new InMemoryToolRepository();
    await repo.save(makeTool());
    const unwired = new DiagnoseAgentToolsUseCase(repo, new EtlEngine(createDefaultRegistry()));
    const diagnostics = await unwired.execute(scope, makeAgent({ skills: [{ internalId: 'analysis', version: SemVer.of(1, 0, 0) }], agents: [subRef('helper')] }));
    expect(check(diagnostics, 'skills')).toEqual({ id: 'skills', status: 'error', detail: 'Skill repository is not configured' });
    expect(check(diagnostics, 'sub-agents')).toEqual({ id: 'sub-agents', status: 'error', detail: 'Agent repository is not configured' });
    expect(diagnostics.tools[0]?.status).toBe('ok');
  });
});
