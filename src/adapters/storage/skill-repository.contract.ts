import { expect } from 'vitest';
import { SkillVersionConflictError } from '../../domain/skill/errors';
import { createSkill } from '../../domain/skill/skill';
import type { SkillRepository } from '../../domain/skill/skill-repository';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };

function skill(version: SemVer, displayName = 'Analysis') {
  return createSkill({
    metadata: { internalId: 'analysis', workingName: 'work', displayName, publishName: 'analysis', version, owner: 'owner', state: 'draft', tenant: scope },
    responsibility: 'Analyze data.', activationCondition: 'For data questions.', inputDescription: 'Data.', outputDescription: 'Answer.',
    instructions: 'Use tools.', tools: [{ internalId: 'scores', version: SemVer.of(1, 0, 0) }],
  });
}

export async function skillRepositoryContract(repo: SkillRepository): Promise<void> {
  const first = skill(SemVer.of(1, 0, 0), 'Old');
  await repo.save(first);
  await repo.save(skill(SemVer.of(1, 10, 0), 'New'));
  expect((await repo.findVersion(scope, 'analysis', SemVer.of(1, 0, 0)))?.instructions).toBe('Use tools.');
  expect((await repo.findLatest(scope, 'analysis'))?.metadata.displayName).toBe('New');
  expect((await repo.listVersions(scope, 'analysis')).map(String)).toEqual(['1.0.0', '1.10.0']);
  await expect(repo.save(first)).rejects.toBeInstanceOf(SkillVersionConflictError);
  expect(await repo.findLatest({ tenantId: 'other', workspaceId: 'workspace' }, 'analysis')).toBeNull();
  expect(await repo.list({ tenantId: 'tenant', workspaceId: 'other' })).toEqual([]);
  const summaries = await repo.list(scope);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ internalId: 'analysis', displayName: 'New' });
  expect(summaries[0]?.latestVersion.toString()).toBe('1.10.0');

  // delete（論理削除）: listから除外され、findLatestはnullになるが、findVersionは既存versionを返し続ける。
  await repo.save(createSkill({
    metadata: { internalId: 'other-skill', workingName: 'work', displayName: 'Other', publishName: 'other', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    responsibility: 'Other.', activationCondition: 'Other.', inputDescription: 'Data.', outputDescription: 'Answer.', instructions: 'Use tools.', tools: [],
  }));
  await expect(repo.delete(scope, 'analysis')).resolves.toBe(true);
  expect((await repo.list(scope)).map((item) => item.internalId)).toEqual(['other-skill']);
  await expect(repo.findLatest(scope, 'analysis')).resolves.toBeNull();
  await expect(repo.listVersions(scope, 'analysis')).resolves.toEqual([]);
  expect((await repo.findVersion(scope, 'analysis', SemVer.of(1, 0, 0)))?.metadata.internalId).toBe('analysis');
  await expect(repo.delete(scope, 'analysis')).resolves.toBe(false);
  await expect(repo.delete(scope, 'missing')).resolves.toBe(false);
  expect((await repo.findLatest(scope, 'other-skill'))?.metadata.internalId).toBe('other-skill');
}
