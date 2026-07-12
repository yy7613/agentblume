export type TelemetryAttribute = string | number | boolean;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttribute>>;

export interface TelemetrySpan {
  setAttribute(name: string, value: TelemetryAttribute): void;
  end(error?: unknown): void;
}

export interface TelemetryPort {
  startSpan(name: string, attributes?: TelemetryAttributes): TelemetrySpan;
}

const inertSpan: TelemetrySpan = { setAttribute: () => {}, end: () => {} };

/** 観測系障害を業務実行へ伝播させない境界。 */
export function safeStartSpan(port: TelemetryPort | undefined, name: string, attributes?: TelemetryAttributes): TelemetrySpan {
  if (port === undefined) return inertSpan;
  try {
    const span = port.startSpan(name, attributes);
    return {
      setAttribute: (key, value) => { try { span.setAttribute(key, value); } catch { /* exporter failure is non-fatal */ } },
      end: (error) => { try { span.end(error); } catch { /* exporter failure is non-fatal */ } },
    };
  } catch {
    return inertSpan;
  }
}

