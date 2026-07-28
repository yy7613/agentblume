/**
 * ドメイン: MCPサーバー設定の直列化。
 *
 * 永続化アダプタはこの Serialized 型をJSON化して1列に保存する。
 * 復元は必ず createMcpServerConfig を通し、保存済みデータにも同じ不変条件を課す。
 *
 * ## 保存形（Stored）と平文形（Serialized）を分ける理由
 *
 * `env` / `headers` の値は資格情報なので、**DBには封緘して置く**（`SealedSecret`）。
 * つまりディスク上の形は「値が文字列」ではなく「値が文字列 or SealedSecret」になる。
 * 封緘・開封は鍵を持つ adapters の仕事なので、ここでは**形の定義と検証**だけを持ち、
 * 暗号そのものには触れない（domain は鍵も平文も知らない）。
 *
 * `StoredSecretValue` が文字列も許すのは**移行のため**である。v35〜v36 の間に平文で
 * 保存された行がそのまま残っているので、読み出しでは平文を受け入れ（そのまま使い）、
 * 次に保存されたときに封緘し直す。DBマイグレーションは不要で、行は使われた順に直っていく。
 */
import { z } from 'zod';
import { createSealedSecret, type SealedSecret } from '../model-settings/sealed-secret';
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

/* ------------------------------------------------------------------ *
 * 保存形（封緘済み・移行のため平文も許す）
 * ------------------------------------------------------------------ */

/** DB上の秘密値。`SealedSecret` が正、`string` は v36 以前に保存された平文（読むだけ）。 */
export type StoredSecretValue = string | SealedSecret;

export type StoredMcpTransport =
  | { readonly kind: 'stdio'; readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, StoredSecretValue>>; readonly cwd?: string }
  | { readonly kind: 'http'; readonly url: string; readonly headers: Readonly<Record<string, StoredSecretValue>> };

export interface StoredMcpServerConfig {
  readonly scope: { readonly tenantId: string; readonly workspaceId: string };
  readonly name: string;
  readonly transport: StoredMcpTransport;
  readonly disabled: boolean;
  readonly updatedAt: string;
}

const sealedSecretSchema = z.object({
  v: z.literal(1),
  alg: z.literal('aes-256-gcm'),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
  hint: z.string(),
});
const storedSecretSchema = z.union([z.string(), sealedSecretSchema]);
const storedRecordSchema = z.record(z.string(), storedSecretSchema);
const storedTransportSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stdio'), command: z.string(), args: z.array(z.string()), env: storedRecordSchema, cwd: z.string().optional() }),
  z.object({ kind: z.literal('http'), url: z.string(), headers: storedRecordSchema }),
]);
const storedSchema = z.object({
  scope: z.object({ tenantId: z.string(), workspaceId: z.string() }),
  name: z.string(),
  transport: storedTransportSchema,
  disabled: z.boolean(),
  updatedAt: z.string(),
});

/** 値が封緘済みか（旧データの平文と区別する）。 */
export function isStoredSealed(value: StoredSecretValue): value is SealedSecret {
  return typeof value !== 'string';
}

/** DBから読んだJSONを保存形として検証する（開封はしない）。 */
export function parseStoredMcpServerConfig(value: unknown): StoredMcpServerConfig {
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new McpValidationError(`parseStoredMcpServerConfig: invalid StoredMcpServerConfig: ${issues}`);
  }
  // 封緘値は形をもう一度ドメインの検証（base64 等）へ通す。
  const transport = parsed.data.transport;
  const record = transport.kind === 'stdio' ? transport.env : transport.headers;
  for (const value_ of Object.values(record)) {
    if (typeof value_ !== 'string') createSealedSecret(value_);
  }
  return parsed.data as StoredMcpServerConfig;
}

/**
 * 開封済みの値から `McpServerConfig` を組み立てる。
 * 秘密以外の項目は保存形をそのまま使い、`env` / `headers` だけ差し替える。
 */
export function toMcpServerConfig(stored: StoredMcpServerConfig, secrets: Readonly<Record<string, string>>): McpServerConfig {
  return createMcpServerConfig({
    scope: stored.scope,
    name: stored.name,
    transport: stored.transport.kind === 'stdio'
      ? { kind: 'stdio', command: stored.transport.command, args: [...stored.transport.args], env: { ...secrets }, ...(stored.transport.cwd === undefined ? {} : { cwd: stored.transport.cwd }) }
      : { kind: 'http', url: stored.transport.url, headers: { ...secrets } },
    disabled: stored.disabled,
    updatedAt: stored.updatedAt,
  });
}

/** 保存形の秘密値レコードを取り出す（stdio は env、http は headers）。 */
export function storedSecrets(stored: StoredMcpServerConfig): Readonly<Record<string, StoredSecretValue>> {
  return stored.transport.kind === 'stdio' ? stored.transport.env : stored.transport.headers;
}

/** 封緘済みの値から保存形を組み立てる。 */
export function toStoredMcpServerConfig(config: McpServerConfig, sealed: Readonly<Record<string, SealedSecret>>): StoredMcpServerConfig {
  return {
    scope: { tenantId: config.scope.tenantId, workspaceId: config.scope.workspaceId },
    name: config.name,
    transport: config.transport.kind === 'stdio'
      ? { kind: 'stdio', command: config.transport.command, args: [...config.transport.args], env: { ...sealed }, ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }) }
      : { kind: 'http', url: config.transport.url, headers: { ...sealed } },
    disabled: config.disabled,
    updatedAt: config.updatedAt,
  };
}
