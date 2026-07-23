/**
 * アダプタ: ToolRepository 共有契約スイート（v2 実装契約 §12）
 *
 * `*.test.ts` ではないテストヘルパ（カバレッジ除外済み）。
 * InMemory / Sqlite の両アダプタが同一の契約を満たすことを検証する。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolGraph } from '../../domain/etl/graph';
import { VersionConflictError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';

/** テスト用の最小 ToolGraph（json-source 1ノード）。 */
function makeGraph(): ToolGraph {
  return {
    nodes: [
      {
        id: 'src',
        type: 'json-source',
        config: { rows: [{ id: 1, name: 'alice' }] },
      },
    ],
    edges: [],
  };
}

/** テスト用 Tool を組む小ヘルパ。 */
function makeTool(props: {
  scope: TenantScope;
  internalId: string;
  version: SemVer;
  displayName?: string;
  state?: PublishState;
}): Tool {
  return createTool({
    metadata: {
      internalId: props.internalId,
      workingName: `wn-${props.internalId}`,
      displayName: props.displayName ?? `Display ${props.internalId}`,
      publishName: `pub-${props.internalId}`,
      version: props.version,
      owner: 'tester',
      state: props.state ?? 'draft',
      tenant: props.scope,
    },
    sideEffect: 'read-only',
    graph: makeGraph(),
    inputSchema: { columns: [{ name: 'id', type: 'number', nullable: false }] },
    outputSchema: {
      columns: [
        { name: 'id', type: 'number', nullable: false },
        { name: 'name', type: 'string', nullable: false },
      ],
    },
  });
}

const scopeA: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

/**
 * ToolRepository 実装の共有契約スイート。
 * `makeRepo` は毎テスト新規のリポジトリを返すこと。
 */
export function toolRepositoryContract(
  name: string,
  makeRepo: () => ToolRepository | Promise<ToolRepository>,
  hooks?: { afterEach?: (repo: ToolRepository) => void | Promise<void> },
): void {
  describe(`ToolRepository契約: ${name}`, () => {
    let repo: ToolRepository;

    beforeEach(async () => {
      repo = await makeRepo();
      const cleanup = hooks?.afterEach;
      if (cleanup !== undefined) {
        // vitest は beforeEach が返す関数をテスト後のクリーンアップとして実行する。
        // 生成した repo をクロージャで捕捉し、対応するインスタンスを確実に片付ける。
        const current = repo;
        return async () => {
          await cleanup(current);
        };
      }
      return undefined;
    });

    it('save→findVersion 往復で等価（メタ・graph・schema）', async () => {
      const tool = makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 0) });
      await repo.save(tool);

      const found = await repo.findVersion(scopeA, 'tool-1', SemVer.of(1, 0, 0));
      expect(found).not.toBeNull();
      const f = found as Tool;
      expect(f.metadata.internalId).toBe('tool-1');
      expect(f.metadata.workingName).toBe(tool.metadata.workingName);
      expect(f.metadata.displayName).toBe(tool.metadata.displayName);
      expect(f.metadata.publishName).toBe(tool.metadata.publishName);
      expect(f.metadata.owner).toBe(tool.metadata.owner);
      expect(f.metadata.state).toBe(tool.metadata.state);
      expect(f.metadata.version.equals(tool.metadata.version)).toBe(true);
      expect(f.metadata.tenant).toEqual(scopeA);
      expect(f.sideEffect).toBe(tool.sideEffect);
      expect(f.graph).toEqual(tool.graph);
      expect(f.inputSchema).toEqual(tool.inputSchema);
      expect(f.outputSchema).toEqual(tool.outputSchema);
    });

    it('複数バージョン保存で findLatest が SemVer 最大を返す', async () => {
      // 意図的に非整列順で保存（辞書順 "1.10.0" < "1.9.0" の罠も踏む）。
      for (const v of [SemVer.of(1, 9, 0), SemVer.of(1, 0, 0), SemVer.of(1, 10, 0)]) {
        await repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: v }));
      }
      const latest = await repo.findLatest(scopeA, 'tool-1');
      expect(latest).not.toBeNull();
      expect((latest as Tool).metadata.version.toString()).toBe('1.10.0');
    });

    it('listVersions が昇順で全バージョンを返す', async () => {
      for (const v of [SemVer.of(2, 0, 0), SemVer.of(1, 0, 1), SemVer.of(1, 0, 0)]) {
        await repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: v }));
      }
      const versions = await repo.listVersions(scopeA, 'tool-1');
      expect(versions.map((v) => v.toString())).toEqual(['1.0.0', '1.0.1', '2.0.0']);
    });

    it('list が internalId ごとの最新サマリを返す', async () => {
      await repo.save(
        makeTool({
          scope: scopeA,
          internalId: 'tool-1',
          version: SemVer.of(1, 0, 0),
          displayName: 'Old One',
        }),
      );
      await repo.save(
        makeTool({
          scope: scopeA,
          internalId: 'tool-1',
          version: SemVer.of(1, 1, 0),
          displayName: 'New One',
          state: 'published',
        }),
      );
      await repo.save(
        makeTool({ scope: scopeA, internalId: 'tool-2', version: SemVer.of(3, 0, 0) }),
      );

      const summaries = await repo.list(scopeA);
      expect(summaries).toHaveLength(2);

      const byId = new Map(summaries.map((s) => [s.internalId, s]));
      const s1 = byId.get('tool-1');
      expect(s1).toBeDefined();
      expect(s1?.latestVersion.toString()).toBe('1.1.0');
      expect(s1?.displayName).toBe('New One');
      expect(s1?.publishName).toBe('pub-tool-1');
      expect(s1?.state).toBe('published');

      const s2 = byId.get('tool-2');
      expect(s2).toBeDefined();
      expect(s2?.latestVersion.toString()).toBe('3.0.0');
    });

    it('同一 (tenant, id, version) の再保存で VersionConflictError', async () => {
      const tool = makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 0) });
      await repo.save(tool);
      await expect(repo.save(tool)).rejects.toBeInstanceOf(VersionConflictError);
      // 別バージョンなら保存できる。
      await expect(
        repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 1) })),
      ).resolves.toBeUndefined();
    });

    it('別テナント/別ワークスペースからは不可視（テナント分離）', async () => {
      const otherTenant: TenantScope = { tenantId: 'tenant-b', workspaceId: 'ws-1' };
      const otherWorkspace: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-2' };

      await repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 0) }));

      for (const scope of [otherTenant, otherWorkspace]) {
        expect(await repo.findVersion(scope, 'tool-1', SemVer.of(1, 0, 0))).toBeNull();
        expect(await repo.findLatest(scope, 'tool-1')).toBeNull();
        expect(await repo.listVersions(scope, 'tool-1')).toEqual([]);
        expect(await repo.list(scope)).toEqual([]);
      }

      // 別スコープには同一 (id, version) を独立に保存できる（PK にテナントを含む）。
      await expect(
        repo.save(makeTool({ scope: otherTenant, internalId: 'tool-1', version: SemVer.of(1, 0, 0) })),
      ).resolves.toBeUndefined();
      expect(await repo.findLatest(scopeA, 'tool-1')).not.toBeNull();
    });

    it('未存在の findVersion / findLatest は null', async () => {
      expect(await repo.findVersion(scopeA, 'no-such', SemVer.of(1, 0, 0))).toBeNull();
      expect(await repo.findLatest(scopeA, 'no-such')).toBeNull();
      // 存在する internalId でも未存在バージョンは null。
      await repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 0) }));
      expect(await repo.findVersion(scopeA, 'tool-1', SemVer.of(9, 9, 9))).toBeNull();
    });

    it('delete（論理削除）: listから除外されfindLatestはnullになるが、findVersionは既存versionを返し続ける', async () => {
      await repo.save(makeTool({ scope: scopeA, internalId: 'tool-1', version: SemVer.of(1, 0, 0) }));
      await repo.save(makeTool({ scope: scopeA, internalId: 'tool-2', version: SemVer.of(1, 0, 0) }));

      await expect(repo.delete(scopeA, 'tool-1')).resolves.toBe(true);

      expect((await repo.list(scopeA)).map((item) => item.internalId)).toEqual(['tool-2']);
      expect(await repo.findLatest(scopeA, 'tool-1')).toBeNull();
      expect(await repo.listVersions(scopeA, 'tool-1')).toEqual([]);
      expect((await repo.findVersion(scopeA, 'tool-1', SemVer.of(1, 0, 0)))?.metadata.internalId).toBe('tool-1');
      await expect(repo.delete(scopeA, 'tool-1')).resolves.toBe(false);
      await expect(repo.delete(scopeA, 'no-such')).resolves.toBe(false);
      expect((await repo.findLatest(scopeA, 'tool-2'))?.metadata.internalId).toBe('tool-2');
    });
  });
}
