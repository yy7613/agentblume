/**
 * MCPクライアント設定のフォーム値 ⇔ DTO ⇔ 標準 `mcpServers` ドキュメントの相互変換（純関数）。
 *
 * UIは「フォーム」と「JSON」の2タブを等価に扱う。等価性はここの変換だけで担保するので、
 * 画面から切り離して単体テストできるようにReact非依存の関数として置く。
 *
 * 生成するドキュメントはバックエンド（domain/mcp/mcp-servers-document.ts）と同じ規約に従う:
 * name昇順・既定値（空のargs/env/headers・cwd未設定・disabled:false）はキーごと省略。
 */
import type { McpServerDto, McpTransportDto } from '../api/types';

/** 標準ドキュメント上の1サーバー分。省略キーは既定値を意味する。 */
export interface McpServersDocumentEntryDto {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly disabled?: boolean;
}
export interface McpServersDocumentDto { readonly mcpServers: Readonly<Record<string, McpServersDocumentEntryDto>> }

/** 追加/編集フォームの生の入力値（複数行入力は文字列のまま保持する）。 */
export interface McpServerFormValue {
  readonly name: string;
  readonly kind: McpTransportDto['kind'];
  readonly command: string;
  /** 1行1引数。 */
  readonly args: string;
  /** 1行1件 `KEY=VALUE`。 */
  readonly env: string;
  readonly cwd: string;
  readonly url: string;
  /** 1行1件 `Header: value`。 */
  readonly headers: string;
  readonly disabled: boolean;
}

export const EMPTY_MCP_SERVER_FORM: McpServerFormValue = {
  name: '', kind: 'stdio', command: '', args: '', env: '', cwd: '', url: '', headers: '', disabled: false,
};

/** 1行1引数のtextarea → args。空行は落とす（引数の前後空白は意味を持たないので除去する）。 */
export function parseArgLines(value: string): readonly string[] {
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}
export function formatArgLines(args: readonly string[]): string { return args.join('\n'); }

/** 1行1件 `KEY=VALUE` → env。最初の `=` で分割し、区切りが無い行・キーが空の行は無視する。 */
export function parseEnvLines(value: string): Readonly<Record<string, string>> { return parseRecordLines(value, '='); }
export function formatEnvLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env).map(([key, entry]) => `${key}=${entry}`).join('\n');
}

/** 1行1件 `Header: value` → headers。最初の `:` で分割する（値にURL等の `:` を含められる）。 */
export function parseHeaderLines(value: string): Readonly<Record<string, string>> { return parseRecordLines(value, ':'); }
export function formatHeaderLines(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers).map(([key, entry]) => `${key}: ${entry}`).join('\n');
}

function parseRecordLines(value: string, separator: string): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const index = trimmed.indexOf(separator);
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (key === '') continue;
    record[key] = trimmed.slice(index + separator.length).trim();
  }
  return record;
}

/** フォーム値 → 保存用 transport。空の cwd はキーごと省略する（サーバーが非空を要求するため）。 */
export function toMcpTransport(form: McpServerFormValue): McpTransportDto {
  if (form.kind === 'http') return { kind: 'http', url: form.url.trim(), headers: parseHeaderLines(form.headers) };
  const cwd = form.cwd.trim();
  return {
    kind: 'stdio', command: form.command.trim(), args: parseArgLines(form.args), env: parseEnvLines(form.env),
    ...(cwd === '' ? {} : { cwd }),
  };
}

/** 保存済みDTO → フォーム値（編集ボタン用）。使わない側のtransport入力は空のままにする。 */
export function toMcpServerForm(server: McpServerDto): McpServerFormValue {
  const transport = server.transport;
  return transport.kind === 'stdio'
    ? { ...EMPTY_MCP_SERVER_FORM, name: server.name, kind: 'stdio', command: transport.command, args: formatArgLines(transport.args), env: formatEnvLines(transport.env), cwd: transport.cwd ?? '', disabled: server.disabled }
    : { ...EMPTY_MCP_SERVER_FORM, name: server.name, kind: 'http', url: transport.url, headers: formatHeaderLines(transport.headers), disabled: server.disabled };
}

/** 一覧行のtransport要約。stdio は `command args...`、http は url。 */
export function transportSummary(transport: McpTransportDto): string {
  return transport.kind === 'stdio' ? [transport.command, ...transport.args].join(' ') : transport.url;
}

/** 保存済み設定列 → 標準ドキュメント。既定値キーは省略し、name昇順で並べる。 */
export function toMcpServersDocument(servers: readonly McpServerDto[]): McpServersDocumentDto {
  const mcpServers: Record<string, McpServersDocumentEntryDto> = {};
  for (const server of [...servers].sort((left, right) => left.name.localeCompare(right.name))) {
    const disabled = server.disabled ? { disabled: true } : {};
    mcpServers[server.name] = server.transport.kind === 'stdio'
      ? {
          command: server.transport.command,
          ...(server.transport.args.length === 0 ? {} : { args: [...server.transport.args] }),
          ...(Object.keys(server.transport.env).length === 0 ? {} : { env: { ...server.transport.env } }),
          ...(server.transport.cwd === undefined ? {} : { cwd: server.transport.cwd }),
          ...disabled,
        }
      : {
          url: server.transport.url,
          ...(Object.keys(server.transport.headers).length === 0 ? {} : { headers: { ...server.transport.headers } }),
          ...disabled,
        };
  }
  return { mcpServers };
}

/** JSONタブに表示する本文。 */
export function formatMcpServersDocument(servers: readonly McpServerDto[]): string {
  return JSON.stringify(toMcpServersDocument(servers), null, 2);
}

/**
 * JSONタブの本文を検証する。失敗は理由コードで返し、文言のi18nは呼び出し側（画面）が行う。
 */
export type McpServersDocumentParseResult =
  | { readonly ok: true; readonly mcpServers: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: 'invalid-json' | 'not-an-object' | 'missing-mcp-servers'; readonly detail?: string };

export function parseMcpServersDocumentText(raw: string): McpServersDocumentParseResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch (cause) { return { ok: false, reason: 'invalid-json', detail: cause instanceof Error ? cause.message : String(cause) }; }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'not-an-object' };
  const mcpServers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!isPlainObject(mcpServers)) return { ok: false, reason: 'missing-mcp-servers' };
  return { ok: true, mcpServers: mcpServers as Readonly<Record<string, unknown>> };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
