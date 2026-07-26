import { describe, expect, it } from 'vitest';
import { createMcpServerConfig } from '../../domain/mcp/mcp-server';
import { InMemoryMcpServerRepository } from './in-memory-mcp-server-repository';
import { mcpServerRepositoryContract } from './mcp-server-repository.contract';
import { SqliteMcpServerRepository } from './sqlite-mcp-server-repository';

describe.each([
  ['in-memory', () => ({ repo: new InMemoryMcpServerRepository(), close: () => {} })],
  ['sqlite', () => { const repo = new SqliteMcpServerRepository(); return { repo, close: () => repo.close() }; }],
])('%s MCP server repository', (_name, make) => {
  it('共有契約を満たす', async () => {
    const { repo, close } = make();
    try { await mcpServerRepositoryContract(repo); } finally { close(); }
  });
});

describe('SqliteMcpServerRepository', () => {
  it('replaceAll が失敗したら既存設定を巻き戻す（部分適用しない）', async () => {
    const repo = new SqliteMcpServerRepository();
    try {
      const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
      const keep = createMcpServerConfig({ scope, name: 'keep', transport: { kind: 'stdio', command: 'node', args: [], env: {} }, updatedAt: '2026-07-26T00:00:00.000Z' });
      await repo.save(keep);

      // 直列化不能な値を仕込んで挿入途中で失敗させる（JSON.stringify が投げる）。
      const broken = { ...keep, name: 'broken', updatedAt: 0n as unknown as string };
      await expect(repo.replaceAll(scope, [broken])).rejects.toThrow();

      expect((await repo.list(scope)).map((item) => item.name)).toEqual(['keep']);
    } finally { repo.close(); }
  });
});
