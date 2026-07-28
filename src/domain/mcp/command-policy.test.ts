import { describe, expect, it } from 'vitest';
import {
  assertAllowedCwd, assertAllowedStdioCommand, commandBaseName, DEFAULT_MCP_ALLOWED_COMMANDS,
  DEFAULT_MCP_COMMAND_POLICY, isShellWrapper, UNRESTRICTED_MCP_COMMAND_POLICY, wrappedCommand,
} from './command-policy';
import { McpValidationError } from './errors';

function check(transport: { command: string; args?: readonly string[]; cwd?: string }, policy = DEFAULT_MCP_COMMAND_POLICY): void {
  assertAllowedStdioCommand(policy, { command: transport.command, args: transport.args ?? [], ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }) });
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

describe('assertAllowedStdioCommand', () => {
  it('既定の許可リストにあるコマンドは通る', () => {
    for (const command of DEFAULT_MCP_ALLOWED_COMMANDS) {
      if (isShellWrapper(command)) continue;
      expect(() => check({ command })).not.toThrow();
    }
  });

  it('絶対パス・拡張子つきでもベース名で一致する', () => {
    expect(() => check({ command: 'C:\\Program Files\\nodejs\\node.exe' })).not.toThrow();
    expect(() => check({ command: '/usr/local/bin/uvx', args: ['mcp-server-fetch'] })).not.toThrow();
  });

  it('許可リストに無いコマンドは拒否される', () => {
    expect(() => check({ command: 'whoami' })).toThrow(McpValidationError);
    expect(() => check({ command: '/bin/sh', args: ['-c', 'id'] })).toThrow(/not allowed/);
  });

  it('拒否メッセージは設定方法を案内する', () => {
    expect(() => check({ command: 'curl' })).toThrow(/AGENTCONTEXT_MCP_ALLOWED_COMMANDS/);
  });

  it('制限しないポリシーでは何でも通る（後方互換の逃げ道）', () => {
    expect(() => check({ command: 'whoami' }, UNRESTRICTED_MCP_COMMAND_POLICY)).not.toThrow();
  });

  it('env で許可リストを差し替えられる', () => {
    expect(() => check({ command: 'my-server' }, { allowedCommands: ['my-server'] })).not.toThrow();
    expect(() => check({ command: 'npx' }, { allowedCommands: ['my-server'] })).toThrow(/not allowed/);
  });

  describe('シェルラッパー（Windows の npx 起動を壊さずに抜け道を塞ぐ）', () => {
    it('cmd /c npx ... は通る（公式に案内している設定）', () => {
      expect(() => check({ command: 'cmd', args: ['/c', 'npx', '-y', '@modelcontextprotocol/server-filesystem', 'C:\\data'] })).not.toThrow();
    });

    it('cmd /c で許可外のコマンドを起動しようとすると拒否される', () => {
      expect(() => check({ command: 'cmd', args: ['/c', 'calc.exe'] })).toThrow(/not allowed/);
      expect(() => check({ command: 'cmd', args: ['/k', 'whoami'] })).toThrow(/not allowed/);
    });

    it('1引数へ詰め込んだ形（cmd /c "npx foo"）はコマンド名として成立せず拒否される', () => {
      expect(() => check({ command: 'cmd', args: ['/c', 'npx foo'] })).toThrow(/not allowed/);
    });

    it('起動コマンドを別引数で与えていない cmd は拒否される', () => {
      expect(() => check({ command: 'cmd', args: [] })).toThrow(/separate argument/);
    });

    it('シェル経由の引数にメタ文字があれば拒否される', () => {
      expect(() => check({ command: 'cmd', args: ['/c', 'npx', 'x', '&&', 'calc'] })).toThrow(/shell metacharacters/);
      expect(() => check({ command: 'cmd', args: ['/c', 'npx', 'x|calc'] })).toThrow(/shell metacharacters/);
    });

    it('シェル経由でない引数のメタ文字は許容する（直接spawnでは不活性）', () => {
      expect(() => check({ command: 'node', args: ['server.js', '--filter=a|b'] })).not.toThrow();
    });
  });

  it('コマンド名のメタ文字は常に拒否される', () => {
    expect(() => check({ command: 'node && calc' })).toThrow(/shell metacharacters/);
    expect(() => check({ command: 'node$(id)' })).toThrow(/shell metacharacters/);
  });

  it('括弧つきの正規なWindowsパスは通る', () => {
    expect(() => check({ command: 'C:\\Program Files (x86)\\Python\\python.exe', args: ['-m', 'server'] })).not.toThrow();
  });

  it('引数の制御文字は常に拒否される', () => {
    expect(() => check({ command: 'node', args: ['a\nb'] })).toThrow(/control characters/);
    expect(() => check({ command: 'node', args: ['a\0b'] })).toThrow(/control characters/);
  });

  it('空のコマンドは拒否される', () => {
    expect(() => check({ command: '   ' })).toThrow(/non-empty/);
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

  it('stdio 検査から cwd も見られている', () => {
    expect(() => check({ command: 'node', cwd: 'relative' })).toThrow(/absolute path/);
  });
});

describe('wrappedCommand', () => {
  it('シェルラッパーでなければ undefined', () => {
    expect(wrappedCommand('node', ['-c', 'x'])).toBeUndefined();
  });
  it('スイッチの次のトークンを返す', () => {
    expect(wrappedCommand('cmd', ['/c', 'npx', 'x'])).toBe('npx');
    expect(wrappedCommand('sh', ['-c', 'id'])).toBe('id');
  });
});
