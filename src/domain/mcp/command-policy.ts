/**
 * ドメイン: stdio トランスポートで起動してよいコマンドの判定（純関数）。
 *
 * MCPのstdioサーバーは**子プロセスの起動**である。設定を保存できる利用者は、そのまま
 * 任意のコマンドをサーバーホスト上で実行できてしまう（`POST /mcp-servers/:name/test` は
 * Agent実行を伴わず即プロセスを起動する）。認証が入っても「トークンを持つ利用者＝RCE」
 * のままなので、**起動してよいコマンドを許可リストで縛る**。
 *
 * ## 判定の粒度
 *
 * 比較は**ベース名**で行う（`/usr/local/bin/node` も `C:\Program Files\nodejs\node.exe` も
 * `node` として一致する）。絶対パスまで一致を求めると環境ごとに設定が壊れるうえ、
 * 保護の強さは変わらない（同名の実行ファイルを置ける利用者は既に何でもできる）。
 *
 * ## シェルラッパーの扱い
 *
 * `cmd` は既定で許可する。Windows では `npx.cmd` をシェル経由でしか起動できず、
 * `command: "cmd", args: ["/c", "npx", ...]` が**公式に案内している設定**だからである
 * （`adapters/mcp/sdk-mcp-client.ts` のコメント・UIのヒント文）。
 * しかし `cmd /c calc` が通るなら許可リストの意味が無いので、シェルラッパーについては
 * **`/c` の次のトークン（実際に起動されるコマンド）も許可リストで検査**する。
 * これで `cmd /c npx ...` は通り、`cmd /c whoami` は落ちる。
 */
import { McpValidationError } from './errors';

/**
 * `AGENTCONTEXT_MCP_ALLOWED_COMMANDS` 未設定時に許可するコマンド。
 *
 * MCPサーバーの起動系として実際に使われるものだけを入れる。`sh` / `bash` / `pwsh` /
 * `powershell` は**入れない**（`-c "任意のスクリプト"` が主な使い方で、下のトークン検査でも
 * 実質的に守れないため）。必要な環境は env で明示的に足す。
 */
export const DEFAULT_MCP_ALLOWED_COMMANDS: readonly string[] = [
  'npx', 'node', 'uvx', 'uv', 'python', 'python3', 'bunx', 'bun', 'deno', 'docker', 'cmd',
];

/** シェルラッパー → 「次のトークンがコマンド」を意味するスイッチ。 */
const SHELL_WRAPPERS: ReadonlyMap<string, readonly string[]> = new Map([
  ['cmd', ['/c', '/k']],
  ['sh', ['-c']],
  ['bash', ['-c']],
  ['zsh', ['-c']],
  ['pwsh', ['-c', '-command']],
  ['powershell', ['-c', '-command']],
]);

/** 実行ファイル名として剥がしてよい拡張子（Windows）。 */
const EXECUTABLE_SUFFIXES = ['.exe', '.cmd', '.bat', '.com', '.ps1'] as const;

/**
 * **コマンドの連鎖・置換**を可能にする文字だけを禁止する。
 *
 * 括弧・引用符・グロブまで弾くと `C:\Program Files (x86)\...` のような正当なパスが通らなくなる。
 * 守りたいのは「1つの設定から別のコマンドが走る」ことなので、区切り・リダイレクト・
 * コマンド置換に絞る。直接spawnする経路では元々不活性で、効くのは `cmd /c` 経由のときだけ。
 */
const SHELL_METACHARACTERS = /[&|;<>`\n\r\t\0]|\$\(/;
/** 引数・作業ディレクトリで常に禁止する制御文字（NUL・改行はどの経路でも異常）。 */
const CONTROL_CHARACTERS = /[\n\r\0]/;

export interface McpCommandPolicy {
  /** 許可するコマンドのベース名。`undefined` は「制限しない」（起動時に警告する構成）。 */
  readonly allowedCommands: readonly string[] | undefined;
}

/** 制限しないポリシー（後方互換のための明示的な逃げ道）。 */
export const UNRESTRICTED_MCP_COMMAND_POLICY: McpCommandPolicy = { allowedCommands: undefined };

/** 既定のポリシー（`DEFAULT_MCP_ALLOWED_COMMANDS` のみ許可）。 */
export const DEFAULT_MCP_COMMAND_POLICY: McpCommandPolicy = { allowedCommands: DEFAULT_MCP_ALLOWED_COMMANDS };

/**
 * コマンド文字列から比較用のベース名を取り出す。
 * ディレクトリ（`/` `\`）を落とし、Windows の実行ファイル拡張子を剥がし、小文字化する。
 */
export function commandBaseName(command: string): string {
  const trimmed = command.trim().replace(/^"(.*)"$/, '$1');
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  const lowered = base.toLowerCase();
  const suffix = EXECUTABLE_SUFFIXES.find((candidate) => lowered.endsWith(candidate));
  return suffix === undefined ? lowered : lowered.slice(0, -suffix.length);
}

function isAllowed(policy: McpCommandPolicy, command: string): boolean {
  if (policy.allowedCommands === undefined) return true;
  const base = commandBaseName(command);
  return policy.allowedCommands.some((allowed) => commandBaseName(allowed) === base);
}

function allowedListText(policy: McpCommandPolicy): string {
  return (policy.allowedCommands ?? []).join(', ');
}

/**
 * シェルラッパー経由で実際に起動されるコマンドを取り出す。
 * スイッチ（`/c` 等）の**直後の1トークン**だけを見る。`cmd /c "npx foo"` のように
 * 1引数へ詰め込まれた形は空白を含むため、コマンド名として成立せず拒否側へ倒れる。
 */
export function wrappedCommand(command: string, args: readonly string[]): string | undefined {
  const switches = SHELL_WRAPPERS.get(commandBaseName(command));
  if (switches === undefined) return undefined;
  const index = args.findIndex((arg) => switches.includes(arg.trim().toLowerCase()));
  if (index < 0) return undefined;
  return args[index + 1];
}

/** シェルラッパーか（引数のメタ文字検査を厳しくする対象）。 */
export function isShellWrapper(command: string): boolean {
  return SHELL_WRAPPERS.has(commandBaseName(command));
}

/**
 * 作業ディレクトリの検査。
 *
 * 相対パスは「サーバープロセスのcwd基準」という利用者から見えない基準で解決されるため、
 * 絶対パスだけを受け付ける（設定の意味が環境によって変わるのを防ぐ）。
 */
export function assertAllowedCwd(cwd: string): void {
  const value = cwd.trim();
  if (CONTROL_CHARACTERS.test(value)) throw new McpValidationError('transport.cwd must not contain control characters');
  const absolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(value);
  if (!absolute) throw new McpValidationError(`transport.cwd must be an absolute path: ${value}`);
}

/**
 * stdio トランスポートの起動内容をポリシーに照らす。違反は `McpValidationError`（400）。
 *
 * 保存時（use case）と接続直前（adapters）の両方から呼ぶ。保存時だけだと、ポリシー導入前に
 * 保存された設定や、ポリシーを緩めてから戻した環境で**既存の行がそのまま起動できてしまう**。
 */
export function assertAllowedStdioCommand(
  policy: McpCommandPolicy,
  transport: { readonly command: string; readonly args: readonly string[]; readonly cwd?: string },
): void {
  const command = transport.command.trim();
  if (command === '') throw new McpValidationError('transport.command must be a non-empty string');
  if (SHELL_METACHARACTERS.test(command)) {
    throw new McpValidationError(`transport.command must not contain shell metacharacters: ${command}`);
  }
  for (const [index, arg] of transport.args.entries()) {
    if (CONTROL_CHARACTERS.test(arg)) throw new McpValidationError(`transport.args.${index} must not contain control characters`);
  }
  if (transport.cwd !== undefined) assertAllowedCwd(transport.cwd);

  if (!isAllowed(policy, command)) {
    throw new McpValidationError(
      `transport.command is not allowed: ${commandBaseName(command)}.`
      + ` Allowed commands: ${allowedListText(policy)} (set AGENTCONTEXT_MCP_ALLOWED_COMMANDS to change this)`,
    );
  }

  if (!isShellWrapper(command)) return;
  // シェル経由では引数がそのまま解釈されるので、メタ文字を一切許さない。
  for (const [index, arg] of transport.args.entries()) {
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new McpValidationError(`transport.args.${index} must not contain shell metacharacters when the command runs through a shell`);
    }
  }
  const inner = wrappedCommand(command, transport.args);
  if (inner === undefined) {
    throw new McpValidationError(`transport.command ${commandBaseName(command)} requires the command to run to be given as a separate argument (e.g. args: ["/c", "npx", ...])`);
  }
  if (!isAllowed(policy, inner)) {
    throw new McpValidationError(
      `transport.args runs a command that is not allowed: ${commandBaseName(inner)}.`
      + ` Allowed commands: ${allowedListText(policy)} (set AGENTCONTEXT_MCP_ALLOWED_COMMANDS to change this)`,
    );
  }
}
