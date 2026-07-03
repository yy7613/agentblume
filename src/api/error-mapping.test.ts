/**
 * error-mapping のテスト（v4 実装契約 §7）
 *
 * 各例外 → status/code の全マッピングと、未知例外 → 500（message 固定）を検証する。
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, GraphError, SchemaError } from '../domain/etl/errors';
import {
  ToolError,
  ToolNotFoundError,
  ToolValidationError,
  VersionConflictError,
} from '../domain/tool/errors';
import { BadRequestError, toHttpError } from './error-mapping';
import { AgentRunError, ToolArgumentsError, UnsafeToolError } from '../application/agent/errors';
import { ModelProviderError } from '../application/model/model-provider';
import { RunFailedError } from '../application/agent/errors';
import { RunNotFoundError } from '../domain/run/errors';

describe('toHttpError', () => {
  it.each([
    [new ToolNotFoundError('missing tool'), 404, 'TOOL_NOT_FOUND', 'missing tool'],
    [new VersionConflictError('dup version'), 409, 'TOOL_VERSION_CONFLICT', 'dup version'],
    [new ToolValidationError('bad tool'), 400, 'TOOL_VALIDATION', 'bad tool'],
    [new GraphError('bad graph'), 422, 'ETL_GRAPH', 'bad graph'],
    [new ConfigError('bad config'), 422, 'ETL_CONFIG', 'bad config'],
    [new SchemaError('bad schema'), 422, 'ETL_SCHEMA', 'bad schema'],
    [new BadRequestError('bad request'), 400, 'BAD_REQUEST', 'bad request'],
    [new UnsafeToolError('unsafe'), 403, 'UNSAFE_TOOL', 'unsafe'],
    [new ToolArgumentsError('bad args'), 422, 'TOOL_ARGUMENTS', 'bad args'],
    [new AgentRunError('bad run'), 422, 'AGENT_RUN', 'bad run'],
    [new ModelProviderError('offline'), 502, 'MODEL_PROVIDER', 'offline'],
    [new RunNotFoundError('missing run'), 404, 'RUN_NOT_FOUND', 'missing run'],
  ] as const)(
    '%s → status=%i code=%s',
    (err, status, code, message) => {
      expect(toHttpError(err)).toEqual({ status, body: { error: { code, message } } });
    },
  );

  it('RunFailedErrorは元status/codeを維持してrunIdを付ける', () => {
    expect(toHttpError(new RunFailedError('run-1', new ModelProviderError('offline')))).toEqual({
      status: 502, body: { error: { code: 'MODEL_PROVIDER', message: 'offline', runId: 'run-1' } },
    });
  });

  it('具象クラスは基底クラスの分岐に飲み込まれない（判定順序）', () => {
    // ToolNotFoundError / VersionConflictError は ToolError 派生。
    // ToolValidationError（400）ではなくそれぞれの status に落ちること。
    expect(toHttpError(new ToolNotFoundError('x')).status).toBe(404);
    expect(toHttpError(new VersionConflictError('x')).status).toBe(409);
  });

  it('未知の Error → 500 INTERNAL（message は固定文言で詳細を漏らさない）', () => {
    const result = toHttpError(new Error('secret internal detail'));
    expect(result.status).toBe(500);
    expect(result.body.error.code).toBe('INTERNAL');
    expect(result.body.error.message).toBe('internal error');
  });

  it('マッピング外の ToolError 派生（基底そのもの）→ 500 INTERNAL', () => {
    const result = toHttpError(new ToolError('SOME_CODE', 'raw tool error'));
    expect(result).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'internal error' } },
    });
  });

  it('Error ですらない値（string / undefined）→ 500 INTERNAL', () => {
    for (const value of ['boom', undefined, null, 42]) {
      expect(toHttpError(value)).toEqual({
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'internal error' } },
      });
    }
  });
});

describe('BadRequestError', () => {
  it('code は BAD_REQUEST、Error 派生である', () => {
    const err = new BadRequestError('oops');
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('BAD_REQUEST');
    expect(err.name).toBe('BadRequestError');
    expect(err.message).toBe('oops');
  });
});
