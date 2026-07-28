import { describe, expect, it, vi } from 'vitest';
import type { TelemetryPort } from './telemetry';
import { safeStartSpan } from './telemetry';

describe('safeStartSpan', () => {
  it('start/set/endの各exporter障害を呼び出し側へ伝播させない', () => {
    const port = { startSpan: vi.fn(() => ({ setAttribute: () => { throw new Error('set failed'); }, end: () => { throw new Error('end failed'); } })) } as TelemetryPort;
    const span = safeStartSpan(port, 'agent.run');
    expect(() => span.setAttribute('run.status', 'ok')).not.toThrow();
    expect(() => span.end()).not.toThrow();
    const startFailure = safeStartSpan({ startSpan: () => { throw new Error('offline'); } }, 'agent.run');
    expect(() => startFailure.end()).not.toThrow();
  });

  it('握り潰したexporter障害をloggerへ残す（無音だと「トレースが1本も出ない」ことに気づけない）', () => {
    const warns: { message: string; context?: Record<string, unknown> }[] = [];
    const logger = { info: () => {}, warn: (message: string, context?: Record<string, unknown>) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); }, error: () => {} };
    const port = { startSpan: vi.fn(() => ({ setAttribute: () => { throw new Error('set failed'); }, end: () => { throw new Error('end failed'); } })) } as TelemetryPort;

    const span = safeStartSpan(port, 'agent.run', undefined, logger);
    span.setAttribute('run.status', 'ok');
    span.end();
    safeStartSpan({ startSpan: () => { throw new Error('offline'); } }, 'tool.execute', undefined, logger);

    expect(warns).toEqual([
      { message: 'telemetry span attribute was dropped', context: { span: 'agent.run', attribute: 'run.status', reason: 'set failed' } },
      { message: 'telemetry span end was dropped', context: { span: 'agent.run', reason: 'end failed' } },
      { message: 'telemetry span could not be started', context: { span: 'tool.execute', reason: 'offline' } },
    ]);
  });

  it('port未配線ならloggerを渡しても何も起きない', () => {
    const logger = { info: () => {}, warn: () => { throw new Error('must not be called'); }, error: () => {} };
    expect(() => { safeStartSpan(undefined, 'agent.run', undefined, logger).end(); }).not.toThrow();
  });
});

