/**
 * ドメイン: 外部MCPサーバーへの接続設定。
 *
 * 設定モデルは事実上の標準である `mcpServers` JSON（Claude Desktop 等）と等価にする
 * （相互変換は mcp-servers-document.ts）。name は同一スコープ内での一意キーであり、
 * ツール名の前置修飾子としても使われるため、識別子として安全な文字種に限定する。
 */
import type { TenantScope } from '../tool/ids';
import { McpValidationError } from './errors';

/** stdio（子プロセス）または streamable-http のいずれか。 */
export type McpTransportConfig =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly kind: 'http'; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export interface McpServerConfig {
  readonly scope: TenantScope;
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly disabled: boolean;
  readonly updatedAt: string;
}

export interface CreateMcpServerConfigProps {
  readonly scope: TenantScope;
  readonly name: string;
  readonly transport: McpTransportConfig;
  readonly disabled?: boolean;
  readonly updatedAt: string;
}

/** name の最大長。ツール名の前置修飾子として使うため短く抑える。 */
export const MCP_SERVER_NAME_MAX_LENGTH = 64;
/** 先頭は英数字。以降は英数字と `_ . -` のみ（シェル・ツール名双方で安全な文字種）。 */
export const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new McpValidationError(`createMcpServerConfig: ${field} must be a non-empty string`);
}

/** 文字列レコード（env / headers）を検証しつつ複製する。キー空文字は設定ミスなので弾く。 */
function stringRecord(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpValidationError(`createMcpServerConfig: ${field} must be an object`);
  const copy: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.trim() === '') throw new McpValidationError(`createMcpServerConfig: ${field} keys must be non-empty`);
    if (typeof entry !== 'string') throw new McpValidationError(`createMcpServerConfig: ${field}.${key} must be a string`);
    copy[key] = entry;
  }
  return copy;
}

/**
 * URLの**不変条件**だけを課す（http(s)であること・資格情報を埋め込まないこと）。
 *
 * 宛先の到達範囲（private/link-local の可否）は設定で変わるポリシーなのでここには置かない。
 * ここへ入れてしまうと、ポリシーを締めた瞬間に**保存済みの行が読めなくなる**（`list()` が投げる）。
 * ポリシー検査は保存時（use case）と接続直前（adapters）で行う。
 */
function httpUrl(value: unknown, field: string): string {
  nonEmpty(value, field);
  const raw = value.trim();
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { throw new McpValidationError(`createMcpServerConfig: ${field} must be a valid URL: ${raw}`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new McpValidationError(`createMcpServerConfig: ${field} must use http(s): ${raw}`);
  // URLは封緘対象外でDB・ログ・API応答に平文で残る。そこへ秘密を書かせない（モデル設定の baseUrl と同じ規約）。
  if (parsed.username !== '' || parsed.password !== '') {
    throw new McpValidationError(`createMcpServerConfig: ${field} must not embed credentials (user:password@host)`);
  }
  return raw;
}

function validateTransport(value: McpTransportConfig): McpTransportConfig {
  if (value === null || typeof value !== 'object') throw new McpValidationError('createMcpServerConfig: transport is required');
  if (value.kind === 'stdio') {
    nonEmpty(value.command, 'transport.command');
    const args = value.args ?? [];
    if (!Array.isArray(args)) throw new McpValidationError('createMcpServerConfig: transport.args must be an array');
    for (const [index, arg] of args.entries()) {
      if (typeof arg !== 'string') throw new McpValidationError(`createMcpServerConfig: transport.args.${index} must be a string`);
    }
    if (value.cwd !== undefined) nonEmpty(value.cwd, 'transport.cwd');
    return {
      kind: 'stdio', command: value.command.trim(), args: [...args], env: stringRecord(value.env, 'transport.env'),
      ...(value.cwd === undefined ? {} : { cwd: value.cwd.trim() }),
    };
  }
  if (value.kind === 'http') {
    return { kind: 'http', url: httpUrl(value.url, 'transport.url'), headers: stringRecord(value.headers, 'transport.headers') };
  }
  throw new McpValidationError(`createMcpServerConfig: invalid transport.kind: ${String((value as { kind?: unknown }).kind)}`);
}

/** 検証済みのMCPサーバー設定を生成する（入力は複製し、呼び出し側の変更から隔離する）。 */
export function createMcpServerConfig(props: CreateMcpServerConfigProps): McpServerConfig {
  if (props === null || typeof props !== 'object') throw new McpValidationError('createMcpServerConfig: props is required');
  nonEmpty(props.scope?.tenantId, 'scope.tenantId');
  nonEmpty(props.scope.workspaceId, 'scope.workspaceId');
  nonEmpty(props.name, 'name');
  const name = props.name.trim();
  if (name.length > MCP_SERVER_NAME_MAX_LENGTH) throw new McpValidationError(`createMcpServerConfig: name must be at most ${MCP_SERVER_NAME_MAX_LENGTH} characters: ${name}`);
  if (!MCP_SERVER_NAME_PATTERN.test(name)) throw new McpValidationError(`createMcpServerConfig: invalid name: ${name}`);
  nonEmpty(props.updatedAt, 'updatedAt');
  if (props.disabled !== undefined && typeof props.disabled !== 'boolean') throw new McpValidationError('createMcpServerConfig: disabled must be a boolean');
  return {
    scope: { tenantId: props.scope.tenantId, workspaceId: props.scope.workspaceId },
    name,
    transport: validateTransport(props.transport),
    disabled: props.disabled ?? false,
    updatedAt: props.updatedAt,
  };
}
