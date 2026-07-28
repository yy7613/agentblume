/**
 * ドメイン: MCPサーバー設定の秘密値（stdio の `env` / http の `headers`）のマスクと復元。
 *
 * ## なぜ必要か
 *
 * `env` には `GITHUB_TOKEN=...`、`headers` には `Authorization: Bearer ...` が入る。
 * これらは v35 以来**平文でDBに入り、`GET /mcp-servers` が平文のまま返していた**。
 * モデル設定のAPIキーは v36 で封緘済みなので、MCPだけが非対称に取り残されていた。
 *
 * ## 方式（案A: マスク往復。モデル設定の write-only 方式と同じ流儀）
 *
 * - 応答では**値だけ**を `***` に置き換える。**キーは残す**（どの変数を設定したかは
 *   秘密ではなく、UIとJSONタブに必要な情報）。
 * - 保存時、値が `***` ちょうどのものは「変更しない」と解釈し、保存済みの値を引き継ぐ。
 *   それ以外の値は新しい平文として封緘し直す。
 * - **引き継ぎ元が無い `***` は拒否する**（`McpValidationError` → 400）。
 *   ここを黙って通すと、リテラル `"***"` が本物の資格情報として保存され、
 *   接続が失敗する理由が誰にも分からなくなる（沈黙のデータ破壊）。
 *
 * ## JSONタブ（標準 `mcpServers` ドキュメント）との両立
 *
 * v35 が保証したのは「往復で**設定が**失われない」ことである。マスク往復はこれを保つ:
 * 表示 → 無編集で適用、を繰り返しても保存済みの値は一切変わらない。
 * 失うのは「書き出したドキュメントを他所（Claude Desktop 等）へそのまま持って行ける」
 * という性質だけで、これは秘密をDBから消す以上どうやっても両立しない。
 * ドキュメントの**形**は標準のまま（追加キーを持ち込まない）なので、貼り付けての取り込みは従来どおり動く。
 *
 * 既知の割り切り: 実際の値が `***` ちょうどである資格情報は「変更しない」と解釈される。
 */
import { McpValidationError } from './errors';
import type { McpServerConfig, McpTransportConfig } from './mcp-server';

/** 応答で秘密値の代わりに出す印。保存時は「既存の値を維持する」という意味になる。 */
export const MCP_SECRET_MASK = '***';

export type MaskedMcpTransport =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly cwd?: string }
  | { readonly kind: 'http'; readonly url: string; readonly headers: Readonly<Record<string, string>> };

/**
 * API応答用の設定ビュー。形は `SerializedMcpServerConfig` と同じだが、
 * **env / headers の値は必ずマスク済み**であることを型として区別する
 * （`McpServerConfig` と同じ型にすると、マスク済みの値をそのまま接続に使う事故が起きうる）。
 */
export interface MaskedMcpServerView {
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly name: string;
  readonly transport: MaskedMcpTransport;
  readonly disabled: boolean;
  readonly updatedAt: string;
}

/** 値が「維持せよ」の印か。 */
export function isMaskedSecret(value: string): boolean { return value === MCP_SECRET_MASK; }

/** 値をすべてマスクした複製。キーの集合と順序は保つ。 */
export function maskRecord(record: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const masked: Record<string, string> = {};
  for (const key of Object.keys(record)) masked[key] = MCP_SECRET_MASK;
  return masked;
}

/** 設定をAPI応答用のマスク済みビューへ写す。 */
export function maskMcpServerConfig(config: McpServerConfig): MaskedMcpServerView {
  return {
    scope: { tenantId: config.scope.tenantId, workspaceId: config.scope.workspaceId },
    name: config.name,
    transport: config.transport.kind === 'stdio'
      ? {
          kind: 'stdio', command: config.transport.command, args: [...config.transport.args], env: maskRecord(config.transport.env),
          ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }),
        }
      : { kind: 'http', url: config.transport.url, headers: maskRecord(config.transport.headers) },
    disabled: config.disabled,
    updatedAt: config.updatedAt,
  };
}

/**
 * 受け取ったレコードのマスク値を、保存済みの値で埋め戻す。
 *
 * `label` はエラーメッセージ用のフィールド名（`transport.env` 等）。
 * 引き継ぎ元が無いマスク値は、どの値を保存すべきか決められないので拒否する。
 */
export function resolveMaskedRecord(
  incoming: Readonly<Record<string, string>>,
  existing: Readonly<Record<string, string>> | undefined,
  label: string,
): Readonly<Record<string, string>> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!isMaskedSecret(value)) { resolved[key] = value; continue; }
    const previous = existing?.[key];
    if (previous === undefined) {
      throw new McpValidationError(
        `${label}.${key} is "${MCP_SECRET_MASK}" but there is no stored value to keep. Enter the real value (saved secrets are shown masked).`,
      );
    }
    resolved[key] = previous;
  }
  return resolved;
}

/**
 * transport のマスク値を保存済みの設定で埋め戻す。
 * transport の種類が変わった場合は引き継ぎ元が無い（＝マスクは拒否される）。
 */
export function resolveMaskedTransport(incoming: McpTransportConfig, existing: McpTransportConfig | undefined): McpTransportConfig {
  if (incoming.kind === 'stdio') {
    const previous = existing?.kind === 'stdio' ? existing.env : undefined;
    return { ...incoming, args: [...incoming.args], env: resolveMaskedRecord(incoming.env, previous, 'transport.env') };
  }
  const previous = existing?.kind === 'http' ? existing.headers : undefined;
  return { ...incoming, headers: resolveMaskedRecord(incoming.headers, previous, 'transport.headers') };
}
