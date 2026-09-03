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
import { AgentRunError, ToolArgumentsError, ToolExecutionError, UnsafeToolError } from '../application/agent/errors';
import { ModelProviderError } from '../application/model/model-provider';
import { RunFailedError } from '../application/agent/errors';
import { RunNotFoundError } from '../domain/run/errors';
import { SkillNotFoundError, SkillValidationError, SkillVersionConflictError } from '../domain/skill/errors';
import { InvalidFileContentError } from '../domain/data-source/errors';
import { SessionQuotaExceededError } from '../domain/session/errors';

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
    [new SkillNotFoundError('missing skill'), 404, 'SKILL_NOT_FOUND', 'missing skill'],
    [new SkillVersionConflictError('dup skill'), 409, 'SKILL_VERSION_CONFLICT', 'dup skill'],
    [new SkillValidationError('bad skill'), 400, 'SKILL_VALIDATION', 'bad skill'],
    [new InvalidFileContentError('bad content'), 400, 'INVALID_FILE_CONTENT', 'bad content'],
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

  it('ToolExecutionErrorは元status/codeを維持してtool / nodeIdを付け、RunFailedError経由ならrunIdも揃う', () => {
    const tool = { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' };
    const schema = new SchemaError('select: column(s) not found: revenue');
    schema.nodeId = 'pick';
    expect(toHttpError(new ToolExecutionError(tool, schema))).toEqual({
      status: 422, body: { error: { code: 'ETL_SCHEMA', message: 'select: column(s) not found: revenue', tool, nodeId: 'pick' } },
    });
    expect(toHttpError(new RunFailedError('run-1', new ToolExecutionError(tool, schema)))).toEqual({
      status: 422, body: { error: { code: 'ETL_SCHEMA', message: 'select: column(s) not found: revenue', tool, nodeId: 'pick', runId: 'run-1' } },
    });
    // nodeId の無い失敗はキー自体を出さない。
    expect(toHttpError(new ToolExecutionError(tool, new ConfigError('bad config')))).toEqual({
      status: 422, body: { error: { code: 'ETL_CONFIG', message: 'bad config', tool } },
    });
    // 元例外が未知なら従来どおり 500 INTERNAL（詳細は漏らさない）のまま、識別だけを足す。
    expect(toHttpError(new ToolExecutionError(tool, new Error('secret internal detail')))).toEqual({
      status: 500, body: { error: { code: 'INTERNAL', message: 'internal error', tool } },
    });
  });

  it('ToolExecutionErrorは元例外ごとの status を保つ（422 TOOL_ARGUMENTS / 403 UNSAFE_TOOL / 413 SESSION_QUOTA_EXCEEDED / 422 AGENT_RUN）', () => {
    const tool = { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' };
    expect(toHttpError(new ToolExecutionError(tool, new ToolArgumentsError('required argument missing: score')))).toEqual({
      status: 422, body: { error: { code: 'TOOL_ARGUMENTS', message: 'required argument missing: score', tool } },
    });
    expect(toHttpError(new ToolExecutionError(tool, new UnsafeToolError('unsafe')))).toEqual({
      status: 403, body: { error: { code: 'UNSAFE_TOOL', message: 'unsafe', tool } },
    });
    expect(toHttpError(new ToolExecutionError(tool, new SessionQuotaExceededError('artifact too large')))).toEqual({
      status: 413, body: { error: { code: 'SESSION_QUOTA_EXCEEDED', message: 'artifact too large', tool } },
    });
    expect(toHttpError(new ToolExecutionError(tool, new AgentRunError('tool output schema is missing column revenue')))).toEqual({
      status: 422, body: { error: { code: 'AGENT_RUN', message: 'tool output schema is missing column revenue', tool } },
    });
  });

  it('ToolExecutionErrorの元例外が Error でない・未知でも 500 INTERNAL のまま詳細を漏らさず、nodeId キーを生やさない', () => {
    const tool = { internalId: 'score-tool' };
    for (const cause of ['secret string', undefined, new Error('secret internal detail')]) {
      const mapped = toHttpError(new RunFailedError('run-1', new ToolExecutionError(tool, cause)));
      expect(mapped).toEqual({ status: 500, body: { error: { code: 'INTERNAL', message: 'internal error', tool, runId: 'run-1' } } });
      expect(Object.hasOwn(mapped.body.error, 'nodeId')).toBe(false);
      expect(JSON.stringify(mapped)).not.toContain('secret');
    }
    // 二重に包まれても外側の識別が勝ち、status / code / nodeId は根本原因から決まる。
    const schema = new SchemaError('bad schema');
    schema.nodeId = 'inner';
    const nested = new ToolExecutionError({ internalId: 'outer' }, new ToolExecutionError({ internalId: 'inner' }, schema));
    expect(toHttpError(nested)).toEqual({ status: 422, body: { error: { code: 'ETL_SCHEMA', message: 'bad schema', tool: { internalId: 'outer' }, nodeId: 'inner' } } });
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
