import type { TenantScope } from '../tool/ids';

export type HarnessRunMode = 'preview' | 'test';
export type HarnessRunStatus = 'running' | 'succeeded' | 'failed' | 'waiting-input' | 'waiting-approval' | 'cancelled';
export type HarnessEventKind = 'harness_started' | 'harness_completed' | 'harness_failed' | 'participant_started' | 'participant_completed' | 'participant_failed' | 'intermediate_output' | 'input_requested' | 'checkpoint_saved';
export interface HarnessEvent {
  readonly sequence: number;
  readonly kind: HarnessEventKind;
  readonly at: string;
  readonly slotId?: string;
  readonly childRunId?: string;
  readonly message?: string;
}
export interface HarnessRunRecord {
  readonly runId: string;
  readonly scope: TenantScope;
  readonly harness: { readonly internalId: string; readonly version: string; readonly displayName: string };
  readonly mode: HarnessRunMode;
  readonly status: HarnessRunStatus;
  readonly message: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly response?: string;
  readonly failure?: { readonly code: string; readonly message: string };
  readonly events: readonly HarnessEvent[];
}
export function startHarnessRun(input: Omit<HarnessRunRecord, 'status' | 'events'>): HarnessRunRecord {
  return { ...input, scope: { ...input.scope }, harness: { ...input.harness }, status: 'running', events: [] };
}
export function appendHarnessEvent(record: HarnessRunRecord, event: Omit<HarnessEvent, 'sequence'>): HarnessRunRecord {
  return { ...record, events: [...record.events, { ...event, sequence: record.events.length + 1 }] };
}
export function succeedHarnessRun(record: HarnessRunRecord, response: string, completedAt: string): HarnessRunRecord {
  if (record.status !== 'running') throw new Error(`Harness run '${record.runId}' is already ${record.status}`);
  return { ...record, status: 'succeeded', response, completedAt };
}
export function failHarnessRun(record: HarnessRunRecord, failure: { readonly code: string; readonly message: string }, completedAt: string): HarnessRunRecord {
  if (record.status !== 'running') throw new Error(`Harness run '${record.runId}' is already ${record.status}`);
  return { ...record, status: 'failed', failure: { ...failure }, completedAt };
}
