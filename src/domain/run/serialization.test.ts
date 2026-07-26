import { describe, expect, it } from 'vitest';
import { startRun, waitRunForApproval, type RunApprovalCheckpoint } from './run';
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
});
