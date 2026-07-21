import { afterEach, describe, expect, it } from 'vitest';
import { createAgentHarness, type AgentHarness } from '../../domain/harness/agent-harness';
import { SemVer } from '../../domain/tool/semver';
import { SqliteAgentHarnessRepository } from './sqlite-harness-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const version = SemVer.parse('1.0.0');

function fixture(internalId: string): AgentHarness {
  return createAgentHarness({
    metadata: { internalId, workingName: internalId, displayName: internalId, publishName: internalId, version, owner: 'owner', state: 'draft', tenant: scope },
    pattern: 'sequential',
    slots: [
      { id: 'a', label: 'A', purpose: 'first', assignment: { internalId: 'agent-a', version } },
      { id: 'b', label: 'B', purpose: 'second', assignment: { internalId: 'agent-b', version } },
    ],
    topology: { pattern: 'sequential', orderedSlotIds: ['a', 'b'], contextMode: 'full-conversation' },
  });
}

describe('SqliteAgentHarnessRepository delete（論理削除）', () => {
  const repositories: SqliteAgentHarnessRepository[] = [];
  afterEach(() => { repositories.splice(0).forEach((repository) => repository.close()); });

  it('delete後、listから除外されfindLatestはnullになるが、findVersionは既存versionを返し続ける', async () => {
    const repo = new SqliteAgentHarnessRepository(); repositories.push(repo);
    await repo.save(fixture('content-review'));

    await expect(repo.delete(scope, 'content-review')).resolves.toBe(true);

    expect((await repo.list(scope)).map((item) => item.internalId)).not.toContain('content-review');
    await expect(repo.findLatest(scope, 'content-review')).resolves.toBeNull();
    await expect(repo.listVersions(scope, 'content-review')).resolves.toEqual([]);
    await expect(repo.findVersion(scope, 'content-review', version)).resolves.toMatchObject({ metadata: { internalId: 'content-review' } });
  });

  it('未存在のinternalIdをdeleteするとfalseを返す', async () => {
    const repo = new SqliteAgentHarnessRepository(); repositories.push(repo);
    await expect(repo.delete(scope, 'missing')).resolves.toBe(false);
  });

  it('既に削除済みのinternalIdを再度deleteするとfalseを返す', async () => {
    const repo = new SqliteAgentHarnessRepository(); repositories.push(repo);
    await repo.save(fixture('content-review'));
    await expect(repo.delete(scope, 'content-review')).resolves.toBe(true);
    await expect(repo.delete(scope, 'content-review')).resolves.toBe(false);
  });

  it('複数versionを保存していても、deleteは全versionを論理削除しfindVersionだけが残る', async () => {
    const repo = new SqliteAgentHarnessRepository(); repositories.push(repo);
    const v1 = fixture('content-review');
    await repo.save(v1);
    await repo.save(createAgentHarness({ metadata: { ...v1.metadata, version: SemVer.parse('2.0.0') }, pattern: v1.pattern, slots: v1.slots, topology: v1.topology, policies: v1.policies, output: v1.output }));

    await repo.delete(scope, 'content-review');

    await expect(repo.listVersions(scope, 'content-review')).resolves.toEqual([]);
    await expect(repo.findVersion(scope, 'content-review', SemVer.parse('1.0.0'))).resolves.toMatchObject({ metadata: { version: SemVer.parse('1.0.0') } });
    await expect(repo.findVersion(scope, 'content-review', SemVer.parse('2.0.0'))).resolves.toMatchObject({ metadata: { version: SemVer.parse('2.0.0') } });
  });
});
