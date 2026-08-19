/**
 * ドメイン: 事実上の標準 `mcpServers` JSON との相互変換。
 *
 * Claude Desktop / Cursor 等が使う設定ファイルと**完全等価**にすることで、
 * 既存の設定をそのまま貼り付けて取り込め、書き出した内容もそのまま他所で使える。
 *
 * ```json
 * {
 *   "mcpServers": {
 *     "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
 *     "remote":     { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer x" } }
 *   }
 * }
 * ```
 *
 * 判別規則: `command` があれば stdio、`url` があれば http。**両方あるものは曖昧なのでエラー**。
 * どちらも無いものもエラー（transport を決められない）。
 */
import { z } from 'zod';
import type { TenantScope } from '../shared/tenant-scope';
import { McpValidationError } from './errors';
import { createMcpServerConfig, type McpServerConfig } from './mcp-server';

/** ドキュメント上の1サーバー分。省略キーは既定値（空配列・空オブジェクト・disabled:false）を意味する。 */
export interface McpServersDocumentEntry {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}

export interface McpServersDocument {
  readonly mcpServers: Readonly<Record<string, McpServersDocumentEntry>>;
}

const stringRecordSchema = z.record(z.string(), z.string());
const entrySchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: stringRecordSchema.optional(),
  disabled: z.boolean().optional(),
});
const documentSchema = z.object({ mcpServers: z.record(z.string(), entrySchema) });

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * 標準ドキュメントを検証済みの設定列へ変換する。
 *
 * updatedAt は now() で一律に付与する（ドキュメント側に更新時刻の概念が無いため）。
 * 出力は name 昇順に整列する。JSONオブジェクトのキー順は本来無意味であり、
 * 整列しておくと replaceAll の結果とラウンドトリップが安定する。
 */
export function parseMcpServersDocument(scope: TenantScope, doc: unknown, now: () => Date): readonly McpServerConfig[] {
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) throw new McpValidationError(`parseMcpServersDocument: invalid mcpServers document: ${issues(parsed.error)}`);
  const updatedAt = now().toISOString();
  const configs = Object.entries(parsed.data.mcpServers).map(([name, entry]) => {
    const hasCommand = entry.command !== undefined;
    const hasUrl = entry.url !== undefined;
    if (hasCommand && hasUrl) throw new McpValidationError(`parseMcpServersDocument: "${name}" must not define both command and url`);
    if (!hasCommand && !hasUrl) throw new McpValidationError(`parseMcpServersDocument: "${name}" must define either command or url`);
    return createMcpServerConfig({
      scope,
      name,
      transport: hasCommand
        ? { kind: 'stdio', command: entry.command as string, args: entry.args ?? [], env: entry.env ?? {}, ...(entry.cwd === undefined ? {} : { cwd: entry.cwd }) }
        : { kind: 'http', url: entry.url as string, headers: entry.headers ?? {} },
      disabled: entry.disabled ?? false,
      updatedAt,
    });
  });
  return configs.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 設定列を標準ドキュメントへ書き戻す。
 *
 * 既定値（空のargs/env/headers・cwd未設定・disabled:false）はキーごと省略し、
 * 人が読める最小のJSONにする。省略キーは parse 側で同じ既定値へ戻るため往復で情報は失われない。
 */
export function toMcpServersDocument(configs: readonly McpServerConfig[]): McpServersDocument {
  const mcpServers: Record<string, McpServersDocumentEntry> = {};
  for (const config of [...configs].sort((left, right) => left.name.localeCompare(right.name))) {
    const disabled = config.disabled ? { disabled: true } : {};
    mcpServers[config.name] = config.transport.kind === 'stdio'
      ? {
          command: config.transport.command,
          ...(config.transport.args.length === 0 ? {} : { args: [...config.transport.args] }),
          ...(Object.keys(config.transport.env).length === 0 ? {} : { env: { ...config.transport.env } }),
          ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }),
          ...disabled,
        }
      : {
          url: config.transport.url,
          ...(Object.keys(config.transport.headers).length === 0 ? {} : { headers: { ...config.transport.headers } }),
          ...disabled,
        };
  }
  return { mcpServers };
}
