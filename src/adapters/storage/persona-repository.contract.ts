import { expect } from 'vitest';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createPersona } from '../../domain/validation/persona';
import type { PersonaRepository } from '../../domain/validation/persona-repository';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };

function persona(version: SemVer, displayName = 'Novice', tone = '丁寧') {
  return createPersona({
    metadata: { internalId: 'novice-user', workingName: 'work', displayName, publishName: 'novice_user', version, owner: 'owner', state: 'draft', tenant: scope },
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone, verbosity: 'normal', language: 'ja',
    extraInstructions: '経理部所属。',
  });
}

export async function personaRepositoryContract(repo: PersonaRepository): Promise<void> {
  const first = persona(SemVer.of(1, 0, 0), 'Old');
  await repo.save(first);
  await repo.save(persona(SemVer.of(1, 10, 0), 'New', '事務的'));
  expect(await repo.findVersion(scope, 'novice-user', SemVer.of(1, 0, 0))).toEqual(first);
  expect((await repo.findLatest(scope, 'novice-user'))?.metadata.displayName).toBe('New');
  expect((await repo.listVersions(scope, 'novice-user')).map(String)).toEqual(['1.0.0', '1.10.0']);
  await expect(repo.save(first)).rejects.toBeInstanceOf(VersionConflictError);
  expect(await repo.findLatest({ tenantId: 'other', workspaceId: 'workspace' }, 'novice-user')).toBeNull();
  expect(await repo.list({ tenantId: 'tenant', workspaceId: 'other' })).toEqual([]);
  const summaries = await repo.list(scope);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ internalId: 'novice-user', displayName: 'New', archetype: 'novice', state: 'draft' });
  expect(summaries[0]?.latestVersion.toString()).toBe('1.10.0');

  // delete(論理削除): listから除外され、findLatestはnullになるが、findVersionは既存versionを返し続ける。
  await repo.save(createPersona({
    metadata: { internalId: 'other-persona', workingName: 'work', displayName: 'Other', publishName: 'other_persona', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    archetype: 'novice', knowledgeLevel: 'low', patience: 'mid', tone: '丁寧', verbosity: 'normal', language: 'ja', extraInstructions: '',
  }));
  await expect(repo.delete(scope, 'novice-user')).resolves.toBe(true);
  expect((await repo.list(scope)).map((item) => item.internalId)).toEqual(['other-persona']);
  await expect(repo.findLatest(scope, 'novice-user')).resolves.toBeNull();
  await expect(repo.listVersions(scope, 'novice-user')).resolves.toEqual([]);
  expect((await repo.findVersion(scope, 'novice-user', SemVer.of(1, 0, 0)))?.metadata.internalId).toBe('novice-user');
  await expect(repo.delete(scope, 'novice-user')).resolves.toBe(false);
  await expect(repo.delete(scope, 'missing')).resolves.toBe(false);
  expect((await repo.findLatest(scope, 'other-persona'))?.metadata.internalId).toBe('other-persona');
}
