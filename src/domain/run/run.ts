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

export interface RunArtifactRef {
  readonly internalId: string;
  readonly version?: string;
  readonly publishName?: string;
}

export interface RunRecord {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly status: RunStatus;
  readonly mode: RunMode;
  readonly tool?: RunArtifactRef;
  readonly tools?: readonly RunArtifactRef[];
  readonly agent?: RunArtifactRef;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage?: RunUsage;
  readonly failure?: RunFailure;
}

export interface StartRunProps {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly mode: RunMode;
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly agent?: RunRecord['agent'];
  readonly startedAt: string;
}

export function startRun(props: StartRunProps): RunRecord {
  return {
    ...props,
    scope: { ...props.scope },
    ...(props.tool !== undefined ? { tool: { ...props.tool } } : {}),
    ...(props.tools !== undefined ? { tools: props.tools.map((tool) => ({ ...tool })) } : {}),
    ...(props.agent !== undefined ? { agent: { ...props.agent } } : {}),
    status: 'running',
    trace: [],
  };
}

export function succeedRun(record: RunRecord, result: {
  readonly tool?: RunRecord['tool'];
  readonly tools?: RunRecord['tools'];
  readonly agent?: RunRecord['agent'];
  readonly response: string;
  readonly structuredResponse?: Readonly<Record<string, unknown>>;
  readonly trace: readonly RunTraceEvent[];
  readonly usage: RunUsage;
  readonly completedAt: string;
}): RunRecord {
  assertRunning(record);
  return {
    ...record,
    status: 'succeeded',
    ...(result.tool !== undefined ? { tool: { ...result.tool } } : {}),
    ...(result.tools !== undefined ? { tools: result.tools.map((tool) => ({ ...tool })) } : {}),
    ...(result.agent !== undefined ? { agent: { ...result.agent } } : {}),
    response: result.response,
    ...(result.structuredResponse !== undefined ? { structuredResponse: structuredClone(result.structuredResponse) } : {}),
    trace: structuredClone(result.trace),
    usage: { ...result.usage },
    completedAt: result.completedAt,
  };
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
