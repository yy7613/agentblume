import { describe, expect, it } from 'vitest';
import {
  assertAllowedCwd, assertAllowedEnvironment, assertAllowedStdioCommand, commandBaseName, DEFAULT_MCP_ALLOWED_COMMANDS,
  DEFAULT_MCP_COMMAND_POLICY, isProtectedEnvironmentName, isShellWrapper, PROTECTED_ENVIRONMENT_NAMES,
  UNRESTRICTED_MCP_COMMAND_POLICY, wrappedCommand, type McpCommandPolicy,
} from './command-policy';
import { McpValidationError } from './errors';

function check(
  transport: { command: string; args?: readonly string[]; cwd?: string; env?: Readonly<Record<string, string>> },
  policy = DEFAULT_MCP_COMMAND_POLICY,
): void {
  assertAllowedStdioCommand(policy, {
    command: transport.command,
    args: transport.args ?? [],
    ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
    ...(transport.env === undefined ? {} : { env: transport.env }),
  });
}

/** `AGENTCONTEXT_MCP_ALLOWED_COMMANDS=<value>` を `composition/root.ts` と同じ形でポリシーへ落とす。 */
function policyFromEnv(value: string): McpCommandPolicy {
  const entries = value.split(',').map((item) => item.trim()).filter((item) => item !== '');
  return entries.length === 1 && entries[0] === '*' ? UNRESTRICTED_MCP_COMMAND_POLICY : { allowedCommands: entries };
}

function messageOf(run: () => void): string {
  try { run(); }
  catch (error) { return (error as Error).message; }
  return expect.unreachable('should have thrown') as never;
}

describe('commandBaseName', () => {
  it.each([
    ['npx', 'npx'],
    ['/usr/local/bin/node', 'node'],
    ['C:\\Program Files\\nodejs\\node.exe', 'node'],
    ['C:/tools/uvx.CMD', 'uvx'],
    ['"C:\\Program Files (x86)\\Python\\python.exe"', 'python'],
    ['NPX', 'npx'],
  ])('%s → %s', (command, expected) => { expect(commandBaseName(command)).toBe(expected); });
});

describe('既定の許可リスト', () => {
  it('MCPのランチャーだけを含む（npx / uvx / bunx と Windows 用の cmd）', () => {
    expect([...DEFAULT_MCP_ALLOWED_COMMANDS]).toEqual(['npx', 'uvx', 'bunx', 'cmd']);
  });

  it('既定の許可リストにあるコマンドは通る', () => {
    for (const command of DEFAULT_MCP_ALLOWED_COMMANDS) {
      if (isShellWrapper(command)) continue;
      expect(() => check({ command })).not.toThrow();
    }
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', '-y', 'srv'] })).not.toThrow();
  });

  /**
   * 以前の既定に入っていたインタープリタ・ランタイム。`node -e` / `python -c` / `docker run -v /:/host`
   * は「許可されたコマンド」のまま任意コードを走らせるので、既定から外した。
   */
  it.each(['node', 'python', 'python3', 'docker', 'deno', 'bun', 'uv'])('%s は既定では拒否される', (command) => {
    expect(() => check({ command })).toThrow(McpValidationError);
    expect(() => check({ command })).toThrow(/not allowed/);
  });

  it('パス・拡張子・大文字の違いはベース名へ畳んでから判定する（node の別表記も既定では拒否）', () => {
    for (const command of ['/usr/bin/node', 'C:\\nodejs\\node.exe', 'NODE.EXE', '"C:\\Program Files\\nodejs\\node.exe"']) {
      expect(() => check({ command }), command).toThrow(/not allowed: node\./);
    }
    for (const command of ['npx.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\npx.cmd', '/usr/local/bin/uvx', 'BUNX']) {
      expect(() => check({ command }), command).not.toThrow();
    }
  });

  /**
   * 既定から外したコマンドで保存された行は、更新後に接続時ここで落ちる。
   * 「拒否した」だけでは直せないので、コマンド名と設定すべき環境変数の値まで書く。
   */
  it('拒否メッセージはコマンド名と、そのまま貼れる環境変数の値を案内する', () => {
    const message = messageOf(() => check({ command: 'node', args: ['server.js'] }));
    expect(message).toBe(
      'transport.command is not allowed: node. Allowed commands: npx, uvx, bunx, cmd.'
      + ' To allow it, set AGENTCONTEXT_MCP_ALLOWED_COMMANDS=npx,uvx,bunx,cmd,node on the server and restart',
    );
  });

  it('AGENTCONTEXT_MCP_ALLOWED_COMMANDS=node,npx を明示すれば node は再び通る', () => {
    const policy = policyFromEnv('node,npx');
    expect(() => check({ command: 'node', args: ['server.js'] }, policy)).not.toThrow();
    expect(() => check({ command: '/usr/bin/node' }, policy)).not.toThrow();
    // 明示したリストに無いものは相変わらず拒否（既定へ足し戻す形ではなく、差し替え）。
    expect(() => check({ command: 'uvx' }, policy)).toThrow(/not allowed: uvx\./);
    expect(messageOf(() => check({ command: 'python' }, policy))).toContain('AGENTCONTEXT_MCP_ALLOWED_COMMANDS=node,npx,python');
  });

  it('env で許可リストを差し替えられる', () => {
    expect(() => check({ command: 'my-server' }, { allowedCommands: ['my-server'] })).not.toThrow();
    expect(() => check({ command: 'npx' }, { allowedCommands: ['my-server'] })).toThrow(/not allowed/);
  });

  it('制限しないポリシー（*）では node も whoami も通る（後方互換の逃げ道）', () => {
    const policy = policyFromEnv('*');
    expect(policy).toBe(UNRESTRICTED_MCP_COMMAND_POLICY);
    expect(() => check({ command: 'node', args: ['-e', 'x'] }, policy)).not.toThrow();
    expect(() => check({ command: 'whoami' }, policy)).not.toThrow();
  });
});

describe('シェルラッパー（Windows の npx 起動を壊さずに抜け道を塞ぐ）', () => {
  it('cmd /c npx ... は通る（公式に案内している設定）', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\\data'] })).not.toThrow();
    expect(() => check({ command: 'C:\\Windows\\System32\\cmd.exe', args: ['/C', 'uvx', 'mcp-server-fetch'] })).not.toThrow();
  });

  it('cmd /c node ... は既定では拒否される（ラッパー越しでも同じ許可リスト）', () => {
    const message = messageOf(() => check({ command: 'cmd', args: ['/c', 'node', 'server.js'] }));
    expect(message).toContain('transport.args runs a command that is not allowed: node.');
    expect(message).toContain('AGENTCONTEXT_MCP_ALLOWED_COMMANDS=npx,uvx,bunx,cmd,node');
    // 明示すれば通る。
    expect(() => check({ command: 'cmd', args: ['/c', 'node', 'server.js'] }, policyFromEnv('npx,cmd,node'))).not.toThrow();
  });

  it('cmd /c で許可外のコマンドを起動しようとすると拒否される', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'calc.exe'] })).toThrow(/not allowed/);
    expect(() => check({ command: 'cmd', args: ['/c', 'whoami'] })).toThrow(/not allowed: whoami\./);
  });

  /** `/k` はコマンド終了後もシェルを残す。stdio がシェルのものになるので MCP サーバーの起動として成立しない。 */
  it('cmd /k はコマンドの中身に関わらず拒否される', () => {
    expect(() => check({ command: 'cmd', args: ['/k', 'npx', '-y', 'srv'] })).toThrow(/with \/c, not \/k/);
    expect(() => check({ command: 'cmd', args: ['/K', 'whoami'] })).toThrow(/with \/c, not \/k/);
    // `*` でも形の検査は外れない。
    expect(() => check({ command: 'cmd', args: ['/k', 'npx'] }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/with \/c, not \/k/);
  });

  it('起動コマンドを別引数で与えていない cmd は拒否される', () => {
    expect(() => check({ command: 'cmd', args: [] })).toThrow(/separate argument/);
    expect(() => check({ command: 'cmd', args: ['/c'] })).toThrow(/separate argument/);
    // `/c` が無い（`cmd npx` のような形）も同じ。
    expect(() => check({ command: 'cmd', args: ['npx', '-y', 'srv'] })).toThrow(/separate argument/);
  });

  it('1引数へ詰め込んだ形（cmd /c "npx foo"）はコマンド名として成立せず拒否される', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'npx foo'] })).toThrow(/not allowed/);
  });

  it('シェル経由の引数にメタ文字があれば拒否される', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', 'x', '&&', 'calc'] })).toThrow(/shell metacharacters/);
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', 'x|calc'] })).toThrow(/shell metacharacters/);
  });

  it('シェル経由でない引数のメタ文字は許容する（直接spawnでは不活性）', () => {
    expect(() => check({ command: 'npx', args: ['-y', 'srv', '--filter=a|b'] })).not.toThrow();
    expect(() => check({ command: 'node', args: ['server.js', '--filter=a|b'] }, policyFromEnv('node'))).not.toThrow();
  });

  /**
   * cmd.exe は引数中の `%VAR%` を**コマンド行の解釈時に展開する**。`%` を通していたため、
   * 引数側は無害なまま env 側に区切り文字を置く書き方が成立していた
   * （`args:['/c','npx','%X%']` + `env:{X:'& calc'}`）。
   */
  it('シェル経由の引数に % があれば拒否される（env 経由の展開を塞ぐ）', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', '%X%'], env: { X: '& calc' } })).toThrow(/shell metacharacters/);
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', '%PATH%'] })).toThrow(/shell metacharacters/);
  });

  it('シェル経由でない引数の % は許容する（展開されない）', () => {
    expect(() => check({ command: 'npx', args: ['srv', '--pct=50%'] })).not.toThrow();
  });

  it('制限しないポリシー（*）でも cmd /c の形とメタ文字の検査は外れない', () => {
    expect(() => check({ command: 'cmd', args: ['/c', 'whoami'] }, UNRESTRICTED_MCP_COMMAND_POLICY)).not.toThrow();
    expect(() => check({ command: 'cmd', args: [] }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/separate argument/);
    expect(() => check({ command: 'cmd', args: ['/c', 'npx', 'a&&b'] }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/shell metacharacters/);
  });
});

describe('assertAllowedStdioCommand（コマンド名・引数・cwd）', () => {
  it('コマンド名のメタ文字は常に拒否される', () => {
    expect(() => check({ command: 'npx && calc' })).toThrow(/shell metacharacters/);
    expect(() => check({ command: 'npx$(id)' })).toThrow(/shell metacharacters/);
    expect(() => check({ command: 'npx && calc' }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/shell metacharacters/);
  });

  it('括弧つきの正規なWindowsパスは通る（許可リストに載っていれば）', () => {
    expect(() => check({ command: 'C:\\Program Files (x86)\\Python\\python.exe', args: ['-m', 'server'] }, policyFromEnv('python'))).not.toThrow();
  });

  it('引数の制御文字は常に拒否される（許可リストより先に落ちる）', () => {
    expect(() => check({ command: 'npx', args: ['a\nb'] })).toThrow(/transport\.args\.0 must not contain control characters/);
    expect(() => check({ command: 'npx', args: ['ok', 'a\0b'] })).toThrow(/transport\.args\.1 must not contain control characters/);
    expect(() => check({ command: 'npx', args: ['a\rb'] }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/control characters/);
  });

  it('空のコマンドは拒否される', () => {
    expect(() => check({ command: '   ' })).toThrow(/non-empty/);
  });

  it('stdio 検査から cwd も見られている', () => {
    expect(() => check({ command: 'npx', cwd: 'relative' })).toThrow(/absolute path/);
  });
});

/**
 * env は `args` と違って**一切検査されていなかった**。値は子プロセスの環境ブロックへ
 * そのまま入るので、名前と制御文字だけは入口で落とす（値の中身は資格情報なので問わない）。
 * さらに `PATH` / `NODE_OPTIONS` / `LD_PRELOAD` のような変数は、許可リストを通った
 * コマンド名のまま実行内容を差し替えるので、名前だけで拒否する。
 */
describe('transport.env', () => {
  it('通常の環境変数は通る（値の中身は問わない）', () => {
    expect(() => check({ command: 'npx', env: { API_TOKEN: 'sk-abc&def|ghi', DEBUG: '1', _PRIVATE: 'x' } })).not.toThrow();
  });

  it('空の env は通る', () => {
    expect(() => check({ command: 'npx', env: {} })).not.toThrow();
    expect(() => assertAllowedEnvironment({})).not.toThrow();
  });

  it('変数名に使えない文字は拒否される', () => {
    expect(() => check({ command: 'npx', env: { 'BAD NAME': 'x' } })).toThrow(/invalid variable name/);
    expect(() => check({ command: 'npx', env: { 'A=B': 'x' } })).toThrow(/invalid variable name/);
    expect(() => check({ command: 'npx', env: { '1ST': 'x' } })).toThrow(/invalid variable name/);
    expect(() => check({ command: 'npx', env: { '': 'x' } })).toThrow(/invalid variable name/);
  });

  it('名前の長さの境界: 1文字は通り、255文字も通る（長さでは落とさない）', () => {
    expect(() => check({ command: 'npx', env: { A: '1', _: '2' } })).not.toThrow();
    expect(() => check({ command: 'npx', env: { [`X${'Y'.repeat(254)}`]: '1' } })).not.toThrow();
  });

  it('値の制御文字は拒否され、メッセージに値は載らない', () => {
    expect(() => check({ command: 'npx', env: { TOKEN: 'a\nb' } })).toThrow(/transport\.env\.TOKEN/);
    expect(() => check({ command: 'npx', env: { TOKEN: 'a\0b' } })).toThrow(/control characters/);
    try {
      check({ command: 'npx', env: { TOKEN: 'secret-value\nX' } });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });

  describe('実行内容を差し替える変数名の拒否', () => {
    it('公開している一覧は大文字で、重複が無い', () => {
      expect(PROTECTED_ENVIRONMENT_NAMES).toEqual(expect.arrayContaining([
        'PATH', 'PATHEXT', 'COMSPEC', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
        'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
        'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONWARNINGS', 'RUBYOPT', 'PERL5OPT',
        'BASH_ENV', 'ENV', 'PROMPT_COMMAND', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'SSLKEYLOGFILE',
      ]));
      expect(new Set(PROTECTED_ENVIRONMENT_NAMES).size).toBe(PROTECTED_ENVIRONMENT_NAMES.length);
      for (const name of PROTECTED_ENVIRONMENT_NAMES) expect(name).toBe(name.toUpperCase());
    });

    it.each(['PATH', 'path', 'Path', 'NODE_OPTIONS', 'ld_preload', 'Ld_Library_Path', 'PYTHONPATH', 'ENV', 'SSLKEYLOGFILE', '_JAVA_OPTIONS'])(
      '%s は値に関わらず拒否される（大文字小文字を区別しない）',
      (name) => {
        expect(isProtectedEnvironmentName(name)).toBe(true);
        expect(() => check({ command: 'npx', env: { [name]: 'harmless' } })).toThrow(McpValidationError);
        expect(messageOf(() => check({ command: 'npx', env: { [name]: '/tmp/evil' } })))
          .toBe(`transport.env must not override ${name} (it changes how the child process executes)`);
      },
    );

    it('メッセージに値は載らない', () => {
      expect(messageOf(() => check({ command: 'npx', env: { LD_PRELOAD: '/opt/secret-lib.so' } }))).not.toContain('secret-lib');
    });

    it.each(['PATHS', 'MY_PATH', 'NODE_OPTIONS_X', 'XPATH', 'ENVIRONMENT', 'PYTHONPATH2', 'LD_PRELOAD_'])('%s は普通の変数として通る（完全一致だけ）', (name) => {
      expect(isProtectedEnvironmentName(name)).toBe(false);
      expect(() => check({ command: 'npx', env: { [name]: 'x' } })).not.toThrow();
    });

    it('制限しないポリシー（*）でも外れない（* が広げるのはコマンド名だけ）', () => {
      expect(() => check({ command: 'node', env: { NODE_OPTIONS: '--require /tmp/x.js' } }, UNRESTRICTED_MCP_COMMAND_POLICY)).toThrow(/must not override NODE_OPTIONS/);
      expect(() => check({ command: 'npx', env: { PATH: '/tmp' } }, policyFromEnv('*'))).toThrow(/must not override PATH/);
    });

    it('明示した許可リストでも外れない', () => {
      expect(() => check({ command: 'node', env: { path: 'C:\\evil' } }, policyFromEnv('node'))).toThrow(/must not override path/);
    });

    it('拒否名と制御文字の両方があっても、値は読まずに名前で先に落ちる', () => {
      expect(() => check({ command: 'npx', env: { PATH: 'a\nb' } })).toThrow(/must not override PATH/);
    });

    it('cmd /c 経由でも同じ検査が効く', () => {
      expect(() => check({ command: 'cmd', args: ['/c', 'npx', '-y', 'srv'], env: { COMSPEC: 'C:\\evil.exe' } })).toThrow(/must not override COMSPEC/);
    });
  });
});

describe('assertAllowedCwd', () => {
  it.each(['/work', '/home/me/mcp', 'C:\\workspace', 'C:/workspace', '\\\\share\\dir'])('絶対パス %s は通る', (cwd) => {
    expect(() => assertAllowedCwd(cwd)).not.toThrow();
  });

  it.each(['work', './work', '../../etc', 'work/sub'])('相対パス %s は拒否される', (cwd) => {
    expect(() => assertAllowedCwd(cwd)).toThrow(/absolute path/);
  });

  it('制御文字を含む cwd は拒否される', () => {
    expect(() => assertAllowedCwd('/work\0/etc')).toThrow(/control characters/);
  });
});

describe('wrappedCommand', () => {
  it('シェルラッパーでなければ undefined', () => {
    expect(wrappedCommand('npx', ['-c', 'x'])).toBeUndefined();
  });
  it('スイッチの次のトークンを返す', () => {
    expect(wrappedCommand('cmd', ['/c', 'npx', 'x'])).toBe('npx');
    expect(wrappedCommand('sh', ['-c', 'id'])).toBe('id');
  });
  it('/k はコマンドスイッチとして扱わない（形ごと拒否する側へ倒す）', () => {
    expect(wrappedCommand('cmd', ['/k', 'npx'])).toBeUndefined();
  });
});
