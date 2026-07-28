import { logSwallowed, type LoggerPort } from './logger';

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

/**
 * 観測系障害を業務実行へ伝播させない境界。
 *
 * 握り潰す方針は変えない（exporterが落ちてAgent実行が失敗するのは本末転倒）。ただし
 * `logger` を渡せば**痕跡だけは残す**。以前は完全に無音で、「トレースが1本も出ていない」ことに
 * 誰も気づけなかった。
 */
export function safeStartSpan(port: TelemetryPort | undefined, name: string, attributes?: TelemetryAttributes, logger?: LoggerPort): TelemetrySpan {
  if (port === undefined) return inertSpan;
  try {
    const span = port.startSpan(name, attributes);
    return {
      setAttribute: (key, value) => { try { span.setAttribute(key, value); } catch (error) { logSwallowed(logger, 'telemetry span attribute was dropped', error, { span: name, attribute: key }); } },
      end: (error) => { try { span.end(error); } catch (failure) { logSwallowed(logger, 'telemetry span end was dropped', failure, { span: name }); } },
    };
  } catch (error) {
    logSwallowed(logger, 'telemetry span could not be started', error, { span: name });
    return inertSpan;
  }
}

