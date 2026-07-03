import { describe, expect, it, vi } from 'vitest';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { createSkill } from '../../domain/skill/skill';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { composeAgentSystemPrompt, resolveAgentCapabilities } from './resolve-agent-capabilities';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.of(1, 0, 0);
const tool = createTool({ metadata: { internalId: 'scores', workingName: 'Scores', displayName: 'Scores', publishName: 'scores', version, owner: 'owner', state: 'draft', tenant: scope }, sideEffect: 'read-only', graph: { nodes: [], edges: [] } });
const skill = createSkill({ metadata: { internalId: 'analysis', workingName: 'Analysis', displayName: 'Analysis', publishName: 'analysis', version, owner: 'owner', state: 'draft', tenant: scope }, responsibility: 'Analyze.', activationCondition: 'For data.', inputDescription: 'Data.', outputDescription: 'Answer.', instructions: 'Always ground answers.', tools: [{ internalId: 'scores', version }] });
const tools = { findVersion: vi.fn(async (_scope, id, requested) => id === 'scores' && requested.equals(version) ? tool : null) } as unknown as ToolRepository;
const skills = { findVersion: vi.fn(async (_scope, id, requested) => id === 'analysis' && requested.equals(version) ? skill : null) } as unknown as SkillRepository;

describe('resolveAgentCapabilities', () => {
  it('Skill由来と直接参照の同一Toolを重複排除しinstructionsを合成する', async () => {
    const resolved = await resolveAgentCapabilities(scope, [{ internalId: 'analysis', version }], [{ internalId: 'scores', version }], tools, skills);
    expect(resolved.tools).toEqual([tool]);
    expect(composeAgentSystemPrompt('Base.', resolved.skills)).toContain('analysis@1.0.0\nAlways ground answers.');
  });

  it('同じToolの異なるversionを曖昧として拒否する', async () => {
    await expect(resolveAgentCapabilities(scope, [{ internalId: 'analysis', version }], [{ internalId: 'scores', version: SemVer.of(2, 0, 0) }], tools, skills)).rejects.toThrow(/ambiguous tool versions/);
  });
});
