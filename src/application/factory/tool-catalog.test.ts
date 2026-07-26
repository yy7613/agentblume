import { describe, expect, it } from 'vitest';
import { InMemoryToolRepository } from '../../adapters/storage/in-memory-tool-repository';
import type { ToolGraph } from '../../domain/etl/graph';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState, SideEffect, ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool, type Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { buildExistingToolCatalog, isReusableSideEffect } from './tool-catalog';

const scope = { tenantId: 't', workspaceId: 'w' };

const graph: ToolGraph = {
  nodes: [
    { id: 'src', type: 'csv-source', config: { dataSourceId: 'ds-1' } },
    { id: 'out', type: 'agent-output', config: { shape: 'rows', format: 'json', maxRows: 100, maxBytes: 65536, overflow: 'error' } },
  ],
  edges: [{ from: 'src', to: 'out' }],
};

function makeTool(overrides: {
  readonly internalId: string;
  readonly publishName: string;
  readonly displayName?: string;
  readonly owner?: string;
  readonly state?: PublishState;
  readonly sideEffect?: SideEffect;
  readonly version?: SemVer;
  readonly agentTool?: { readonly name: string; readonly description: string };
  readonly inputColumns?: readonly { readonly name: string; readonly type: 'string' | 'number' }[];
}): Tool {
  return createTool({
    metadata: {
      internalId: overrides.internalId,
      workingName: `${overrides.publishName} draft`,
      displayName: overrides.displayName ?? overrides.publishName,
      publishName: overrides.publishName,
      version: overrides.version ?? SemVer.of(1, 0, 0),
      owner: overrides.owner ?? 'human',
      state: overrides.state ?? 'draft',
      tenant: scope,
    },
    sideEffect: overrides.sideEffect ?? 'read-only',
    graph,
    ...(overrides.inputColumns === undefined ? {} : { inputSchema: { columns: overrides.inputColumns.map((column) => ({ ...column, nullable: false })) } }),
    ...(overrides.agentTool === undefined ? {} : { agentTool: overrides.agentTool }),
  });
}

async function seed(): Promise<InMemoryToolRepository> {
  const repo = new InMemoryToolRepository();
  await repo.save(makeTool({
    internalId: 'builtin-current-datetime', publishName: 'current_datetime', displayName: 'Current Datetime', owner: 'builtin',
    agentTool: { name: 'current_datetime', description: 'Returns the current date and time.' },
  }));
  await repo.save(makeTool({
    internalId: 'tool-lookup', publishName: 'factory_tool_lookup', displayName: 'Lookup Sales', owner: 'agent-factory',
    agentTool: { name: 'lookup_sales', description: 'Look up sales rows at or above minimumAmount.' },
    inputColumns: [{ name: 'minimumAmount', type: 'number' }],
  }));
  await repo.save(makeTool({ internalId: 'tool-manual', publishName: 'a_manual_tool', displayName: '手作りツール', sideEffect: 'session-write' }));
  return repo;
}

describe('buildExistingToolCatalog', () => {
  it('保存済みToolを再利用候補の要約へ写す（agentTool未設定はpublishName/displayNameへフォールバック）', async () => {
    const catalog = await buildExistingToolCatalog(await seed(), scope);

    expect(catalog.totalCount).toBe(3);
    // 並びは決定的: 組み込み（owner:'builtin'）が先頭、その後はpublishName昇順。
    expect(catalog.entries.map((entry) => entry.publishName)).toEqual(['current_datetime', 'a_manual_tool', 'factory_tool_lookup']);
    expect(catalog.entries[0]).toEqual({
      internalId: 'builtin-current-datetime', latestVersion: '1.0.0', publishName: 'current_datetime', displayName: 'Current Datetime',
      toolName: 'current_datetime', description: 'Returns the current date and time.', inputs: [], sideEffect: 'read-only', owner: 'builtin',
    });
    // agentTool未設定Toolは publishName / displayName を契約面として使う。
    expect(catalog.entries[1]).toMatchObject({ toolName: 'a_manual_tool', description: '手作りツール', sideEffect: 'session-write' });
    // Tool引数は "name:type" の一覧として渡す（Plannerが「引数が過不足なく使えるか」を判断できるように）。
    expect(catalog.entries[2]?.inputs).toEqual(['minimumAmount:number']);
  });

  it('最新版のバージョンを再利用対象として採る', async () => {
    const repo = await seed();
    await repo.save(makeTool({ internalId: 'tool-manual', publishName: 'a_manual_tool', displayName: '手作りツール', sideEffect: 'session-write', version: SemVer.of(1, 2, 0) }));

    const catalog = await buildExistingToolCatalog(repo, scope);
    expect(catalog.entries.find((entry) => entry.internalId === 'tool-manual')?.latestVersion).toBe('1.2.0');
  });

  it('write/external-action・deprecated/archived・論理削除済みのToolは候補にしない', async () => {
    const repo = await seed();
    await repo.save(makeTool({ internalId: 'tool-write', publishName: 'writes_something', sideEffect: 'write' }));
    await repo.save(makeTool({ internalId: 'tool-external', publishName: 'calls_api', sideEffect: 'external-action' }));
    await repo.save(makeTool({ internalId: 'tool-deprecated', publishName: 'old_tool', state: 'deprecated' }));
    await repo.save(makeTool({ internalId: 'tool-archived', publishName: 'archived_tool', state: 'archived' }));
    await repo.delete(scope, 'tool-manual');

    const catalog = await buildExistingToolCatalog(repo, scope);
    expect(catalog.entries.map((entry) => entry.internalId)).toEqual(['builtin-current-datetime', 'tool-lookup']);
    expect(catalog.totalCount).toBe(2);
  });

  it('上限を超える分は切り捨て、totalCountに総数を残す（組み込みは切り捨てられない）', async () => {
    const catalog = await buildExistingToolCatalog(await seed(), scope, 1);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]?.internalId).toBe('builtin-current-datetime');
    expect(catalog.totalCount).toBe(3);
  });

  it('一覧に出たがlatestを取得できないTool（競合削除）は候補から外す', async () => {
    const summary: ToolSummary = { internalId: 'ghost', publishName: 'ghost_tool', displayName: 'Ghost', latestVersion: SemVer.of(1, 0, 0), state: 'draft', sideEffect: 'read-only' };
    const repo: ToolRepository = {
      save: async () => {},
      findVersion: async () => null,
      findLatest: async () => null,
      listVersions: async () => [],
      list: async (_scope: TenantScope) => [summary],
      delete: async () => false,
    };
    expect(await buildExistingToolCatalog(repo, scope)).toEqual({ entries: [], totalCount: 0 });
  });
});

describe('isReusableSideEffect', () => {
  it('read-only / session-write のみ再利用できる', () => {
    expect(isReusableSideEffect('read-only')).toBe(true);
    expect(isReusableSideEffect('session-write')).toBe(true);
    expect(isReusableSideEffect('write')).toBe(false);
    expect(isReusableSideEffect('external-action')).toBe(false);
  });
});
