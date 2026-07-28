/**
 * adapters層: @modelcontextprotocol/sdk による McpClientPort 実装（SDK 1.29.0）。
 *
 * 接続は「サーバー名＋設定ハッシュ」でプールして再利用する。MCPのstdioサーバーは
 * 起動に数百ms〜数秒かかるため、ツール呼び出しのたびにプロセスを立ち上げ直すと実用にならない。
 * 設定が変わった（ハッシュ不一致）ときだけ旧接続を捨てて張り直す。
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { McpClientError, type McpClientPort, type McpToolCallResult, type McpToolDescriptor } from '../../application/mcp/mcp-client';
import type { JsonObject } from '../../application/model/model-provider';
import type { McpServerConfig } from '../../domain/mcp/mcp-server';
import { assertAllowedTransport, DEFAULT_MCP_POLICY, type McpPolicy } from '../../domain/mcp/transport-policy';
import { checkHost, URL_REJECTION_MESSAGE } from '../../domain/net/url-policy';

/** 1リクエストの上限。ツール実行が長引くケースを考えても30秒あれば十分で、無反応の検知にもなる。 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** アイドル接続の寿命。子プロセスを無期限に抱えないための上限。 */
const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
/** ツール結果テキストの上限（64KiB）。モデルのcontextを1回の結果で食い潰さないため。 */
const MAX_CONTENT_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = '\n…[truncated]';

export type McpTransportFactory = (config: McpServerConfig) => Transport;

/** ホスト名 → IPアドレス列。DNS再検査の差し替え口（既定は `node:dns` の `lookup`）。 */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export interface SdkMcpClientOptions {
  /** テスト用にトランスポート生成を差し替える（既定は stdio / streamable-http の実接続）。 */
  readonly createTransport?: McpTransportFactory;
  /**
   * 起動を許すコマンド・到達を許す宛先。**接続直前に必ず当てる**。
   *
   * 保存時（use case）にも同じ検査をしているが、そちらは入力の即時フィードバックが目的で、
   * ポリシー導入前に保存された行やポリシーを緩めてから戻した環境では素通りする。
   * 実際にプロセスを起こす・ソケットを開くのはここなので、ここが最後の防壁になる。
   */
  readonly policy?: McpPolicy;
  /**
   * ホスト名の解決結果を再検査するためのリゾルバ。
   *
   * 明示指定するか、既定のトランスポート（＝実接続）を使うときだけDNS再検査が走る。
   * `createTransport` を差し替えているテスト・埋め込みでは実際の通信が起きないため、
   * 名前解決だけを走らせても意味が無く、オフラインで不安定になるだけである。
   */
  readonly resolveHost?: HostResolver;
  readonly requestTimeoutMs?: number;
  readonly idleTtlMs?: number;
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
}

/** 既定のリゾルバ。IPv4/IPv6 の**全アドレス**を見る（1つでも内部なら拒否するため）。 */
async function defaultResolveHost(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
}

/**
 * ホスト名が私設・リンクローカルへ解決されないことを確かめる（DNSリバインディング対策）。
 *
 * IPリテラルは純関数側（`checkUrl`）で既に判定済みなので、ここは名前のときだけ意味を持つ。
 * **解決できない場合は拒否する**。「解決できなかったから素通し」にすると、検査を回避する手段に
 * なってしまう（接続自体はどうせ失敗するので、拒否しても正常系は失われない）。
 */
export async function assertResolvedHostAllowed(url: string, policy: McpPolicy, resolve: HostResolver): Promise<void> {
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  let addresses: readonly string[];
  try { addresses = await resolve(hostname); }
  catch { throw new McpClientError(`transport.url host could not be resolved: ${hostname}`); }
  for (const address of addresses) {
    const reason = checkHost(address, policy.url);
    // 解決先のアドレスは載せない（内部のアドレス割り当てを教える材料になる）。
    if (reason !== undefined) throw new McpClientError(`transport.url ${URL_REJECTION_MESSAGE[reason]}`);
  }
}

interface PoolEntry {
  readonly client: Client;
  readonly hash: string;
  lastUsedAt: number;
}

function poolKey(config: McpServerConfig): string {
  return `${config.scope.tenantId}/${config.scope.workspaceId}/${config.name}`;
}

/** 設定の同一性判定。transportの中身が1つでも変われば別接続として扱う。 */
function configHash(config: McpServerConfig): string {
  const transport = config.transport.kind === 'stdio'
    ? { kind: 'stdio', command: config.transport.command, args: [...config.transport.args], env: sortedEntries(config.transport.env), cwd: config.transport.cwd ?? null }
    : { kind: 'http', url: config.transport.url, headers: sortedEntries(config.transport.headers) };
  return createHash('sha256').update(JSON.stringify(transport)).digest('hex');
}

function sortedEntries(record: Readonly<Record<string, string>>): readonly (readonly [string, string])[] {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

/**
 * 認証情報（env / headers の値）が外へ漏れないよう伏せ字化する。
 * 子プロセスやHTTPサーバーの生エラーが値をそのまま含めてくることがあるため、
 * エラーメッセージは必ずこれを通してから外へ出す。
 */
function redactSecrets(config: McpServerConfig, message: string): string {
  const secrets = config.transport.kind === 'stdio' ? Object.values(config.transport.env) : Object.values(config.transport.headers);
  let redacted = message;
  for (const secret of secrets) {
    // 短すぎる値（'1' 等）は伏せると本文が壊れるだけなので対象外。
    if (secret.length >= 4) redacted = redacted.split(secret).join('***');
  }
  return redacted;
}

/** MCPのcontentブロック配列を1本のテキストへ平坦化する。非textはプレースホルダにする。 */
function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    const item = block as { type?: unknown; text?: unknown };
    if (item.type === 'text' && typeof item.text === 'string') return item.text;
    return `[${typeof item.type === 'string' ? item.type : 'unknown'}]`;
  }).join('\n');
}

function clip(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= MAX_CONTENT_BYTES) return value;
  return `${buffer.subarray(0, MAX_CONTENT_BYTES).toString('utf8')}${TRUNCATION_NOTICE}`;
}

/**
 * 既定のトランスポート生成。
 *
 * - stdio: SDK推奨に従い getDefaultEnvironment()（PATH等の安全な変数のみ）へ設定envを重ねる。
 *   PATH を引き継がないと `npx` / `uvx` の解決に失敗するため、設定envだけを渡すのは不可。
 *   **Windowsで `npx` 系を使う場合は `cmd /c npx ...` のようなラッパーが必要になることがある**
 *   （`npx.cmd` はシェル経由でしか起動できない）。これは設定側（command/args）の責務であり、
 *   ここでコマンドを書き換えることはしない（利用者の設定を勝手に解釈しない）。
 * - http: v1は streamable-http のみ対応。旧SSE方式（/sse エンドポイント）は非対応。
 */
function defaultTransport(config: McpServerConfig): Transport {
  if (config.transport.kind === 'stdio') {
    return new StdioClientTransport({
      command: config.transport.command,
      args: [...config.transport.args],
      env: { ...getDefaultEnvironment(), ...config.transport.env },
      ...(config.transport.cwd === undefined ? {} : { cwd: config.transport.cwd }),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.transport.url), { requestInit: { headers: { ...config.transport.headers } } });
}

export class SdkMcpClient implements McpClientPort {
  private readonly pool = new Map<string, PoolEntry>();
  private readonly createTransport: McpTransportFactory;
  private readonly policy: McpPolicy;
  private readonly resolveHost: HostResolver | undefined;
  private readonly requestTimeoutMs: number;
  private readonly idleTtlMs: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(options: SdkMcpClientOptions = {}) {
    this.createTransport = options.createTransport ?? defaultTransport;
    this.policy = options.policy ?? DEFAULT_MCP_POLICY;
    // 実接続する構成（既定トランスポート）か、明示指定があるときだけDNS再検査を行う。
    this.resolveHost = options.resolveHost ?? (options.createTransport === undefined ? defaultResolveHost : undefined);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.sweepIntervalMs = options.sweepIntervalMs ?? Math.max(1_000, Math.floor(this.idleTtlMs / 5));
    this.now = options.now ?? (() => Date.now());
  }

  async listTools(config: McpServerConfig, signal?: AbortSignal): Promise<readonly McpToolDescriptor[]> {
    const client = await this.acquire(config);
    try {
      const result = await client.listTools({}, this.requestOptions(signal));
      return result.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as JsonObject,
      }));
    } catch (cause) {
      await this.evict(config);
      throw this.wrap(config, 'listTools', cause);
    }
  }

  async callTool(config: McpServerConfig, toolName: string, args: JsonObject, signal?: AbortSignal): Promise<McpToolCallResult> {
    const client = await this.acquire(config);
    try {
      const result = await client.callTool({ name: toolName, arguments: args as Record<string, unknown> }, undefined, this.requestOptions(signal));
      // ツール自身の実行エラーは例外ではなく isError で返る（モデルへ結果として渡すため）。
      return { content: clip(flattenContent(result.content)), isError: result.isError === true };
    } catch (cause) {
      await this.evict(config);
      throw this.wrap(config, `callTool ${toolName}`, cause);
    }
  }

  async close(): Promise<void> {
    this.stopSweeper();
    const entries = [...this.pool.values()];
    this.pool.clear();
    await Promise.all(entries.map((entry) => closeQuietly(entry.client)));
  }

  /** プール済み接続を返す。設定が変わっていたら旧接続を閉じて張り直す。 */
  private async acquire(config: McpServerConfig): Promise<Client> {
    const key = poolKey(config);
    const hash = configHash(config);
    const existing = this.pool.get(key);
    if (existing !== undefined) {
      if (existing.hash === hash) {
        existing.lastUsedAt = this.now();
        return existing.client;
      }
      this.pool.delete(key);
      await closeQuietly(existing.client);
    }

    // プロセスを起こす・ソケットを開く直前の最終検査。プールの前に置くと、
    // ポリシー違反の設定でも一度確立した接続が再利用されてしまう。
    await this.assertAllowed(config);

    const client = new Client({ name: 'agentblume', version: '0.1.0' }, { capabilities: {} });
    let transport: Transport;
    try { transport = this.createTransport(config); }
    catch (cause) { throw this.wrap(config, 'connect', cause); }
    try {
      await client.connect(transport, { timeout: this.requestTimeoutMs });
    } catch (cause) {
      await closeQuietly(client);
      throw this.wrap(config, 'connect', cause);
    }
    this.pool.set(key, { client, hash, lastUsedAt: this.now() });
    this.ensureSweeper();
    return client;
  }

  /**
   * ポリシー違反を `McpClientError` として拒否する。
   *
   * ドメイン側の判定は `McpValidationError` だが、ここは「接続できなかった」経路なので
   * 接続テスト（`ok:false`）・Agent実行の失敗として扱われるように統一する。
   */
  private async assertAllowed(config: McpServerConfig): Promise<void> {
    try { assertAllowedTransport(this.policy, config.transport); }
    catch (cause) { throw new McpClientError(`MCP server "${config.name}" is not allowed to start: ${cause instanceof Error ? cause.message : String(cause)}`); }
    if (config.transport.kind !== 'http' || this.resolveHost === undefined) return;
    await assertResolvedHostAllowed(config.transport.url, this.policy, this.resolveHost);
  }

  private async evict(config: McpServerConfig): Promise<void> {
    const key = poolKey(config);
    const entry = this.pool.get(key);
    if (entry === undefined) return;
    this.pool.delete(key);
    await closeQuietly(entry.client);
    if (this.pool.size === 0) this.stopSweeper();
  }

  private requestOptions(signal?: AbortSignal): RequestOptions {
    return { timeout: this.requestTimeoutMs, ...(signal === undefined ? {} : { signal }) };
  }

  private wrap(config: McpServerConfig, operation: string, cause: unknown): McpClientError {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return new McpClientError(`MCP server "${config.name}" ${operation} failed: ${redactSecrets(config, reason)}`);
  }

  /** アイドル接続の掃除。タイマーは unref してプロセス終了を妨げない。 */
  private ensureSweeper(): void {
    if (this.sweeper !== undefined) return;
    const timer = setInterval(() => { void this.sweep(); }, this.sweepIntervalMs);
    timer.unref?.();
    this.sweeper = timer;
  }

  private stopSweeper(): void {
    if (this.sweeper === undefined) return;
    clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  /** テスト・運用から明示的に呼べるようpublicにする（通常はタイマーが駆動する）。 */
  async sweep(): Promise<void> {
    const deadline = this.now() - this.idleTtlMs;
    const expired = [...this.pool.entries()].filter(([, entry]) => entry.lastUsedAt <= deadline);
    for (const [key] of expired) this.pool.delete(key);
    await Promise.all(expired.map(([, entry]) => closeQuietly(entry.client)));
    if (this.pool.size === 0) this.stopSweeper();
  }

  /** 現在プールしている接続数（テスト・診断用）。 */
  get pooledConnections(): number { return this.pool.size; }
}

/** 後始末の失敗で元のエラーを覆い隠さない。 */
async function closeQuietly(client: Client): Promise<void> {
  try { await client.close(); } catch { /* 既に切れている接続のcloseは無視する */ }
}
