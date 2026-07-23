import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillValidationError } from '../../domain/skill/errors';
import type { Skill } from '../../domain/skill/skill';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { GenerateSkillPromptUseCase } from './generate-skill-prompt';
import { SaveSkillUseCase } from './save-skill';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const ref = { internalId: 'scores', version: SemVer.of(1, 0, 0) };

describe('Skill use cases', () => {
  let tools: ToolRepository;
  let skills: SkillRepository;
  let saved: Skill[];

  beforeEach(async () => {
    const tool = createTool({
      metadata: { internalId: 'scores', workingName: 'Scores', displayName: 'Score filter', publishName: 'filter_scores', version: ref.version, owner: 'owner', state: 'draft', tenant: scope },
      sideEffect: 'read-only', graph: { nodes: [{ id: 'source', type: 'json-source', config: { rows: [] } }], edges: [] },
    });
    tools = {
      save: vi.fn(),
      findVersion: vi.fn(async (requestedScope, id, version) => requestedScope.tenantId === scope.tenantId && requestedScope.workspaceId === scope.workspaceId && id === 'scores' && version.equals(ref.version) ? tool : null),
      findLatest: vi.fn(), listVersions: vi.fn(), list: vi.fn(), delete: vi.fn(),
    };
    saved = [];
    skills = {
      save: vi.fn(async (skill) => { saved.push(skill); }),
      findVersion: vi.fn(async (_scope, id, version) => saved.find((skill) => skill.metadata.internalId === id && skill.metadata.version.equals(version)) ?? null),
      findLatest: vi.fn(async (_scope, id) => saved.filter((skill) => skill.metadata.internalId === id).at(-1) ?? null),
      listVersions: vi.fn(async (_scope, id) => saved.filter((skill) => skill.metadata.internalId === id).map((skill) => skill.metadata.version)),
      list: vi.fn(), delete: vi.fn(),
    };
  });

  function input() {
    return {
      scope, internalId: 'analysis', workingName: 'Analysis', displayName: 'Data analysis', publishName: 'data_analysis', owner: 'owner',
      responsibility: 'Analyze data.', activationCondition: 'For data questions.', inputDescription: 'Data.', outputDescription: 'Answer.',
      instructions: 'Use the selected tools.', tools: [ref],
    };
  }

  it('保存済みToolへ固定しSemVerを自動更新する', async () => {
    const useCase = new SaveSkillUseCase(skills, tools);
    expect((await useCase.execute(input())).metadata.version.toString()).toBe('1.0.0');
    expect((await useCase.execute({ ...input(), bump: 'minor' })).metadata.version.toString()).toBe('1.1.0');
    expect(saved.at(-1)?.tools[0]?.version.toString()).toBe('1.0.0');
  });

  it('未存在Tool参照を保存・prompt生成の両方で拒否する', async () => {
    const missing = [{ internalId: 'missing', version: SemVer.of(1, 0, 0) }];
    await expect(new SaveSkillUseCase(skills, tools).execute({ ...input(), tools: missing })).rejects.toBeInstanceOf(SkillValidationError);
    await expect(new GenerateSkillPromptUseCase(tools).execute({ ...input(), tools: missing })).rejects.toBeInstanceOf(SkillValidationError);
  });

  it('公開Tool名を含む決定的で編集可能なprompt草案を返す', async () => {
    const useCase = new GenerateSkillPromptUseCase(tools);
    const promptInput = input();
    const first = await useCase.execute(promptInput);
    const second = await useCase.execute(promptInput);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ editable: true, sources: ['tool:filter_scores@1.0.0'] });
    expect(first.promptDraft).toContain('filter_scores@1.0.0');
  });
});
