import type { TenantScope } from '../tool/ids';

export type HarnessRunMode = 'preview' | 'test';
export type HarnessRunStatus = 'running' | 'succeeded' | 'failed' | 'waiting-input' | 'waiting-approval' | 'cancelled';
export type HarnessEventKind = 'harness_started' | 'harness_resumed' | 'harness_completed' | 'harness_failed' | 'harness_cancelled' | 'participant_started' | 'participant_completed' | 'participant_failed' | 'intermediate_output' | 'handoff_requested' | 'speaker_selected' | 'plan_created' | 'plan_revised' | 'approval_requested' | 'progress_updated' | 'stall_detected' | 'input_requested' | 'checkpoint_saved';
export interface HarnessEvent {
  readonly sequence: number;
  readonly kind: HarnessEventKind;
  readonly at: string;
  readonly slotId?: string;
  readonly childRunId?: string;
  readonly message?: string;
}

/** Interactive runtimeで再開可能な会話の最小履歴。Agent runtime固有の型に依存しない。 */
export interface HarnessConversationMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** Checkpointに保存する共有実行予算。再開後も同じ上限を消費する。 */
export interface HarnessRunBudgetCheckpoint {
  readonly remainingModelRounds: number;
  readonly remainingToolCalls: number;
  readonly remainingParticipantRuns: number;
}

export interface HandoffInputCheckpoint {
  readonly kind: 'handoff-input';
  readonly activeSlotId: string;
  readonly history: readonly HarnessConversationMessage[];
  readonly budget: HarnessRunBudgetCheckpoint;
  readonly expiresAt: string;
  readonly prompt: string;
}

export interface MagenticApprovalCheckpoint {
  readonly kind: 'magentic-approval';
  readonly managerSlotId: string;
  readonly selectedSlotId: string;
  readonly instruction: string;
  readonly history: readonly HarnessConversationMessage[];
  readonly round: number;
  readonly stalls: number;
  readonly resets: number;
  readonly latest: string;
  readonly budget: HarnessRunBudgetCheckpoint;
  readonly expiresAt: string;
  readonly plan: string;
}

export type HarnessRunCheckpoint = HandoffInputCheckpoint | MagenticApprovalCheckpoint;

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
  /** waiting-* 状態だけで保持する、再開に必要な永続実行コンテキスト。 */
  readonly checkpoint?: HarnessRunCheckpoint;
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
export function waitForHarnessInput(record: HarnessRunRecord, response: string, checkpoint: HandoffInputCheckpoint): HarnessRunRecord {
  if (record.status !== 'running') throw new Error(`Harness run '${record.runId}' is already ${record.status}`);
  return { ...record, status: 'waiting-input', response, checkpoint: cloneCheckpoint(checkpoint) };
}
export function waitForHarnessApproval(record: HarnessRunRecord, response: string, checkpoint: MagenticApprovalCheckpoint): HarnessRunRecord {
  if (record.status !== 'running') throw new Error(`Harness run '${record.runId}' is already ${record.status}`);
  return { ...record, status: 'waiting-approval', response, checkpoint: cloneCheckpoint(checkpoint) };
}
export function resumeHarnessRun(record: HarnessRunRecord): HarnessRunRecord {
  if (record.status !== 'waiting-input' && record.status !== 'waiting-approval') throw new Error(`Harness run '${record.runId}' is not waiting for interaction`);
  return { ...record, status: 'running', checkpoint: undefined };
}
export function cancelHarnessRun(record: HarnessRunRecord, completedAt: string): HarnessRunRecord {
  if (record.status === 'succeeded' || record.status === 'failed' || record.status === 'cancelled') throw new Error(`Harness run '${record.runId}' is already ${record.status}`);
  return { ...record, status: 'cancelled', checkpoint: undefined, completedAt };
}

function cloneCheckpoint(checkpoint: HarnessRunCheckpoint): HarnessRunCheckpoint {
  return {
    ...checkpoint,
    history: checkpoint.history.map((message) => ({ ...message })),
    budget: { ...checkpoint.budget },
  };
}
