/**
 * PreviewToolUseCase のテスト（v3 実装契約 §2）
 *
 * Fake リポジトリ（テスト内インライン・Map ベース）+ 実 EtlEngine
 * （createDefaultRegistry）で検証する。adapters には依存しない。
 */
import { describe, expect, it } from 'vitest';
import { EtlEngine } from '../etl/engine';
import type { ToolGraph } from '../../domain/etl/graph';
import { createDefaultRegistry } from '../../domain/etl/nodes/index';
import { ToolNotFoundError } from '../../domain/tool/errors';
import { tenantKey } from '../../domain/tool/ids';
import type { TenantScope, ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';
import { createTool } from '../../domain/tool/tool';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { PreviewToolUseCase } from './preview-tool';

/** テスト用インライン Fake（ToolRepository を満たす Map ベース最小実装）。 */
class FakeToolRepository implements ToolRepository {
  private readonly store = new Map<string, Tool>();

  private key(scope: TenantScope, internalId: ToolId, version: SemVer): string {
    return `${tenantKey(scope)} ${internalId} ${version.toString()}`;
  }

  async save(tool: Tool): Promise<void> {
    this.store.set(
      this.key(tool.metadata.tenant, tool.metadata.internalId, tool.metadata.version),
      tool,
    );
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
    // PreviewToolUseCase では未使用。
    return [];
  }

  async delete(): Promise<boolean> { return false; }
}

const scope: TenantScope = { tenantId: 'tenant-a', workspaceId: 'ws-1' };

/** v1 グラフ: json-source（3行）→ filter(a gte 2) → 2行出力。 */
const graphV1: ToolGraph = {
  nodes: [
    { id: 'src', type: 'json-source', config: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    { id: 'flt', type: 'filter', config: { column: 'a', op: 'gte', value: 2 } },
  ],
  edges: [{ from: 'src', to: 'flt' }],
};

/** v2 グラフ: 同ソースだが filter(a gte 3) → 1行出力（v1 と結果が異なる）。 */
const graphV2: ToolGraph = {
  nodes: [
    { id: 'src', type: 'json-source', config: { rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } },
    { id: 'flt', type: 'filter', config: { column: 'a', op: 'gte', value: 3 } },
  ],
  edges: [{ from: 'src', to: 'flt' }],
};

/** graph と version を指定して保存用 Tool を作る。 */
function makeTool(graph: ToolGraph, version: SemVer): Tool {
  return createTool({
    metadata: {
      internalId: 'tool-1',
      workingName: 'working',
      displayName: 'Display',
      publishName: 'publish_name',
      version,
      owner: 'owner@example.com',
      state: 'draft',
      tenant: scope,
    },
    sideEffect: 'read-only',
    graph,
  });
}

async function makeSut(): Promise<{ usecase: PreviewToolUseCase; repo: FakeToolRepository }> {
  const repo = new FakeToolRepository();
  await repo.save(makeTool(graphV1, SemVer.of(1, 0, 0)));
  await repo.save(makeTool(graphV2, SemVer.of(1, 0, 1)));
  const engine = new EtlEngine(createDefaultRegistry());
  return { usecase: new PreviewToolUseCase(repo, engine), repo };
}

describe('PreviewToolUseCase', () => {
  describe('preview', () => {
    it('version 無指定は latest（1.0.1 = graphV2）を実行し、期待行を返す', async () => {
      const { usecase } = await makeSut();

      const { tool, result } = await usecase.preview(scope, 'tool-1');

      expect(tool.metadata.version.toString()).toBe('1.0.1');
      expect(result.terminalId).toBe('flt');
      expect(result.output.rows).toEqual([{ a: 3 }]);
    });

    it('version 指定で旧バージョン（1.0.0 = graphV1）の graph が実行され、latest と結果が異なる', async () => {
      const { usecase } = await makeSut();

      const old = await usecase.preview(scope, 'tool-1', { version: SemVer.of(1, 0, 0) });
      const latest = await usecase.preview(scope, 'tool-1');

      expect(old.tool.metadata.version.toString()).toBe('1.0.0');
      expect(old.result.output.rows).toEqual([{ a: 2 }, { a: 3 }]);
      expect(old.result.output.rows.length).not.toBe(latest.result.output.rows.length);
    });

    it('未存在の internalId → ToolNotFoundError', async () => {
      const { usecase } = await makeSut();

      await expect(usecase.preview(scope, 'no-such-tool')).rejects.toThrow(ToolNotFoundError);
    });

    it('未存在の version 指定 → ToolNotFoundError', async () => {
      const { usecase } = await makeSut();

      await expect(
        usecase.preview(scope, 'tool-1', { version: SemVer.of(9, 9, 9) }),
      ).rejects.toThrow(ToolNotFoundError);
    });

    it('別テナントからは不可視 → ToolNotFoundError', async () => {
      const { usecase } = await makeSut();
      const other: TenantScope = { tenantId: 'tenant-b', workspaceId: 'ws-1' };

      await expect(usecase.preview(other, 'tool-1')).rejects.toThrow(ToolNotFoundError);
    });

    it('rowLimit が engine.preview へ伝播し truncated になる', async () => {
      const { usecase } = await makeSut();

      // graphV1（src は 3行）を rowLimit:1 で実行 → src が切り詰められる。
      const { result } = await usecase.preview(scope, 'tool-1', {
        version: SemVer.of(1, 0, 0),
        rowLimit: 1,
      });

      expect(result.nodes['src']?.truncated).toBe(true);
      expect(result.nodes['src']?.table.rows.length).toBe(1);
      expect(result.output.rows.length).toBeLessThanOrEqual(1);
    });

    it('rowLimit 無指定なら engine 既定（100）で truncated しない', async () => {
      const { usecase } = await makeSut();

      const { result } = await usecase.preview(scope, 'tool-1');

      expect(Object.values(result.nodes).every((n) => !n.truncated)).toBe(true);
    });
  });

  describe('inspect', () => {
    it('propagation（トポ順・state・schema）を返し、実行しない', async () => {
      const { usecase } = await makeSut();

      const { tool, propagation } = await usecase.inspect(scope, 'tool-1');

      expect(tool.metadata.version.toString()).toBe('1.0.1');
      expect(propagation.order).toEqual(['src', 'flt']);
      expect(propagation.hasErrors).toBe(false);
      expect(propagation.nodes['src']?.state).toBe('inferred');
      expect(propagation.nodes['flt']?.schema.columns).toEqual([
        { name: 'a', type: 'number', nullable: false },
      ]);
    });

    it('version 指定で旧バージョンを点検できる', async () => {
      const { usecase } = await makeSut();

      const { tool } = await usecase.inspect(scope, 'tool-1', { version: SemVer.of(1, 0, 0) });

      expect(tool.metadata.version.toString()).toBe('1.0.0');
      expect(tool.graph).toEqual(graphV1);
    });

    it('未存在 → ToolNotFoundError', async () => {
      const { usecase } = await makeSut();

      await expect(usecase.inspect(scope, 'no-such-tool')).rejects.toThrow(ToolNotFoundError);
    });
  });
});
