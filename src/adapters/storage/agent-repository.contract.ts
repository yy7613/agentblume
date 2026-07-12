import { expect } from 'vitest';
import { createAgent } from '../../domain/agent/agent';
import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentVersionConflictError } from '../../domain/agent/errors';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };
function agent(version: SemVer, displayName = 'Agent') {
  return createAgent({
    metadata: { internalId: 'agent-1', workingName: 'work', displayName, publishName: 'agent', version, owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'Prompt', tools: [{ internalId: 'tool-1', version: SemVer.of(1, 0, 0) }],
  });
}

export async function agentRepositoryContract(repo: AgentRepository): Promise<void> {
  const first = agent(SemVer.of(1, 0, 0), 'Old');
  await repo.save(first);
  await repo.save(agent(SemVer.of(1, 10, 0), 'New'));
  expect((await repo.findVersion(scope, 'agent-1', SemVer.of(1, 0, 0)))?.systemPrompt).toBe('Prompt');
  expect((await repo.findLatest(scope, 'agent-1'))?.metadata.displayName).toBe('New');
  expect((await repo.updateState!(scope, 'agent-1', SemVer.of(1, 10, 0), 'in-review')).metadata.state).toBe('in-review');
  expect((await repo.findLatest(scope, 'agent-1'))?.metadata.state).toBe('in-review');
  expect((await repo.listVersions(scope, 'agent-1')).map(String)).toEqual(['1.0.0', '1.10.0']);
  await expect(repo.save(first)).rejects.toBeInstanceOf(AgentVersionConflictError);
  expect(await repo.findLatest({ tenantId: 'other', workspaceId: 'workspace' }, 'agent-1')).toBeNull();
  const summaries = await repo.list(scope);
  expect(summaries).toHaveLength(1);
  expect(summaries[0]?.latestVersion.toString()).toBe('1.10.0');
}
