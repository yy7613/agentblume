import type { TelemetryPort, TelemetrySpan } from '../../application/operations/telemetry';

const span: TelemetrySpan = { setAttribute: () => {}, end: () => {} };

export class NoopTelemetryAdapter implements TelemetryPort {
  startSpan(): TelemetrySpan { return span; }
}

