import type { RunFailure, RunTraceEvent } from '../../domain/run/run';

const SECRET_KEY = /password|secret|token|api[-_]?key|authorization/i;

function sanitizeValue(value: unknown, key?: string): unknown {
  if (key !== undefined && SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) output[childKey] = sanitizeValue(child, childKey);
    return output;
  }
  return value;
}

export function sanitizeRunTrace(trace: readonly RunTraceEvent[]): RunTraceEvent[] {
  return sanitizeValue(trace) as RunTraceEvent[];
}

export function failureFrom(error: unknown): RunFailure {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL', message: 'internal error' };
}
