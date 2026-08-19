/**
 * application層: MCPサーバー設定のCRUD。
 *
 * 設定は版を持たず (scope, name) で upsert する。ReplaceMcpServers は
 * 標準 `mcpServers` ドキュメントをそのまま受け、スコープ内を丸ごと置き換える（JSONタブのApply）。
 *
 * ## 秘密値（env / headers）の扱い
 *
 * **戻り値は必ずマスク済みビュー**（`MaskedMcpServerView`）にする。平文の `McpServerConfig` を
 * 返す口をここに残すと、api層が何気なくそれを返した瞬間に `Authorization: Bearer ...` が
 * 応答へ出る（v35〜v36 の `GET /mcp-servers` が実際にそうなっていた）。
 * 平文が要るのは接続する側（`TestMcpServerUseCase` / Agent実行）だけで、そちらは
 * リポジトリから直接取る。
 *
 * 保存入力の `***` は「保存済みの値を維持」を意味する（`domain/mcp/secret-masking.ts`）。
 *
 * ## ポリシー検査
 *
 * 起動してよいコマンド・到達してよい宛先の検査は**保存時にも**行う（入力した直後に
 * 400 で理由が分かるほうが親切）。ただしこれは第一の防壁ではない。ポリシー導入前に
 * 保存された行があるので、実際に守るのは接続直前の検査（adapters）である。
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { McpNotFoundError } from '../../domain/mcp/errors';
import { createMcpServerConfig, type McpServerConfig, type McpTransportConfig } from '../../domain/mcp/mcp-server';
import type { McpServerRepository } from '../../domain/mcp/mcp-server-repository';
import { parseMcpServersDocument } from '../../domain/mcp/mcp-servers-document';
import { maskMcpServerConfig, resolveMaskedTransport, type MaskedMcpServerView } from '../../domain/mcp/secret-masking';
import { assertAllowedTransport, DEFAULT_MCP_POLICY, type McpPolicy } from '../../domain/mcp/transport-policy';

export interface SaveMcpServerInput {
  readonly scope: TenantScope;
  readonly server: {
    readonly name: string;
    readonly transport: McpTransportConfig;
    readonly disabled?: boolean;
  };
}

export class SaveMcpServerUseCase {
  constructor(
    private readonly repo: McpServerRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: McpPolicy = DEFAULT_MCP_POLICY,
  ) {}

  async execute(input: SaveMcpServerInput): Promise<MaskedMcpServerView> {
    const updatedAt = this.now().toISOString();
    // 先に一度通して name / transport を正規化する（`find` は正規化後の name で引く必要がある）。
    const draft = createMcpServerConfig({
      scope: input.scope,
      name: input.server.name,
      transport: input.server.transport,
      disabled: input.server.disabled ?? false,
      updatedAt,
    });
    const existing = await this.repo.find(input.scope, draft.name);
    const transport = resolveMaskedTransport(draft.transport, existing?.transport);
    assertAllowedTransport(this.policy, transport);
    const config = createMcpServerConfig({ scope: draft.scope, name: draft.name, transport, disabled: draft.disabled, updatedAt });
    await this.repo.save(config);
    return maskMcpServerConfig(config);
  }
}

export class ListMcpServersUseCase {
  constructor(private readonly repo: McpServerRepository) {}
  async execute(scope: TenantScope): Promise<readonly MaskedMcpServerView[]> {
    return (await this.repo.list(scope)).map(maskMcpServerConfig);
  }
}

export class DeleteMcpServerUseCase {
  constructor(private readonly repo: McpServerRepository) {}
  async execute(scope: TenantScope, name: string): Promise<void> {
    const existed = await this.repo.delete(scope, name);
    if (!existed) throw new McpNotFoundError(`MCP server not found: ${name}`);
  }
}

export class ReplaceMcpServersUseCase {
  constructor(
    private readonly repo: McpServerRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: McpPolicy = DEFAULT_MCP_POLICY,
  ) {}

  /**
   * doc は `{ mcpServers: { ... } }` 形式。検証に失敗した場合は何も置き換えない
   * （マスクの解決・ポリシー検査も含めて全件済ませてから `replaceAll` を呼ぶ）。
   */
  async execute(scope: TenantScope, doc: unknown): Promise<readonly MaskedMcpServerView[]> {
    const parsed = parseMcpServersDocument(scope, doc, this.now);
    const existing = new Map((await this.repo.list(scope)).map((config) => [config.name, config] as const));
    const configs: McpServerConfig[] = [];
    for (const draft of parsed) {
      const transport = resolveMaskedTransport(draft.transport, existing.get(draft.name)?.transport);
      assertAllowedTransport(this.policy, transport);
      configs.push(createMcpServerConfig({ scope: draft.scope, name: draft.name, transport, disabled: draft.disabled, updatedAt: draft.updatedAt }));
    }
    await this.repo.replaceAll(scope, configs);
    return configs.map(maskMcpServerConfig);
  }
}
