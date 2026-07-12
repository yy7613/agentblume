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
});

