import { SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';
import type { TelemetryAttributes, TelemetryPort, TelemetrySpan } from '../../application/operations/telemetry';

export class OpenTelemetryAdapter implements TelemetryPort {
  private readonly tracer: Tracer;

  constructor(name = 'agentblume.llmops', version = '0.1.0') {
    this.tracer = trace.getTracer(name, version);
  }

  startSpan(name: string, attributes: TelemetryAttributes = {}): TelemetrySpan {
    const span = this.tracer.startSpan(name, { attributes });
    return {
      setAttribute: (key, value) => { span.setAttribute(key, value); },
      end: (error) => {
        if (error !== undefined) {
          span.recordException(error instanceof Error ? error : new Error(String(error)));
          span.setStatus({ code: SpanStatusCode.ERROR });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
      },
    };
  }
}

