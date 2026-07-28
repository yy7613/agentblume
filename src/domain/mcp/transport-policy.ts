/**
 * ドメイン: トランスポート（stdio / http）に共通の受け入れポリシー。
 *
 * stdio は「起動してよいコマンドか」、http は「到達してよい宛先か」という別々の問いだが、
 * どちらも**設定で変わる運用方針**であり、`createMcpServerConfig` の不変条件とは性質が違う
 * （不変条件を厳しくすると保存済みの行が読めなくなる。ポリシーは読み出しではなく
 * 「保存」と「接続」の手前で当てる）。呼び出し側が同じ形で扱えるようここへまとめる。
 */
import { checkUrl, DEFAULT_URL_POLICY, URL_REJECTION_MESSAGE, type UrlPolicy } from '../net/url-policy';
import { assertAllowedStdioCommand, DEFAULT_MCP_COMMAND_POLICY, UNRESTRICTED_MCP_COMMAND_POLICY, type McpCommandPolicy } from './command-policy';
import { McpValidationError } from './errors';
import type { McpTransportConfig } from './mcp-server';

export interface McpPolicy {
  readonly command: McpCommandPolicy;
  readonly url: UrlPolicy;
}

/** 既定: 許可リスト方式のコマンド + ループバックのみの宛先。 */
export const DEFAULT_MCP_POLICY: McpPolicy = { command: DEFAULT_MCP_COMMAND_POLICY, url: DEFAULT_URL_POLICY };

/** 何も制限しないポリシー。既存の配線を壊さないためのテスト・埋め込み用。 */
export const UNRESTRICTED_MCP_POLICY: McpPolicy = { command: UNRESTRICTED_MCP_COMMAND_POLICY, url: { allowPrivateNetwork: true } };

/**
 * トランスポートをポリシーに照らす。違反は `McpValidationError`（api で 400）。
 *
 * 拒否の文言には**利用者が入力した値と直し方**だけを載せ、名前解決の成否や到達可否は載せない
 * （成否そのものが内部ネットワークの観測材料になる）。
 */
export function assertAllowedTransport(policy: McpPolicy, transport: McpTransportConfig): void {
  if (transport.kind === 'stdio') {
    assertAllowedStdioCommand(policy.command, transport);
    return;
  }
  const reason = checkUrl(transport.url, policy.url);
  if (reason !== undefined) throw new McpValidationError(`transport.url ${URL_REJECTION_MESSAGE[reason]}`);
}
