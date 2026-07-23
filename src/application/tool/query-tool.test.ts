/**
 * GetToolUseCase / ListToolVersionsUseCase のテスト（v2 実装契約 §11）
 *
 * Fake リポジトリ（テスト内インライン・Map ベース）で検証する。
 * adapters には依存しない。
 */
import { describe, expect, it } from 'vitest';
import type { ToolGraph } from '../../domain/etl/graph';
import { ToolNotFoundError, VersionConflictError } from '../../domain/tool/errors';
import { tenantKey } from '../../domain/tool/ids';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { GetToolUseCase, ListToolVersionsUseCase } from './query-tool';

/** テスト用インライン Fake（ToolRepository を満たす Map ベース最小実装）。 */
class FakeToolRepository implements ToolRepository {
  private readonly store = new Map<string, Tool>();

  private key(scope: TenantScope, internalId: ToolId, version: SemVer): string {
    return `${tenantKey(scope)} ${internalId} ${version.toString()}`;
  }

  async save(tool: Tool): Promise<void> {
    const key = this.key(tool.metadata.tenant, tool.metadata.internalId, tool.metadata.version);
    if (this.store.has(key)) {
      throw new VersionConflictError(`duplicate version: ${key}`);
    }
    this.store.set(key, tool);
  }

  async findVersion(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool | null> {
    return this.store.get(this.key(scope, internalId, version)) ?? null;
  }

  async findLatest(scope: TenantScope, internalId: ToolId): Promise<Tool | null> {
    const versions = await this.listVersions(scope, internalId);
    const last = versions[versions.length - 1];
    if (last === undefined) return null;
    return this.findVersion(scope, internalId, last);
  }

  async listVersions(scope: TenantScope, internalId: ToolId): Promise<SemVer[]> {
    return [...this.store.values()]
      .filter(
        (tool) =>
          tenantKey(tool.metadata.tenant) === tenantKey(scope) &&
          tool.metadata.internalId === internalId,
      )
      .map((tool) => tool.metadata.version)
      .sort((a, b) => a.compare(b));
  }

  async list(_scope: TenantScope): Promise<ToolSummary[]> {
    // 本テストでは未使用。
    return [];
  }

  async delete(): Promise<boolean> { return false; }
}

const scope: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

const minimalGraph: ToolGraph = {
  nodes: [{ id: 'src', type: 'json-source', config: { rows: [] } }],
  edges: [],
};

function makeTool(internalId: ToolId, version: SemVer, tenant: TenantScope = scope): Tool {
  return createTool({
    metadata: {
      internalId,
      workingName: 'working',
      displayName: 'Display',
      publishName: 'publish_name',
      version,
      owner: 'owner@example.com',
      state: 'draft',
      tenant,
    },
    sideEffect: 'read-only',
    graph: minimalGraph,
  });
}

describe('GetToolUseCase', () => {
  it('latest: 最大バージョンの Tool を返す', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(1, 1, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 5)));
    const usecase = new GetToolUseCase(repo);

    const tool = await usecase.latest(scope, 'tool-1');

    expect(tool.metadata.version.toString()).toBe('1.1.0');
    expect(tool.metadata.internalId).toBe('tool-1');
  });

  it('latest: 存在しない → ToolNotFoundError', async () => {
    const usecase = new GetToolUseCase(new FakeToolRepository());

    await expect(usecase.latest(scope, 'no-such-tool')).rejects.toThrow(ToolNotFoundError);
  });

  it('version: 指定バージョンの Tool を返す', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(2, 0, 0)));
    const usecase = new GetToolUseCase(repo);

    const tool = await usecase.version(scope, 'tool-1', SemVer.of(1, 0, 0));

    expect(tool.metadata.version.toString()).toBe('1.0.0');
  });

  it('version: 存在しないバージョン → ToolNotFoundError', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    const usecase = new GetToolUseCase(repo);

    await expect(usecase.version(scope, 'tool-1', SemVer.of(9, 9, 9))).rejects.toThrow(
      ToolNotFoundError,
    );
  });

  it('別テナントの Tool は見えない（→ ToolNotFoundError）', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    const usecase = new GetToolUseCase(repo);
    const otherScope: TenantScope = { tenantId: 'tenant-b', workspaceId: 'ws-1' };

    await expect(usecase.latest(otherScope, 'tool-1')).rejects.toThrow(ToolNotFoundError);
  });
});

describe('ListToolVersionsUseCase', () => {
  it('全バージョンを昇順で返す', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(2, 0, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(1, 10, 0)));
    await repo.save(makeTool('tool-1', SemVer.of(1, 2, 3)));
    const usecase = new ListToolVersionsUseCase(repo);

    const versions = await usecase.execute(scope, 'tool-1');

    expect(versions.map((v) => v.toString())).toEqual(['1.0.0', '1.2.3', '1.10.0', '2.0.0']);
  });

  it('未存在 → 空配列', async () => {
    const usecase = new ListToolVersionsUseCase(new FakeToolRepository());

    await expect(usecase.execute(scope, 'no-such-tool')).resolves.toEqual([]);
  });

  it('別 internalId / 別テナントのバージョンは混入しない', async () => {
    const repo = new FakeToolRepository();
    await repo.save(makeTool('tool-1', SemVer.of(1, 0, 0)));
    await repo.save(makeTool('tool-2', SemVer.of(3, 0, 0)));
    await repo.save(
      makeTool('tool-1', SemVer.of(5, 0, 0), { tenantId: 'tenant-b', workspaceId: 'ws-1' }),
    );
    const usecase = new ListToolVersionsUseCase(repo);

    const versions = await usecase.execute(scope, 'tool-1');

    expect(versions.map((v) => v.toString())).toEqual(['1.0.0']);
  });
});
