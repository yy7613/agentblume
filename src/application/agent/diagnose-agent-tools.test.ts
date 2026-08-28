/**
 * DiagnoseAgentToolsUseCase のテスト。
 *
 * InMemory リポジトリ + 実 EtlEngine で、実行時に失敗する構成が「実行せずに」
 * 対応する検査項目のエラーとして報告されることを検証する。
 */
import { describe, expect, it } from 'vitest';
import { InMemoryAgentRepository } from '../../adapters/storage/in-memory-agent-repository';
import { InMemorySkillRepository } from '../../adapters/storage/in-memory-skill-repository';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import { createAgent, type Agent } from '../../domain/agent/agent';
import type { Schema } from '../../domain/data/types';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { createSkill } from '../../domain/skill/skill';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type CreateToolProps, type Tool } from '../../domain/tool/tool';
import { EtlEngine } from '../etl/engine';
import type { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { DiagnoseAgentToolsUseCase, type AgentDiagnostics, type DiagnosticCheck } from './diagnose-agent-tools';

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
}): Promise<AgentDiagnostics> {
  const repo = new InMemoryToolRepository();
  for (const tool of input?.tools ?? [makeTool()]) await repo.save(tool);
  const usecase = new DiagnoseAgentToolsUseCase(
    repo, new EtlEngine(createDefaultRegistry()),
    input?.skills ?? new InMemorySkillRepository(), input?.agents ?? new InMemoryAgentRepository(),
    input?.resolveDataSources,
  );
  return usecase.execute(scope, input?.agent ?? makeAgent());
}

describe('DiagnoseAgentToolsUseCase', () => {
  it('健全な構成では全項目 ok で、公開 function 名を報告する', async () => {
    const diagnostics = await diagnose();
    expect(diagnostics.status).toBe('ok');
    expect(diagnostics.checks.every((item) => item.status === 'ok')).toBe(true);
    expect(diagnostics.tools).toHaveLength(1);
    expect(diagnostics.tools[0]).toMatchObject({ internalId: 'score-tool', version: '1.0.0', source: 'direct', functionName: 'score_lookup', status: 'ok' });
    for (const id of ['resolved', 'function-definition', 'agent-input', 'data-sources', 'graph', 'execution']) {
      expect(toolCheck(diagnostics, id)?.status).toBe('ok');
    }
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
  });
});
