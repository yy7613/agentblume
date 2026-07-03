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
}
