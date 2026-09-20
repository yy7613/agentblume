import { describe, expect, it } from 'vitest';
import { failRun, startRun, waitRunForApproval, type RunApprovalCheckpoint } from './run';
import { deserializeRun, serializeRun } from './serialization';

describe('Run serialization', () => {
  it('JSON互換recordを往復して構造共有しない', () => {
    const record = startRun({ runId: 'run-1', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'test', tool: { internalId: 'tool' }, startedAt: 'now' });
    const serialized = serializeRun(record);
    expect(deserializeRun(JSON.parse(JSON.stringify(serialized)))).toEqual(record);
    expect(serialized).not.toBe(record);
  });

  it('不正status/traceを拒否する', () => {
    expect(() => deserializeRun({ runId: 'x', scope: { tenantId: 't', workspaceId: 'w' }, status: 'bad', mode: 'preview', tool: { internalId: 't' }, startedAt: 'x', trace: [] })).toThrow();
  });

  it('Tool未選択の保存済みAgent runを往復する', () => {
    const record = startRun({ runId: 'run-agent', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: 'now' });
    expect(deserializeRun(serializeRun(record))).toEqual(record);
    expect(() => deserializeRun({ ...record, agent: undefined })).toThrow(/tool or agent/);
  });

  it('v26 observability fieldsを往復し旧recordはpurpose無しでも読める', () => {
    const record = startRun({ runId: 'run-observed', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', purpose: 'evaluation', agent: { internalId: 'agent', version: '1.0.0' }, model: { provider: 'provider', model: 'model', modelConfigHash: 'hash' }, startedAt: '2026-07-10T00:00:00.000Z' });
    const completed = { ...record, status: 'succeeded' as const, response: 'ok', trace: [], usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, latency: { totalMs: 20, modelMs: 18, toolMs: 1 }, estimatedCost: { kind: 'estimated' as const, amount: 0.00002, currency: 'USD' as const, price: { currency: 'USD' as const, inputPerMillionTokens: 1, outputPerMillionTokens: 2, effectiveAt: '2026-07-01T00:00:00.000Z' } }, completedAt: '2026-07-10T00:00:01.000Z' };
    expect(deserializeRun(serializeRun(completed))).toEqual(completed);
    const legacy = startRun({ runId: 'legacy', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', tool: { internalId: 'tool' }, startedAt: 'now' });
    expect(deserializeRun(legacy).purpose).toBeUndefined();
  });

  it('waiting-approval + tool-approval checkpointをJSON経由で往復する', () => {
    const checkpoint: RunApprovalCheckpoint = {
      kind: 'tool-approval',
      agentRef: { internalId: 'agent', version: '1.2.0' },
      messages: [
        { role: 'system', content: 'be safe' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', imageUrl: 'data:image/png;base64,AA==' }] },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7, nested: { flag: true } } }] },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'c0' },
      ],
      pendingCalls: [{ id: 'c1', name: 'write_tool', arguments: { id: 7 } }],
      executedToolRefs: [{ internalId: 'read-tool', version: '1.0.0', publishName: 'read_tool' }],
      budget: { remainingModelRounds: 4, remainingToolCalls: 9 },
      step: 2,
      sessionId: 'session-1',
      expiresAt: '2026-07-12T00:00:00.000Z',
      prompt: 'Approval required: write_tool',
    };
    const record = waitRunForApproval(
      startRun({ runId: 'run-waiting', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.2.0' }, startedAt: 'now' }),
      checkpoint,
      { trace: [
        { sequence: 1, kind: 'model-request', step: 1, toolNames: ['write_tool'] },
        { sequence: 2, kind: 'approval-requested', tool: 'write_tool', sideEffect: 'write', prompt: 'Approval required: write_tool' },
        { sequence: 3, kind: 'approval-resolved', decision: 'approve' },
      ], usage: { totalTokens: 6 }, response: checkpoint.prompt },
    );
    expect(deserializeRun(JSON.parse(JSON.stringify(serializeRun(record))))).toEqual(record);
  });

  it('waiting-approval以外がcheckpointを持つrecordを拒否する', () => {
    const record = startRun({ runId: 'run-bad', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent' }, startedAt: 'now' });
    expect(() => deserializeRun({ ...record, checkpoint: {
      kind: 'tool-approval', agentRef: { internalId: 'agent', version: '1.0.0' }, messages: [], pendingCalls: [], executedToolRefs: [],
      budget: { remainingModelRounds: 1, remainingToolCalls: 1 }, step: 1, expiresAt: 'x', prompt: 'p',
    } })).toThrow(/waiting-approval/);
  });

  it('ツール実行由来の失敗（tool / nodeId）と mcp-server-skipped を往復し、それらを持たない旧recordも読める', () => {
    const started = startRun({ runId: 'run-failed', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: 'now' });
    const tool = { internalId: 'score-tool', version: '1.2.0', publishName: 'score_lookup' };
    const message = 'select: column(s) not found: revenue';
    const record = failRun(started, {
      trace: [
        { sequence: 1, kind: 'mcp-server-skipped', server: 'ghost', reason: 'not-found' },
        { sequence: 2, kind: 'mcp-server-skipped', server: 'broken', reason: 'unreachable', detail: 'failed to start' },
        { sequence: 3, kind: 'error', code: 'ETL_SCHEMA', message, tool, nodeId: 'pick' },
      ],
      failure: { code: 'ETL_SCHEMA', message, tool, nodeId: 'pick' },
      completedAt: 'later',
    });
    expect(deserializeRun(JSON.parse(JSON.stringify(serializeRun(record))))).toEqual(record);

    // 旧record: tool / nodeId を持たない error イベントと failure はそのまま読める。
    const legacy = failRun(started, { trace: [{ sequence: 1, kind: 'error', code: 'X', message: 'bad' }], failure: { code: 'X', message: 'bad' }, completedAt: 'later' });
    expect(deserializeRun(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);

    // 未知の reason は拒否する。
    expect(() => deserializeRun({ ...record, trace: [{ sequence: 1, kind: 'mcp-server-skipped', server: 'x', reason: 'bogus' }] })).toThrow();
  });

  it('正常: 0行の理由（tool-result.noMatch）を往復し、それを持たない旧traceもそのまま読める', () => {
    const started = startRun({ runId: 'run-nomatch', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: 'now' });
    const noMatch = {
      message: 'No rows matched.',
      nodeId: 'narrow',
      combine: 'and' as const,
      conditions: [
        { column: '時点', op: 'eq', argument: 'time_point', value: '2015年12月31日', matchingRows: 0, availableValues: ['2015年', '2016年'], distinctValues: 2 },
        { column: '人口', op: 'gte', value: 100, matchingRows: 3, min: 1, max: 9 },
      ],
    };
    const record = failRun(started, {
      trace: [{ sequence: 1, kind: 'tool-result', name: 'get_population_data', terminalId: 'narrow', nodes: [{ nodeId: 'narrow', rowCount: 0, truncated: false }], outputPreview: [], noMatch }],
      failure: { code: 'X', message: 'bad' },
      completedAt: 'later',
    });
    expect(deserializeRun(JSON.parse(JSON.stringify(serializeRun(record))))).toEqual(record);

    // 旧record: noMatch を持たない tool-result はそのまま読める。
    const legacy = failRun(started, { trace: [{ sequence: 1, kind: 'tool-result', name: 't', terminalId: 'n', nodes: [], outputPreview: [] }], failure: { code: 'X', message: 'bad' }, completedAt: 'later' });
    expect(deserializeRun(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);

    // 内訳の形が壊れたもの（件数が数値でない）は拒否する。
    expect(() => deserializeRun({ ...serializeRun(record), trace: [{ sequence: 1, kind: 'tool-result', name: 't', terminalId: 'n', nodes: [], outputPreview: [], noMatch: { ...noMatch, conditions: [{ column: 'x', op: 'eq', value: null, matchingRows: 'many' }] } }] })).toThrow();
  });

  it('正常: 複数値条件の内訳（values / unmatchedValues）も往復し、壊れた形は拒否する', () => {
    const started = startRun({ runId: 'run-in', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: 'now' });
    const noMatch = {
      message: 'No rows matched.',
      nodeId: 'narrow',
      combine: 'and' as const,
      conditions: [
        { column: '地域', op: 'in', argument: 'regions', value: null, values: ['東京市', '大阪市'], matchingRows: 0, unmatchedValues: ['東京市', '大阪市'], availableValues: ['東京都'], distinctValues: 3 },
      ],
    };
    const record = failRun(started, {
      trace: [{ sequence: 1, kind: 'tool-result', name: 'get_population', terminalId: 'narrow', nodes: [{ nodeId: 'narrow', rowCount: 0, truncated: false }], outputPreview: [], noMatch }],
      failure: { code: 'X', message: 'bad' },
      completedAt: 'later',
    });
    expect(deserializeRun(JSON.parse(JSON.stringify(serializeRun(record))))).toEqual(record);

    // 値の並びに object のような運べない値が混ざったものは拒否する。
    expect(() => deserializeRun({ ...serializeRun(record), trace: [{ sequence: 1, kind: 'tool-result', name: 't', terminalId: 'n', nodes: [], outputPreview: [], noMatch: { ...noMatch, conditions: [{ column: 'x', op: 'in', value: null, values: [{}], matchingRows: 0 }] } }] })).toThrow();
  });

  it('error イベント / failure / tool 参照の未知キーは捨てて読み、識別の型が壊れたものは拒否する', () => {
    const started = startRun({ runId: 'run-x', scope: { tenantId: 't', workspaceId: 'w' }, mode: 'preview', agent: { internalId: 'agent', version: '1.0.0' }, startedAt: 'now' });
    // version / publishName を省略した tool 参照も往復する（キーは生えない）。
    const tool = { internalId: 'score-tool' };
    const record = failRun(started, { trace: [{ sequence: 1, kind: 'error', code: 'X', message: 'bad', tool, nodeId: 'n' }], failure: { code: 'X', message: 'bad', tool, nodeId: 'n' }, completedAt: 'later' });
    const roundTripped = deserializeRun(JSON.parse(JSON.stringify(serializeRun(record))));
    expect(roundTripped).toEqual(record);
    expect(roundTripped.failure?.tool).toEqual({ internalId: 'score-tool' });

    // 未知キー（将来の追加・手編集）は strict に拒否せず落として読む。
    const withExtra = {
      ...record,
      trace: [{ sequence: 1, kind: 'error', code: 'X', message: 'bad', tool: { internalId: 'score-tool', extra: true }, nodeId: 'n', extra: 1 }],
      failure: { code: 'X', message: 'bad', tool: { internalId: 'score-tool', extra: true }, nodeId: 'n', extra: 'x' },
    };
    const stripped = deserializeRun(JSON.parse(JSON.stringify(withExtra)));
    expect(stripped).toEqual(record);
    expect(Object.hasOwn(stripped.failure ?? {}, 'extra')).toBe(false);
    expect(Object.hasOwn(stripped.failure?.tool ?? {}, 'extra')).toBe(false);

    // 識別の型が壊れているものは読まない（internalId 空文字・nodeId 非文字列・internalId 欠落・detail 非文字列・server 欠落）。
    expect(() => deserializeRun({ ...record, failure: { code: 'X', message: 'bad', tool: { internalId: '' } } })).toThrow();
    expect(() => deserializeRun({ ...record, failure: { code: 'X', message: 'bad', nodeId: 7 } })).toThrow();
    expect(() => deserializeRun({ ...record, trace: [{ sequence: 1, kind: 'error', code: 'X', message: 'bad', tool: { version: '1.0.0' } }] })).toThrow();
    expect(() => deserializeRun({ ...record, trace: [{ sequence: 1, kind: 'mcp-server-skipped', server: 'x', reason: 'unreachable', detail: 42 }] })).toThrow();
    expect(() => deserializeRun({ ...record, trace: [{ sequence: 1, kind: 'mcp-server-skipped', reason: 'not-found' }] })).toThrow();
  });
});
