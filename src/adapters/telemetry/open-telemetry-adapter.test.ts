import { describe, expect, it } from 'vitest';
import { OpenTelemetryAdapter } from './open-telemetry-adapter';

describe('OpenTelemetryAdapter', () => {
  it('SDK provider/exporter未登録でも成功・失敗spanを安全に終了できる', () => {
    const adapter = new OpenTelemetryAdapter('test-tracer', '1.0.0');
    const success = adapter.startSpan('agent.run', { 'run.id': 'run-1', sampled: true });
    expect(() => { success.setAttribute('run.status', 'succeeded'); success.end(); }).not.toThrow();
    const failure = adapter.startSpan('model.complete');
    expect(() => failure.end(new Error('provider failed'))).not.toThrow();
    expect(() => adapter.startSpan('tool.execute').end('failed')).not.toThrow();
  });
});

