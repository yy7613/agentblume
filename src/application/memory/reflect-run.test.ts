import { describe, expect, it } from 'vitest';
import { FakeMemoryProposalRepository, FakeSkillRepository, FakeWikiRepository } from './memory-repositories.fixtures';
import { MemoryDomainError } from '../../domain/memory/errors';
import { createWikiPage } from '../../domain/memory/wiki-page';
import { createSkill } from '../../domain/skill/skill';
import { SemVer } from '../../domain/tool/semver';
import type { ModelCompletion, ModelCompletionRequest, ModelProviderPort } from '../model/model-provider';
import { bundledPrompts } from '../../test-support/prompts';
import { ReflectRunUseCase } from './reflect-run';

const scope = { tenantId: 'local', workspaceId: 'default' };

/** キューした content を順に返すフェイクモデル。complete 呼び出しの request を記録する。 */
class FakeModel implements ModelProviderPort {
  readonly requests: ModelCompletionRequest[] = [];
  constructor(private readonly contents: (string | null)[]) {}
  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const content = this.contents.shift() ?? null;
    return { message: { role: 'assistant', content }, finishReason: 'stop' };
  }
  capabilities() { return ['chat', 'structured-output'] as const; }
}

const reflection = (over: Record<string, unknown> = {}) => JSON.stringify({
  wikiShouldPropose: true, wikiTitle: 'Cohort filter', wikiTags: 'sql, cohort', wikiBody: 'Use age>=18.', wikiSummary: 'Capture cohort rule',
  skillShouldPropose: false, skillInstructions: '', skillSummary: '', ...over,
});

function ids() { let n = 0; return () => `id-${(n += 1)}`; }

describe('ReflectRunUseCase', () => {
  it('wiki 提案を draft で作成・保存する（新規ページ）', async () => {
    const proposals = new FakeMemoryProposalRepository();
    const model = new FakeModel([reflection()]);
    const uc = new ReflectRunUseCase(model, proposals, new FakeWikiRepository(), new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date('2026-07-08T00:00:00.000Z'));
    const result = await uc.execute({ scope, input: 'show adults', output: '42 rows', sourceRunId: 'run-9' });
    expect(result).toHaveLength(1);
    expect(result[0]?.state).toBe('draft');
    expect(result[0]?.target).toMatchObject({ kind: 'wiki', isNewPage: true, title: 'Cohort filter', tags: ['sql', 'cohort'] });
    expect(result[0]?.sourceRun).toBe('run-9');
    expect((await proposals.list(scope)).length).toBe(1);
  });

  it('existingWikiPageId 指定時は既存ページの改訂案（isNewPage=false・同一 pageId）', async () => {
    const wiki = new FakeWikiRepository();
    await wiki.save(createWikiPage({ id: 'page-1', tenant: scope, title: 'Old', tags: [], body: 'old body', updatedAt: 't' }));
    const model = new FakeModel([reflection()]);
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), wiki, new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date());
    const [proposal] = await uc.execute({ scope, input: 'i', output: 'o', existingWikiPageId: 'page-1' });
    expect(proposal?.target).toMatchObject({ kind: 'wiki', pageId: 'page-1', isNewPage: false });
    // 現行本文がプロンプトに含まれる。
    expect(model.requests[0]?.messages[1]?.content).toContain('old body');
  });

  it('targetSkillId があれば skill 改訂提案も作る（現行 instructions をプロンプトへ）', async () => {
    const skills = new FakeSkillRepository();
    await skills.save(createSkill({
      metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'o', state: 'draft', tenant: scope },
      responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'current steps', tools: [],
    }));
    const model = new FakeModel([reflection({ skillShouldPropose: true, skillInstructions: 'better steps', skillSummary: 'tighten' })]);
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), new FakeWikiRepository(), skills, bundledPrompts(), ids(), () => new Date());
    const result = await uc.execute({ scope, input: 'i', output: 'o', targetSkillId: 'analysis' });
    expect(result.map((p) => p.target.kind).sort()).toEqual(['skill', 'wiki']);
    expect(model.requests[0]?.messages[1]?.content).toContain('current steps');
  });

  it('shouldPropose=false や空フィールドは提案しない', async () => {
    const model = new FakeModel([reflection({ wikiShouldPropose: false, skillShouldPropose: true, skillInstructions: 'x', skillSummary: 'y' })]);
    // targetSkill 無し → skill 提案は落ちる。wiki も false。結果空。
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), new FakeWikiRepository(), new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date());
    expect(await uc.execute({ scope, input: 'i', output: 'o' })).toEqual([]);
  });

  it('従来どおり: targetSkill有りのsystem文はプロンプトファイル移行後も完全一致する（v48移行のfixture）', async () => {
    const skills = new FakeSkillRepository();
    await skills.save(createSkill({
      metadata: { internalId: 'analysis', workingName: 'w', displayName: 'Analysis', publishName: 'analysis', version: SemVer.of(1, 0, 0), owner: 'o', state: 'draft', tenant: scope },
      responsibility: 'r', activationCondition: 'a', inputDescription: 'i', outputDescription: 'o', instructions: 'current steps', tools: [],
    }));
    const model = new FakeModel([reflection()]);
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), new FakeWikiRepository(), skills, bundledPrompts(), ids(), () => new Date());
    await uc.execute({ scope, input: 'i', output: 'o', targetSkillId: 'analysis' });
    expect(model.requests[0]?.messages[0]?.content).toBe([
      'You curate an agent\'s long-term memory. Given one successful interaction, extract durable, reusable knowledge.',
      '- Propose a wiki note only for knowledge that generalizes beyond this single request. Set wikiShouldPropose=false otherwise.',
      '- If the target skill\'s instructions could be improved by what this interaction revealed, propose a full revised instructions text; else skillShouldPropose=false.',
      'Do not fabricate. Be concise. Follow the JSON schema exactly.',
    ].join('\n'));
  });

  it('従来どおり: targetSkill無しのsystem文はプロンプトファイル移行後も完全一致する（v48移行のfixture）', async () => {
    const model = new FakeModel([reflection()]);
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), new FakeWikiRepository(), new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date());
    await uc.execute({ scope, input: 'i', output: 'o' });
    expect(model.requests[0]?.messages[0]?.content).toBe([
      'You curate an agent\'s long-term memory. Given one successful interaction, extract durable, reusable knowledge.',
      '- Propose a wiki note only for knowledge that generalizes beyond this single request. Set wikiShouldPropose=false otherwise.',
      '- There is no target skill; set skillShouldPropose=false and leave skill fields empty.',
      'Do not fabricate. Be concise. Follow the JSON schema exactly.',
    ].join('\n'));
  });

  it('不正 JSON は1回再試行し、なお失敗で MemoryDomainError', async () => {
    const model = new FakeModel(['not json', 'still not json']);
    const uc = new ReflectRunUseCase(model, new FakeMemoryProposalRepository(), new FakeWikiRepository(), new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date());
    await expect(uc.execute({ scope, input: 'i', output: 'o' })).rejects.toBeInstanceOf(MemoryDomainError);
  });

  it('input/output 空は MemoryDomainError', async () => {
    const uc = new ReflectRunUseCase(new FakeModel([]), new FakeMemoryProposalRepository(), new FakeWikiRepository(), new FakeSkillRepository(), bundledPrompts(), ids(), () => new Date());
    await expect(uc.execute({ scope, input: '  ', output: 'o' })).rejects.toBeInstanceOf(MemoryDomainError);
    await expect(uc.execute({ scope, input: 'i', output: '' })).rejects.toBeInstanceOf(MemoryDomainError);
  });
});
