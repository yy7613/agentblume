import { describe, expect, it, vi } from 'vitest';
import type { Agent, AgentSubAgentRef, AgentToolRef } from '../../domain/agent/agent';
import { createAgent } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { createSkill } from '../../domain/skill/skill';
import type { SideEffect } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { HARD_MAX_DEPTH, composeAgentSystemPrompt, resolveAgentCapabilities, resolveEffectiveSideEffect } from './resolve-agent-capabilities';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.of(1, 0, 0);
function makeTool(id: string, sideEffect: SideEffect) {
  return createTool({ metadata: { internalId: id, workingName: id, displayName: id, publishName: id, version, owner: 'owner', state: 'draft', tenant: scope }, sideEffect, graph: { nodes: [], edges: [] } });
}
const tool = makeTool('scores', 'read-only');
const writer = makeTool('writer', 'write');
const caller = makeTool('caller', 'external-action');
const toolsByKey = new Map([tool, writer, caller].map((t) => [t.metadata.internalId, t]));
const skill = createSkill({ metadata: { internalId: 'analysis', workingName: 'Analysis', displayName: 'Analysis', publishName: 'analysis', version, owner: 'owner', state: 'draft', tenant: scope }, responsibility: 'Analyze.', activationCondition: 'For data.', inputDescription: 'Data.', outputDescription: 'Answer.', instructions: 'Always ground answers.', tools: [{ internalId: 'scores', version }] });
const tools = { findVersion: vi.fn(async (_scope, id, requested) => requested.equals(version) ? toolsByKey.get(id) ?? null : null) } as unknown as ToolRepository;
const skills = { findVersion: vi.fn(async (_scope, id, requested) => id === 'analysis' && requested.equals(version) ? skill : null) } as unknown as SkillRepository;

function makeAgent(internalId: string, opts: { publishName?: string; tools?: readonly AgentToolRef[]; agents?: readonly AgentSubAgentRef[] } = {}): Agent {
  return createAgent({
    metadata: { internalId, workingName: internalId, displayName: internalId, publishName: opts.publishName ?? internalId, version, owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'x', tools: opts.tools ?? [], agents: opts.agents ?? [],
  });
}
function sub(internalId: string): AgentSubAgentRef { return { internalId, version, usage: `delegate ${internalId}` }; }
function agentRepoOf(...agents: Agent[]): AgentRepository {
  const byKey = new Map(agents.map((a) => [`${a.metadata.internalId}@${a.metadata.version.toString()}`, a]));
  return { findVersion: vi.fn(async (_s: unknown, id: string, v: SemVer) => byKey.get(`${id}@${v.toString()}`) ?? null) } as unknown as AgentRepository;
}

describe('resolveAgentCapabilities', () => {
  it('Skill由来と直接参照の同一Toolを重複排除しinstructionsを合成する', async () => {
    const resolved = await resolveAgentCapabilities(scope, [{ internalId: 'analysis', version }], [{ internalId: 'scores', version }], tools, skills);
    expect(resolved.tools).toEqual([tool]);
    expect(composeAgentSystemPrompt('Base.', resolved.skills)).toContain('analysis@1.0.0\nAlways ground answers.');
  });

  it('同じToolの異なるversionを曖昧として拒否する', async () => {
    await expect(resolveAgentCapabilities(scope, [{ internalId: 'analysis', version }], [{ internalId: 'scores', version: SemVer.of(2, 0, 0) }], tools, skills)).rejects.toThrow(/ambiguous tool versions/);
  });

  it('サブエージェントをask_名で解決し、公開名衝突を拒否する', async () => {
    const scorer = makeAgent('scorer', { publishName: 'scorer' });
    const dupA = makeAgent('dup-a', { publishName: 'dup' });
    const dupB = makeAgent('dup-b', { publishName: 'dup' });
    const repo = agentRepoOf(scorer, dupA, dupB);
    const resolved = await resolveAgentCapabilities(scope, [], [], tools, skills, [sub('scorer')], repo);
    expect(resolved.subAgents.map((s) => s.toolName)).toEqual(['ask_scorer']);
    // 同一 publishName の2サブは ask_dup が衝突する。
    await expect(resolveAgentCapabilities(scope, [], [], tools, skills, [sub('dup-a'), sub('dup-b')], repo)).rejects.toThrow(/collides/);
  });
});

describe('resolveEffectiveSideEffect', () => {
  it('自Toolとサブの実効値の最大を推移的に取る', async () => {
    // root(write直付) -> child(external-action) => external-action
    const child = makeAgent('child', { tools: [{ internalId: 'caller', version }] });
    const root = makeAgent('root', { tools: [{ internalId: 'writer', version }], agents: [sub('child')] });
    const repo = agentRepoOf(child);
    await expect(resolveEffectiveSideEffect(scope, root, { tools, agents: repo, skills })).resolves.toBe('external-action');
  });

  it('ダイヤモンド参照でも共有サブを1回だけロードする（メモ化）', async () => {
    const d = makeAgent('d', { tools: [{ internalId: 'writer', version }] });
    const b = makeAgent('b', { agents: [sub('d')] });
    const c = makeAgent('c', { agents: [sub('d')] });
    const root = makeAgent('root', { agents: [sub('b'), sub('c')] });
    const repo = agentRepoOf(b, c, d);
    await expect(resolveEffectiveSideEffect(scope, root, { tools, agents: repo })).resolves.toBe('write');
    const dLoads = (repo.findVersion as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) => call[1] === 'd');
    expect(dLoads.length).toBe(1);
  });

  it('深さ上限を超える委譲チェーンを拒否する', async () => {
    const d = makeAgent('d');
    const c = makeAgent('c', { agents: [sub('d')] });
    const b = makeAgent('b', { agents: [sub('c')] });
    const a = makeAgent('a', { agents: [sub('b')] });
    const root = makeAgent('root', { agents: [sub('a')] });
    const repo = agentRepoOf(a, b, c, d);
    await expect(resolveEffectiveSideEffect(scope, root, { tools, agents: repo })).rejects.toThrow(new RegExp(`max depth ${HARD_MAX_DEPTH}`));
  });
});
