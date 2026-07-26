/**
 * ドメイン: MCPサーバー設定の直列化。
 *
 * 永続化アダプタはこの Serialized 型をJSON化して1列に保存する。
 * 復元は必ず createMcpServerConfig を通し、保存済みデータにも同じ不変条件を課す。
 */
import { z } from 'zod';
import { McpValidationError } from './errors';
import { createMcpServerConfig, type McpServerConfig, type McpTransportConfig } from './mcp-server';

export interface SerializedMcpServerConfig {
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly disabled: boolean;
  readonly updatedAt: string;
}

const stringRecordSchema = z.record(z.string(), z.string());
const transportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdio'), command: z.string(), args: z.array(z.string()), env: stringRecordSchema, cwd: z.string().optional() }),
  z.object({ kind: z.literal('http'), url: z.string(), headers: stringRecordSchema }),
]);
const schema = z.object({
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  name: z.string(),
  transport: transportSchema,
  disabled: z.boolean(),
  updatedAt: z.string(),
});

export function serializeMcpServerConfig(config: McpServerConfig): SerializedMcpServerConfig {
  return {
    scope: { tenantId: config.scope.tenantId, workspaceId: config.scope.workspaceId },
    name: config.name,
    transport: config.transport.kind === 'stdio'
      ? { kind: 'stdio', command: config.transport.command, args: [...config.transport.args], env: { ...config.transport.env }, ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }) }
      : { kind: 'http', url: config.transport.url, headers: { ...config.transport.headers } },
    disabled: config.disabled,
    updatedAt: config.updatedAt,
  };
}

export function deserializeMcpServerConfig(value: unknown): McpServerConfig {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new McpValidationError(`deserializeMcpServerConfig: invalid SerializedMcpServerConfig: ${issues}`);
  }
  return createMcpServerConfig(parsed.data);
}
