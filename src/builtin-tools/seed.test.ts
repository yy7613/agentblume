import { describe, expect, it, vi } from 'vitest';
import type { SaveToolInput } from '../application/tool/save-tool';
import { BUILTIN_TOOLS } from '../builtin-tools';
import { seedTools, type BuiltinToolSeed } from './seed';

const scope = { tenantId: 'local', workspaceId: 'default' };

function seed(internalId: string): BuiltinToolSeed {
  return {
    internalId, workingName: `${internalId} draft`, displayName: internalId, publishName: internalId.replaceAll('-', '_'),
    owner: 'builtin', sideEffect: 'read-only',
    graph: { nodes: [{ id: 'now', type: 'current-datetime', config: {} }], edges: [] },
  };
}

function ports(existing: readonly string[] = []) {
  const saved: SaveToolInput[] = [];
  return {
    saved,
    listTools: { execute: vi.fn(async () => existing.map((internalId) => ({ internalId }))) },
    saveTool: { execute: vi.fn(async (input: SaveToolInput) => { saved.push(input); }) },
  };
}

describe('seedTools（組込みツールの共通シードループ）', () => {
  it('正常: 並べた順に scope を付けて保存し、internalId を同じ順で返す', async () => {
    const fake = ports();
    await expect(seedTools(fake, scope, [seed('b'), seed('a')])).resolves.toEqual(['b', 'a']);
    expect(fake.saved.map((input) => [input.internalId, input.scope])).toEqual([['b', scope], ['a', scope]]);
    expect(fake.listTools.execute).toHaveBeenCalledWith(scope);
  });

  it('境界: 既にある internalId は保存しない（冪等）が、返す一覧には含める', async () => {
    const fake = ports(['a']);
    await expect(seedTools(fake, scope, [seed('a'), seed('b')])).resolves.toEqual(['a', 'b']);
    expect(fake.saved.map((input) => input.internalId)).toEqual(['b']);
  });

  it('境界: 空の定義（未実装の業務）でも一覧を読むだけで何も保存しない', async () => {
    const fake = ports();
    await expect(seedTools(fake, scope, [])).resolves.toEqual([]);
    expect(fake.saveTool.execute).not.toHaveBeenCalled();
  });

  it('異常: internalId が重なったら何も保存せずに落とす（片方が黙って登録されないのを防ぐ）', async () => {
    const fake = ports();
    await expect(seedTools(fake, scope, [seed('dup'), seed('x'), seed('dup')])).rejects.toThrow('builtin tool is seeded twice: dup');
    expect(fake.listTools.execute).not.toHaveBeenCalled();
    expect(fake.saveTool.execute).not.toHaveBeenCalled();
  });

  it('例外: 保存の失敗はそのまま伝え、後続は登録しない', async () => {
    const fake = ports();
    fake.saveTool.execute.mockRejectedValueOnce(new Error('invalid graph'));
    await expect(seedTools(fake, scope, [seed('a'), seed('b')])).rejects.toThrow('invalid graph');
    expect(fake.saveTool.execute).toHaveBeenCalledTimes(1);
  });

  it('例外: 全業務の定義を合わせても internalId と公開名が重ならない', () => {
    const ids = BUILTIN_TOOLS.map((tool) => tool.internalId);
    expect(new Set(ids).size).toBe(ids.length);
    const names = BUILTIN_TOOLS.map((tool) => tool.publishName);
    expect(new Set(names).size).toBe(names.length);
  });
});
