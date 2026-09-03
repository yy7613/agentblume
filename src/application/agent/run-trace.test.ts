import { describe, expect, it } from 'vitest';
import { ConfigError, SchemaError } from '../../domain/etl/errors';
import { failureFrom, sanitizeRunTrace } from './run-trace';
import { AgentRunError, ToolArgumentsError, ToolExecutionError } from './errors';

describe('run trace persistence helpers', () => {
  it('secret-like keyを再帰maskしDateをISO化する', () => {
    const trace = sanitizeRunTrace([{ sequence: 1, kind: 'tool-call', name: 'x', arguments: {
      password: 'p', nested: { apiKey: 'k', at: new Date('2026-07-03T00:00:00Z') }, safe: 'ok',
    } }]);
    expect(trace[0]).toMatchObject({ arguments: { password: '[REDACTED]', nested: { apiKey: '[REDACTED]', at: '2026-07-03T00:00:00.000Z' }, safe: 'ok' } });
  });

  it('coded errorだけmessageを保持しunknownは秘匿する', () => {
    expect(failureFrom(new AgentRunError('bad'))).toEqual({ code: 'AGENT_RUN', message: 'bad' });
    expect(failureFrom(new Error('secret detail'))).toEqual({ code: 'INTERNAL', message: 'internal error' });
  });

  it('ToolExecutionError は元例外の code/message に、どのToolのどのノードで落ちたかを添える', () => {
    const tool = { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' };
    const schema = new SchemaError('select: column(s) not found: revenue');
    schema.nodeId = 'pick';
    expect(failureFrom(new ToolExecutionError(tool, schema))).toEqual({ code: 'ETL_SCHEMA', message: 'select: column(s) not found: revenue', tool, nodeId: 'pick' });
    // ETL 以外の失敗は nodeId を持たない（キー自体を出さない）。
    expect(failureFrom(new ToolExecutionError(tool, new AgentRunError('bad')))).toEqual({ code: 'AGENT_RUN', message: 'bad', tool });
    // 元例外が unknown なら message は従来どおり秘匿し、識別だけを残す（HTTP 変換と同じ code/message になる）。
    expect(failureFrom(new ToolExecutionError(tool, new Error('secret detail')))).toEqual({ code: 'INTERNAL', message: 'internal error', tool });
  });

  it('ToolExecutionError は AgentRunError ではなく、code / nodeId を元例外から写す', () => {
    const schema = new SchemaError('x');
    schema.nodeId = 'n';
    const error = new ToolExecutionError({ internalId: 't' }, schema);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ name: 'ToolExecutionError', code: 'ETL_SCHEMA', message: 'x', nodeId: 'n', tool: { internalId: 't' } });
    expect(error.cause).toBe(schema);
    expect(new ToolExecutionError({ internalId: 't' }, new Error('plain'))).toMatchObject({ code: 'AGENT_RUN', message: 'plain', nodeId: undefined });
    expect(new ToolExecutionError({ internalId: 't' }, 'boom')).toMatchObject({ code: 'AGENT_RUN', message: 'tool execution failed' });
  });

  it('agent_callイベントを保持したままサニタイズする', () => {
    const trace = sanitizeRunTrace([
      { sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' },
    ]);
    expect(trace[0]).toEqual({ sequence: 1, kind: 'agent_call', toolName: 'ask_scorer', agentRef: { internalId: 'scorer', version: '1.0.0' }, childRunId: 'run-child', ok: true, summary: 'scored 42' });
  });

  it('ToolExecutionError は cause が Error でなくても組み立てられ、failure は識別だけを足して詳細を伏せる', () => {
    const tool = { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' };
    for (const cause of ['boom', null, undefined, 42, { code: 'ETL_SCHEMA', nodeId: 'n' }]) {
      const error = new ToolExecutionError(tool, cause);
      expect(error).toMatchObject({ name: 'ToolExecutionError', code: 'AGENT_RUN', message: 'tool execution failed', tool });
      expect(error.cause).toBe(cause);
      expect(error.nodeId).toBeUndefined();
      // Error でない値は code を名乗っていても信用しない: HTTP 変換と同じく INTERNAL に落ちる。
      const failure = failureFrom(error);
      expect(failure).toEqual({ code: 'INTERNAL', message: 'internal error', tool });
      expect(Object.hasOwn(failure, 'nodeId')).toBe(false);
    }
    // 元例外の code が文字列でない・nodeId が文字列でないものは写さない。
    const odd = Object.assign(new Error('odd'), { code: 500, nodeId: 7 });
    expect(new ToolExecutionError(tool, odd)).toMatchObject({ code: 'AGENT_RUN', message: 'odd', nodeId: undefined });
    expect(failureFrom(new ToolExecutionError(tool, odd))).toEqual({ code: 'INTERNAL', message: 'internal error', tool });
  });

  it('nodeId の無い coded 例外を包んだ failure は nodeId キー自体を持たず、修復上限に達した ToolArgumentsError も TOOL_ARGUMENTS のまま', () => {
    const tool = { internalId: 'score-tool' };
    const failure = failureFrom(new ToolExecutionError(tool, new ConfigError('bad config')));
    expect(failure).toEqual({ code: 'ETL_CONFIG', message: 'bad config', tool });
    expect(Object.hasOwn(failure, 'nodeId')).toBe(false);
    expect(failureFrom(new ToolExecutionError(tool, new ToolArgumentsError('required argument missing: score'))))
      .toEqual({ code: 'TOOL_ARGUMENTS', message: 'required argument missing: score', tool });
  });

  it('二重に包んでも外側の識別が勝ち、code / nodeId は根本原因から取る（積み重ねない）', () => {
    const schema = new SchemaError('x');
    schema.nodeId = 'inner-node';
    const inner = new ToolExecutionError({ internalId: 'inner-tool' }, schema);
    const outer = new ToolExecutionError({ internalId: 'outer-tool', publishName: 'outer' }, inner);
    expect(outer).toMatchObject({ code: 'ETL_SCHEMA', message: 'x', nodeId: 'inner-node' });
    expect(failureFrom(outer)).toEqual({ code: 'ETL_SCHEMA', message: 'x', tool: { internalId: 'outer-tool', publishName: 'outer' }, nodeId: 'inner-node' });
  });

  it('sanitizeRunTrace は error イベントの tool 参照 / nodeId と mcp-server-skipped の detail を残し、秘密っぽい引数だけを伏せる', () => {
    const tool = { internalId: 'token-tool', version: '1.0.0', publishName: 'api_key_lookup' };
    const trace = sanitizeRunTrace([
      { sequence: 1, kind: 'mcp-server-skipped', server: 'secrets', reason: 'unreachable', detail: 'failed to start' },
      { sequence: 2, kind: 'tool-call', name: 'api_key_lookup', arguments: { apiKey: 'k', name: 'Alice' } },
      { sequence: 3, kind: 'error', code: 'ETL_SCHEMA', message: 'select: column(s) not found: revenue', tool, nodeId: 'pick' },
    ]);
    expect(trace).toEqual([
      { sequence: 1, kind: 'mcp-server-skipped', server: 'secrets', reason: 'unreachable', detail: 'failed to start' },
      { sequence: 2, kind: 'tool-call', name: 'api_key_lookup', arguments: { apiKey: '[REDACTED]', name: 'Alice' } },
      { sequence: 3, kind: 'error', code: 'ETL_SCHEMA', message: 'select: column(s) not found: revenue', tool, nodeId: 'pick' },
    ]);
    // 構造共有しない（永続化前に元の例外オブジェクトと切り離す）。
    expect((trace[2] as { tool?: unknown }).tool).not.toBe(tool);
  });
});
