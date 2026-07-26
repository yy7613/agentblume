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

  // ランタイムハーネス設定は保存往復で維持される（未設定Agentはundefinedのまま）。
  const harness = { fileMemory: true, todoProvider: true, compaction: true, webSearch: false, toolApproval: true, functionInvocation: false };
  await repo.save(createAgent({
    metadata: { internalId: 'agent-harness', workingName: 'work', displayName: 'Harnessed', publishName: 'agent_harness', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'Prompt', tools: [], harness,
  }));
  expect((await repo.findLatest(scope, 'agent-harness'))?.harness).toEqual(harness);
  expect((await repo.findVersion(scope, 'agent-harness', SemVer.of(1, 0, 0)))?.harness).toEqual(harness);
  expect((await repo.findLatest(scope, 'agent-1'))?.harness).toBeUndefined();
  await expect(repo.delete(scope, 'agent-harness')).resolves.toBe(true);

  // MCPサーバー参照も保存往復で維持される（未設定Agentはundefinedのまま）。
  await repo.save(createAgent({
    metadata: { internalId: 'agent-mcp', workingName: 'work', displayName: 'Mcp', publishName: 'agent_mcp', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'Prompt', tools: [], mcpServers: ['files', 'github'],
  }));
  expect((await repo.findLatest(scope, 'agent-mcp'))?.mcpServers).toEqual(['files', 'github']);
  expect((await repo.findVersion(scope, 'agent-mcp', SemVer.of(1, 0, 0)))?.mcpServers).toEqual(['files', 'github']);
  expect((await repo.findLatest(scope, 'agent-1'))?.mcpServers).toBeUndefined();
  await expect(repo.delete(scope, 'agent-mcp')).resolves.toBe(true);

  // delete（論理削除）: listから除外され、findLatestはnullになるが、findVersionは既存versionを返し続ける。
  await repo.save(createAgent({
    metadata: { internalId: 'agent-2', workingName: 'work', displayName: 'Other', publishName: 'agent-2', version: SemVer.of(1, 0, 0), owner: 'owner', state: 'draft', tenant: scope },
    kind: 'normal', systemPrompt: 'Prompt', tools: [],
  }));
  await expect(repo.delete(scope, 'agent-1')).resolves.toBe(true);
  expect((await repo.list(scope)).map((item) => item.internalId)).toEqual(['agent-2']);
  await expect(repo.findLatest(scope, 'agent-1')).resolves.toBeNull();
  await expect(repo.listVersions(scope, 'agent-1')).resolves.toEqual([]);
  await expect(repo.findVersion(scope, 'agent-1', SemVer.of(1, 0, 0))).resolves.toMatchObject({ metadata: { internalId: 'agent-1' } });
  await expect(repo.delete(scope, 'agent-1')).resolves.toBe(false);
  await expect(repo.delete(scope, 'missing')).resolves.toBe(false);
  await expect(repo.findLatest(scope, 'agent-2')).resolves.toMatchObject({ metadata: { internalId: 'agent-2' } });
}
