import { expect } from 'vitest';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { createScenario } from '../../domain/validation/scenario';
import type { ScenarioRepository } from '../../domain/validation/scenario-repository';
import { DEFAULT_SURVEY } from '../../domain/validation/survey';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };

function scenario(version: SemVer, displayName = 'Sales check') {
  return createScenario({
    metadata: { internalId: 'sales-check', workingName: 'work', displayName, publishName: 'sales_check', version, owner: 'owner', state: 'draft', tenant: scope },
    target: { agentId: 'agent-1', version: SemVer.of(1, 2, 0) },
    persona: { personaId: 'persona-1', version: SemVer.of(1, 0, 0) },
    goal: '先月の売上サマリを得る', context: '締め前', maxUserTurns: 4,
    expectedTools: ['sales_summary'], survey: DEFAULT_SURVEY,
  });
}

export async function scenarioRepositoryContract(repo: ScenarioRepository): Promise<void> {
  const first = scenario(SemVer.of(1, 0, 0), 'Old');
  await repo.save(first);
  await repo.save(scenario(SemVer.of(1, 10, 0), 'New'));
  expect(await repo.findVersion(scope, 'sales-check', SemVer.of(1, 0, 0))).toEqual(first);
  expect((await repo.findVersion(scope, 'sales-check', SemVer.of(1, 0, 0)))?.target.version.toString()).toBe('1.2.0');
  expect((await repo.findLatest(scope, 'sales-check'))?.metadata.displayName).toBe('New');
  expect((await repo.listVersions(scope, 'sales-check')).map(String)).toEqual(['1.0.0', '1.10.0']);
  await expect(repo.save(first)).rejects.toBeInstanceOf(VersionConflictError);
  expect(await repo.findLatest({ tenantId: 'other', workspaceId: 'workspace' }, 'sales-check')).toBeNull();
  expect(await repo.list({ tenantId: 'tenant', workspaceId: 'other' })).toEqual([]);
  const summaries = await repo.list(scope);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]).toMatchObject({ internalId: 'sales-check', displayName: 'New', state: 'draft' });
  expect(summaries[0]?.latestVersion.toString()).toBe('1.10.0');

  // delete(論理削除): listから除外され、findLatestはnullになるが、findVersionは既存versionを返し続ける。
  await repo.save(createScenario({
    metadata: { internalId: 'other-scenario', workingName: 'work', displayName: 'Other', publishName: 'other_scenario', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    target: { agentId: 'agent-1', version: SemVer.of(1, 2, 0) }, persona: { personaId: 'persona-1', version: SemVer.of(1, 0, 0) },
    goal: 'other', context: 'other', maxUserTurns: 4, survey: DEFAULT_SURVEY,
  }));
  await expect(repo.delete(scope, 'sales-check')).resolves.toBe(true);
  expect((await repo.list(scope)).map((item) => item.internalId)).toEqual(['other-scenario']);
  await expect(repo.findLatest(scope, 'sales-check')).resolves.toBeNull();
  await expect(repo.listVersions(scope, 'sales-check')).resolves.toEqual([]);
  expect((await repo.findVersion(scope, 'sales-check', SemVer.of(1, 0, 0)))?.metadata.internalId).toBe('sales-check');
  await expect(repo.delete(scope, 'sales-check')).resolves.toBe(false);
  await expect(repo.delete(scope, 'missing')).resolves.toBe(false);
  expect((await repo.findLatest(scope, 'other-scenario'))?.metadata.internalId).toBe('other-scenario');
}
