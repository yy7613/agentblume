import { describe, expect, it } from 'vitest';
import { startRun } from './run';
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
});
