/**
 * application層: MCPサーバー設定のCRUD。
 *
 * 設定は版を持たず (scope, name) で upsert する。ReplaceMcpServers は
 * 標準 `mcpServers` ドキュメントをそのまま受け、スコープ内を丸ごと置き換える（JSONタブのApply）。
 */
import type { TenantScope } from '../../domain/tool/ids';
import { McpNotFoundError } from '../../domain/mcp/errors';
import { createMcpServerConfig, type McpServerConfig, type McpTransportConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { parseMcpServersDocument } from '../../domain/mcp/mcp-servers-document';

export interface SaveMcpServerInput {
  readonly scope: TenantScope;
  readonly server: {
    readonly name: string;
    readonly transport: McpTransportConfig;
    readonly disabled?: boolean;
  };
}

export class SaveMcpServerUseCase {
  constructor(private readonly repo: McpServerRepository, private readonly now: () => Date = () => new Date()) {}
  async execute(input: SaveMcpServerInput): Promise<McpServerConfig> {
    const config = createMcpServerConfig({
      scope: input.scope,
      name: input.server.name,
      transport: input.server.transport,
      disabled: input.server.disabled ?? false,
      updatedAt: this.now().toISOString(),
    });
    await this.repo.save(config);
    return config;
  }
}

export class ListMcpServersUseCase {
  constructor(private readonly repo: McpServerRepository) {}
  execute(scope: TenantScope): Promise<readonly McpServerConfig[]> { return this.repo.list(scope); }
}

export class DeleteMcpServerUseCase {
  constructor(private readonly repo: McpServerRepository) {}
  async execute(scope: TenantScope, name: string): Promise<void> {
    const existed = await this.repo.delete(scope, name);
    if (!existed) throw new McpNotFoundError(`MCP server not found: ${name}`);
  }
}

export class ReplaceMcpServersUseCase {
  constructor(private readonly repo: McpServerRepository, private readonly now: () => Date = () => new Date()) {}
  /** doc は `{ mcpServers: { ... } }` 形式。検証に失敗した場合は何も置き換えない。 */
  async execute(scope: TenantScope, doc: unknown): Promise<readonly McpServerConfig[]> {
    const configs = parseMcpServersDocument(scope, doc, this.now);
    await this.repo.replaceAll(scope, configs);
    return configs;
  }
}
