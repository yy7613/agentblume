import type { TenantScope } from '../tool/ids';

export type RunStatus = 'running' | 'succeeded' | 'failed';
export type RunMode = 'preview' | 'test';

export interface RunNodeOutput {
  readonly nodeId: string;
  readonly rowCount: number;
  readonly truncated: boolean;
}
export type RunTraceEvent =
  | { readonly sequence: number; readonly kind: 'model-request'; readonly step: number; readonly toolNames: readonly string[] }
  | { readonly sequence: number; readonly kind: 'tool-call'; readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }
  | { readonly sequence: number; readonly kind: 'tool-result'; readonly name: string; readonly terminalId: string; readonly nodes: readonly RunNodeOutput[]; readonly outputPreview: readonly Readonly<Record<string, unknown>>[] }
  | { readonly sequence: number; readonly kind: 'model-response'; readonly content: string }
  | { readonly sequence: number; readonly kind: 'error'; readonly code: string; readonly message: string };

export interface RunUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

export interface RunFailure {
  readonly code: string;
  readonly message: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly status: RunStatus;
  readonly mode: RunMode;
  readonly tool: {
    readonly internalId: string;
    readonly version?: string;
    readonly publishName?: string;
  };
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly trace: readonly RunTraceEvent[];
  readonly usage?: RunUsage;
  readonly failure?: RunFailure;
}

export interface StartRunProps {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly mode: RunMode;
  readonly tool: RunRecord['tool'];
  readonly startedAt: string;
}

export function startRun(props: StartRunProps): RunRecord {
  return { ...props, scope: { ...props.scope }, tool: { ...props.tool }, status: 'running', trace: [] };
}

export function succeedRun(record: RunRecord, result: {
  readonly tool: RunRecord['tool'];
  readonly response: string;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
  readonly completedAt: string;
}): RunRecord {
  assertRunning(record);
  return { ...record, status: 'succeeded', tool: { ...result.tool }, response: result.response, trace: structuredClone(result.trace), usage: { ...result.usage }, completedAt: result.completedAt };
}

export function failRun(record: RunRecord, result: {
  readonly trace: readonly RunTraceEvent[];
  readonly failure: RunFailure;
  readonly completedAt: string;
}): RunRecord {
  assertRunning(record);
  return { ...record, status: 'failed', trace: structuredClone(result.trace), failure: { ...result.failure }, completedAt: result.completedAt };
}

function assertRunning(record: RunRecord): void {
  if (record.status !== 'running') throw new Error(`run '${record.runId}' is already ${record.status}`);
}
