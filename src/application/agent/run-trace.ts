import type { RunFailure, RunTraceEvent } from '../../domain/run/run';
import { ToolExecutionError } from './errors';

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
  // ツール実行の失敗は「何が起きたか」を元例外から、「どこで起きたか」をラッパーから取る。
  // code/message の決め方（coded なら保持・unknown なら秘匿）を元例外に委ねることで、
  // api/error-mapping が返す HTTP 応答と Run の failure が同じ code/message になる。
  if (error instanceof ToolExecutionError) {
    return { ...failureFrom(error.cause), tool: error.tool, ...(error.nodeId === undefined ? {} : { nodeId: error.nodeId }) };
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { code: error.code, message: error.message };
  }
  return { code: 'INTERNAL', message: 'internal error' };
}
