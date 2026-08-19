import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL_ROUNDS_BUDGET, DEFAULT_TOOL_CALLS_BUDGET, type AgentHistoryMessage, type RunAgentPreviewUseCase, type RunBudget } from '../agent/run-agent-preview';
import type { AgentSubAgentRef } from '../../domain/agent/agent';
import type { AgentHarness, AgentSlot } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository } from '../../domain/harness/harness-repository';
import {
  appendHarnessEvent,
  cancelHarnessRun,
  failHarnessRun,
  resumeHarnessRun,
  startHarnessRun,
  succeedHarnessRun,
  waitForHarnessApproval,
  waitForHarnessInput,
  type HarnessConversationMessage,
  type HarnessEvent,
  type HarnessRunBudgetCheckpoint,
  type HarnessRunCheckpoint,
  type HarnessRunMode,
  type HarnessRunRecord,
  type MagenticApprovalCheckpoint,
} from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import { HarnessNotFoundError, HarnessRunError, HarnessRunNotFoundError } from '../../domain/harness/errors';
import type { HarnessId, HarnessRunId, SlotId } from '../../domain/harness/ids';
import type { RunId } from '../../domain/run/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { SemVer, type SemVer as SemVerType } from '../../domain/tool/semver';
import { RunFailedError } from '../agent/errors';

const INTERACTIVE_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1_000;

export interface StartHarnessRunInput {
  readonly scope: TenantScope;
  readonly harnessId: HarnessId;
  readonly version?: SemVerType;
  readonly message: string;
  readonly mode: HarnessRunMode;
}
export type HarnessInteractionResponse =
  | { readonly kind: 'input'; readonly message: string }
  | { readonly kind: 'approval'; readonly decision: 'approve' | 'revise' | 'reject'; readonly feedback?: string };
export interface ResumeHarnessRunInput {
  readonly scope: TenantScope;
  readonly runId: HarnessRunId;
  readonly response: HarnessInteractionResponse;
}
interface ParticipantResult {
  readonly slot: AgentSlot;
  readonly response?: string;
  readonly childRunId?: RunId;
  readonly error?: string;
}
interface SharedHarnessBudget {
  remainingModelRounds: number;
  remainingToolCalls: number;
  remainingParticipantRuns: number;
}
interface HandoffResumeState {
  readonly checkpoint: Extract<HarnessRunCheckpoint, { readonly kind: 'handoff-input' }>;
  readonly response: Extract<HarnessInteractionResponse, { readonly kind: 'input' }>;
  readonly lastResponse: string;
}
interface MagenticResumeState {
  readonly checkpoint: MagenticApprovalCheckpoint;
  readonly response: Extract<HarnessInteractionResponse, { readonly kind: 'approval' }>;
}
type AppendEvent = (event: Omit<HarnessEvent, 'sequence'>) => Promise<void>;

/** Internal control-flow signal. A pause is a durable state transition, not a failed run. */
class HarnessPause extends Error {
  constructor(readonly status: 'waiting-input' | 'waiting-approval', readonly response: string, readonly checkpoint: HarnessRunCheckpoint) {
    super(`Harness waiting for ${status === 'waiting-input' ? 'input' : 'approval'}`);
  }
}

export class RunHarnessUseCase {
  constructor(
    private readonly harnesses: AgentHarnessRepository,
    private readonly runs: HarnessRunRepository,
    private readonly agents: RunAgentPreviewUseCase,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: StartHarnessRunInput, signal?: AbortSignal): Promise<HarnessRunRecord> {
    const harness = await this.findHarness(input.scope, input.harnessId, input.version);
    const record = startHarnessRun({
      runId: this.makeId(),
      scope: input.scope,
      harness: { internalId: harness.metadata.internalId, version: harness.metadata.version.toString(), displayName: harness.metadata.displayName },
      mode: input.mode,
      message: input.message,
      startedAt: this.now().toISOString(),
    });
    return this.executeRecord(harness, record, input, undefined, signal);
  }

  /**
   * 同一runIdを再開する。checkpointはJSON永続化済みなので、プロセスをまたいでも再開できる。
   * rejectは再計画ではなく監査可能なcancelとして確定する。再計画にはreviseを使う。
   */
  async resume(input: ResumeHarnessRunInput, signal?: AbortSignal): Promise<HarnessRunRecord> {
    const stored = await this.runs.find(input.scope, input.runId);
    if (stored === null) throw new HarnessRunNotFoundError(`Harness run not found: ${input.runId}`);
    const checkpoint = stored.checkpoint;
    if (checkpoint === undefined || (stored.status !== 'waiting-input' && stored.status !== 'waiting-approval')) throw new HarnessRunError(`Harness run '${input.runId}' is not waiting for interaction`);
    if (Date.parse(checkpoint.expiresAt) <= this.now().getTime()) throw new HarnessRunError(`Harness run '${input.runId}' checkpoint expired at ${checkpoint.expiresAt}`);
    if (checkpoint.kind === 'handoff-input' && input.response.kind !== 'input') throw new HarnessRunError(`Harness run '${input.runId}' is waiting for conversation input`);
    if (checkpoint.kind === 'magentic-approval' && input.response.kind !== 'approval') throw new HarnessRunError(`Harness run '${input.runId}' is waiting for plan approval`);

    if (checkpoint.kind === 'magentic-approval' && input.response.kind === 'approval' && input.response.decision === 'reject') {
      let cancelled = cancelHarnessRun(stored, this.now().toISOString());
      cancelled = await this.event(cancelled, { kind: 'harness_cancelled', at: this.now().toISOString(), slotId: checkpoint.managerSlotId, message: input.response.feedback?.trim() || 'Magentic plan rejected by reviewer' });
      return cancelled;
    }

    const harness = await this.findHarness(stored.scope, stored.harness.internalId, SemVer.parse(stored.harness.version));
    const record = resumeHarnessRun(stored);
    const original: StartHarnessRunInput = { scope: stored.scope, harnessId: stored.harness.internalId, version: harness.metadata.version, message: stored.message, mode: stored.mode };
    if (checkpoint.kind === 'handoff-input' && input.response.kind === 'input') {
      return this.executeRecord(harness, record, original, { checkpoint, response: input.response, lastResponse: stored.response ?? '' }, signal);
    }
    return this.executeRecord(harness, record, original, { checkpoint: checkpoint as MagenticApprovalCheckpoint, response: input.response as Extract<HarnessInteractionResponse, { readonly kind: 'approval' }> }, signal);
  }

  async cancel(scope: TenantScope, runId: HarnessRunId): Promise<HarnessRunRecord> {
    const stored = await this.runs.find(scope, runId);
    if (stored === null) throw new HarnessRunNotFoundError(`Harness run not found: ${runId}`);
    let cancelled = cancelHarnessRun(stored, this.now().toISOString());
    cancelled = await this.event(cancelled, { kind: 'harness_cancelled', at: this.now().toISOString(), message: 'Cancelled by user' });
    return cancelled;
  }

  private async executeRecord(
    harness: AgentHarness,
    initialRecord: HarnessRunRecord,
    input: StartHarnessRunInput,
    resume: HandoffResumeState | MagenticResumeState | undefined,
    signal?: AbortSignal,
  ): Promise<HarnessRunRecord> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new HarnessRunError(`Harness duration budget exceeded: ${harness.policies.budget.maxDurationMs}ms`)), harness.policies.budget.maxDurationMs);
    try {
      const state: { record: HarnessRunRecord; queue: Promise<void> } = { record: initialRecord, queue: Promise.resolve() };
      const append: AppendEvent = async (event) => {
        state.queue = state.queue.then(async () => { state.record = await this.event(state.record, event); });
        await state.queue;
      };
      await append({ kind: resume === undefined ? 'harness_started' : 'harness_resumed', at: this.now().toISOString(), ...(resume === undefined ? {} : { message: 'Interactive checkpoint resumed' }) });
      const budget = resume === undefined ? this.initialBudget(harness) : this.budgetFromCheckpoint(resume.checkpoint.budget);
      try {
        this.throwIfAborted(controller.signal);
        const response = await this.run(harness, input, controller.signal, append, budget, resume);
        await state.queue;
        state.record = succeedHarnessRun(state.record, response, this.now().toISOString());
        await append({ kind: 'harness_completed', at: this.now().toISOString() });
        return state.record;
      } catch (error) {
        if (error instanceof HarnessPause) {
          await state.queue;
          state.record = error.status === 'waiting-input'
            ? waitForHarnessInput(state.record, error.response, error.checkpoint as Extract<HarnessRunCheckpoint, { readonly kind: 'handoff-input' }>)
            : waitForHarnessApproval(state.record, error.response, error.checkpoint as MagenticApprovalCheckpoint);
          const checkpointSlotId = error.checkpoint.kind === 'handoff-input' ? error.checkpoint.activeSlotId : error.checkpoint.managerSlotId;
          await append({ kind: 'checkpoint_saved', at: this.now().toISOString(), slotId: checkpointSlotId, message: `expires ${error.checkpoint.expiresAt}` });
          return state.record;
        }
        const message = error instanceof Error ? error.message : 'Harness run failed';
        const code = error instanceof HarnessRunError ? error.code : 'HARNESS_RUN';
        await state.queue;
        state.record = failHarnessRun(state.record, { code, message }, this.now().toISOString());
        await append({ kind: 'harness_failed', at: this.now().toISOString(), message });
        return state.record;
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }

  private async findHarness(scope: TenantScope, harnessId: HarnessId, version: SemVerType | undefined): Promise<AgentHarness> {
    const harness = version === undefined ? await this.harnesses.findLatest(scope, harnessId) : await this.harnesses.findVersion(scope, harnessId, version);
    if (harness === null) throw new HarnessNotFoundError(`Harness not found: ${harnessId}${version === undefined ? '' : `@${version.toString()}`}`);
    return harness;
  }

  private async run(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget, resume: HandoffResumeState | MagenticResumeState | undefined): Promise<string> {
    switch (harness.topology.pattern) {
      case 'agent-as-tools':
        if (resume !== undefined) throw new HarnessRunError('This harness pattern does not support interactive resume');
        return this.agentAsTools(harness, input, signal, append, budget);
      case 'sequential':
        if (resume !== undefined) throw new HarnessRunError('This harness pattern does not support interactive resume');
        return this.sequential(harness, input, signal, append, budget);
      case 'concurrent':
        if (resume !== undefined) throw new HarnessRunError('This harness pattern does not support interactive resume');
        return this.concurrent(harness, input, signal, append, budget);
      case 'handoff': return this.handoff(harness, input, signal, append, budget, resume as HandoffResumeState | undefined);
      case 'group-chat':
        if (resume !== undefined) throw new HarnessRunError('This harness pattern does not support interactive resume');
        return this.groupChat(harness, input, signal, append, budget);
      case 'magentic': return this.magentic(harness, input, signal, append, budget, resume as MagenticResumeState | undefined);
    }
  }

  private async agentAsTools(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'agent-as-tools') throw new HarnessRunError('Invalid agent-as-tools topology');
    this.assertParticipantBudget(harness, 1 + topology.participantSlotIds.length);
    const coordinator = this.slot(harness, topology.coordinatorSlotId);
    const delegates: AgentSubAgentRef[] = topology.participantSlotIds.map((slotId) => {
      const slot = this.slot(harness, slotId);
      return { internalId: slot.assignment.internalId, version: slot.assignment.version, usage: `${slot.label}: ${slot.purpose}` };
    });
    const result = await this.participant(harness, input, coordinator, `${input.message}\n\nYou are the coordinator. Delegate to the assigned specialists only when their expertise is needed, then provide the final answer.`, undefined, signal, append, budget, 0, delegates);
    this.throwIfAborted(signal);
    if (result.error !== undefined) throw new HarnessRunError(`Coordinator '${coordinator.label}' failed: ${result.error}`);
    return result.response ?? '';
  }

  private async sequential(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'sequential') throw new HarnessRunError('Invalid sequential topology');
    this.assertParticipantBudget(harness, topology.orderedSlotIds.length);
    const history: AgentHistoryMessage[] = [];
    let previous = '';
    for (const slotId of topology.orderedSlotIds) {
      this.throwIfAborted(signal);
      const slot = this.slot(harness, slotId);
      const message = topology.contextMode === 'previous-response' && previous.length > 0
        ? `Original task:\n${input.message}\n\nPrevious participant output:\n${previous}`
        : input.message;
      const result = await this.participant(harness, input, slot, message, topology.contextMode === 'full-conversation' ? history : undefined, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      this.throwIfAborted(signal);
      if (result.error !== undefined) {
        if (harness.policies.failure.mode === 'fail-fast') throw new HarnessRunError(`Sequential participant '${slot.label}' failed: ${result.error}`);
        previous = `[${slot.label} failed: ${result.error}]`;
      } else previous = result.response ?? '';
      if (topology.contextMode === 'full-conversation') history.push({ role: 'assistant', content: `${slot.label}: ${previous}` });
    }
    return previous;
  }

  private async concurrent(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'concurrent') throw new HarnessRunError('Invalid concurrent topology');
    const needsAggregator = topology.aggregation === 'agent' ? 1 : 0;
    this.assertParticipantBudget(harness, topology.participantSlotIds.length + needsAggregator);
    const slots = topology.participantSlotIds.map((id) => this.slot(harness, id));
    const results: ParticipantResult[] = new Array(slots.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(harness.policies.budget.maxParallelism, slots.length) }, async () => {
      while (true) {
        this.throwIfAborted(signal);
        const index = cursor++;
        if (index >= slots.length) return;
        results[index] = await this.participant(harness, input, slots[index]!, input.message, undefined, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      }
    });
    await Promise.all(workers);
    this.throwIfAborted(signal);
    const failed = results.filter((result) => result?.error !== undefined);
    if (failed.length > 0 && harness.policies.failure.mode === 'fail-fast') throw new HarnessRunError(`Concurrent participant failed: ${failed[0]!.slot.label}: ${failed[0]!.error}`);
    const collected = results.map((result) => `## ${result.slot.label}\n${result.error === undefined ? result.response ?? '' : `[failed: ${result.error}]`}`).join('\n\n');
    if (topology.aggregation === 'collect') return collected;
    if (topology.aggregation === 'vote') return voteResult(results, collected);
    const aggregator = this.slot(harness, topology.aggregatorSlotId!);
    const summary = await this.participant(harness, input, aggregator, `Original task:\n${input.message}\n\nIndependent participant results (slot order):\n${collected}\n\nSynthesize a final answer.`, undefined, signal, append, budget, 0);
    this.throwIfAborted(signal);
    if (summary.error !== undefined) throw new HarnessRunError(`Aggregator '${aggregator.label}' failed: ${summary.error}`);
    return summary.response ?? '';
  }

  private async handoff(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget, resume: HandoffResumeState | undefined): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'handoff') throw new HarnessRunError('Invalid handoff topology');
    this.assertParticipantBudget(harness, harness.policies.budget.maxParticipantRuns);
    const history: HarnessConversationMessage[] = resume === undefined ? [] : [...resume.checkpoint.history];
    let current = resume === undefined ? this.slot(harness, topology.startSlotId) : this.slot(harness, resume.checkpoint.activeSlotId);
    let last = resume?.lastResponse ?? '';
    let userMessage = resume?.response.message ?? input.message;
    while (budget.remainingParticipantRuns > 0) {
      this.throwIfAborted(signal);
      const allowed = topology.transitions.filter((transition) => transition.fromSlotId === current.id);
      const directions = allowed.length === 0
        ? 'No handoff targets are available. Finish with the final answer.'
        : `You may transfer ownership only by ending your answer with [[handoff:<slot-id>]]. Allowed targets: ${allowed.map((transition) => `${transition.toSlotId} (${transition.condition})`).join(', ')}.`;
      const message = `Original task:\n${input.message}\n\nLatest user message:\n${userMessage}\n\n${directions}`;
      const result = await this.participant(harness, input, current, message, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      this.throwIfAborted(signal);
      if (result.error !== undefined) throw new HarnessRunError(`Handoff participant '${current.label}' failed: ${result.error}`);
      last = stripControlMarkers(result.response ?? '');
      history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: `${current.label}: ${last}` });
      const targetId = controlTarget(result.response ?? '', 'handoff');
      if (targetId === undefined) {
        if (topology.autonomous) return last;
        const prompt = `${current.label} is waiting for the next user message.`;
        await append({ kind: 'input_requested', at: this.now().toISOString(), slotId: current.id, childRunId: result.childRunId, message: prompt });
        throw new HarnessPause('waiting-input', last, {
          kind: 'handoff-input',
          activeSlotId: current.id,
          history,
          budget: this.checkpointBudget(budget),
          expiresAt: this.checkpointExpiry(),
          prompt,
        });
      }
      if (!allowed.some((transition) => transition.toSlotId === targetId)) throw new HarnessRunError(`Handoff '${current.id}' requested disallowed target '${targetId}'`);
      await append({ kind: 'handoff_requested', at: this.now().toISOString(), slotId: current.id, childRunId: result.childRunId, message: `${current.id} -> ${targetId}` });
      current = this.slot(harness, targetId);
      userMessage = 'Continue the task using the conversation so far.';
    }
    throw new HarnessRunError(`Handoff participant budget exhausted after ${harness.policies.budget.maxParticipantRuns} turns`);
  }

  private async groupChat(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'group-chat') throw new HarnessRunError('Invalid group-chat topology');
    const participantSlots = topology.participantSlotIds.map((id) => this.slot(harness, id));
    const manager = topology.managerSlotId === undefined ? undefined : this.slot(harness, topology.managerSlotId);
    const maximumRuns = topology.maxRounds * (topology.selector === 'agent' ? 2 : 1);
    this.assertParticipantBudget(harness, maximumRuns);
    const history: AgentHistoryMessage[] = [];
    let last = '';
    for (let round = 0; round < topology.maxRounds; round += 1) {
      this.throwIfAborted(signal);
      let speaker: AgentSlot;
      let instruction = input.message;
      if (topology.selector === 'agent') {
        if (manager === undefined) throw new HarnessRunError('Group chat agent selector requires manager slot');
        const selection = await this.participant(harness, input, manager, `Choose the next speaker for this group discussion. Respond with [[speaker:<slot-id>]] followed by an optional focused instruction. Available speakers: ${participantSlots.map((slot) => `${slot.id} (${slot.purpose})`).join(', ')}.\n\nTask:\n${input.message}`, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
        if (selection.error !== undefined) throw new HarnessRunError(`Group manager '${manager.label}' failed: ${selection.error}`);
        const speakerId = controlTarget(selection.response ?? '', 'speaker');
        if (speakerId === undefined || !participantSlots.some((slot) => slot.id === speakerId)) throw new HarnessRunError(`Group manager selected unknown speaker '${speakerId ?? '(missing)'}'`);
        speaker = this.slot(harness, speakerId);
        instruction = stripControlMarkers(selection.response ?? '').trim() || input.message;
      } else speaker = participantSlots[round % participantSlots.length]!;
      await append({ kind: 'speaker_selected', at: this.now().toISOString(), slotId: speaker.id, message: `round ${round + 1}` });
      const result = await this.participant(harness, input, speaker, `Task:\n${input.message}\n\nDiscussion instruction:\n${instruction}`, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      this.throwIfAborted(signal);
      if (result.error !== undefined) throw new HarnessRunError(`Group participant '${speaker.label}' failed: ${result.error}`);
      last = stripControlMarkers(result.response ?? '');
      history.push({ role: 'assistant', content: `${speaker.label}: ${last}` });
      await append({ kind: 'progress_updated', at: this.now().toISOString(), slotId: speaker.id, childRunId: result.childRunId, message: `round ${round + 1}: ${summarize(last)}` });
      if (hasControl(result.response ?? '', 'final')) return last;
    }
    return last;
  }

  private async magentic(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget, resume: MagenticResumeState | undefined): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'magentic') throw new HarnessRunError('Invalid magentic topology');
    const manager = this.slot(harness, topology.managerSlotId);
    const participants = topology.participantSlotIds.map((id) => this.slot(harness, id));
    const maximumRuns = topology.maxRounds * 2 + 1;
    this.assertParticipantBudget(harness, maximumRuns);
    const history: HarnessConversationMessage[] = resume === undefined ? [] : [...resume.checkpoint.history];
    let round = resume?.checkpoint.round ?? 0;
    let stalls = resume?.checkpoint.stalls ?? 0;
    let resets = resume?.checkpoint.resets ?? 0;
    let latest = resume?.checkpoint.latest ?? '';

    if (resume !== undefined) {
      if (resume.response.decision === 'revise') {
        const feedback = resume.response.feedback?.trim() || 'Revise the plan before executing it.';
        history.push({ role: 'user', content: `Human reviewer requested a revision: ${feedback}` });
        await append({ kind: 'plan_revised', at: this.now().toISOString(), slotId: manager.id, message: feedback });
      } else {
        const selected = this.slot(harness, resume.checkpoint.selectedSlotId);
        await append({ kind: 'speaker_selected', at: this.now().toISOString(), slotId: selected.id, message: `approved Magentic round ${round + 1}` });
        const result = await this.participant(harness, input, selected, `Task:\n${input.message}\n\nApproved manager instruction:\n${resume.checkpoint.instruction}`, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
        if (result.error !== undefined) throw new HarnessRunError(`Magentic participant '${selected.label}' failed: ${result.error}`);
        latest = stripControlMarkers(result.response ?? '');
        history.push({ role: 'assistant', content: `${selected.label}: ${latest}` });
        await append({ kind: 'progress_updated', at: this.now().toISOString(), slotId: selected.id, childRunId: result.childRunId, message: summarize(latest) });
        round += 1;
      }
    }

    while (round < topology.maxRounds) {
      this.throwIfAborted(signal);
      const planning = await this.participant(harness, input, manager, `You are the Magentic manager. Maintain an explicit, concise progress ledger and choose one next participant. Respond with either [[delegate:<slot-id>]] followed by that participant's instruction, or [[final]] followed by the final answer. Available participants: ${participants.map((slot) => `${slot.id} (${slot.purpose})`).join(', ')}.\n\nTask:\n${input.message}`, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      if (planning.error !== undefined) throw new HarnessRunError(`Magentic manager '${manager.label}' failed: ${planning.error}`);
      const managerOutput = planning.response ?? '';
      const ledgerEntry = stripControlMarkers(managerOutput);
      const hadPlan = history.some((message) => message.role === 'assistant' && message.content.startsWith(`${manager.label} plan:`));
      await append({ kind: hadPlan ? 'plan_revised' : 'plan_created', at: this.now().toISOString(), slotId: manager.id, childRunId: planning.childRunId, message: summarize(ledgerEntry) });
      if (hasControl(managerOutput, 'final')) return ledgerEntry;
      if (ledgerEntry !== '') history.push({ role: 'assistant', content: `${manager.label} plan: ${ledgerEntry}` });
      const delegateId = controlTarget(managerOutput, 'delegate');
      if (delegateId === undefined || !participants.some((slot) => slot.id === delegateId)) {
        stalls += 1;
        await append({ kind: 'stall_detected', at: this.now().toISOString(), slotId: manager.id, childRunId: planning.childRunId, message: `round ${round + 1}: manager did not select an allowed participant` });
        if (stalls > topology.maxStalls) {
          resets += 1;
          if (resets > topology.maxResets) throw new HarnessRunError(`Magentic reset budget exhausted after ${resets} resets`);
          stalls = 0;
          await append({ kind: 'plan_revised', at: this.now().toISOString(), slotId: manager.id, message: `automatic replan ${resets}` });
        }
        continue;
      }
      stalls = 0;
      const participant = this.slot(harness, delegateId);
      const instruction = ledgerEntry.trim() || input.message;
      if (topology.requirePlanSignoff) {
        const plan = `Delegate ${participant.label} (${participant.id})\n\n${instruction}`;
        await append({ kind: 'approval_requested', at: this.now().toISOString(), slotId: manager.id, childRunId: planning.childRunId, message: plan });
        throw new HarnessPause('waiting-approval', plan, {
          kind: 'magentic-approval',
          managerSlotId: manager.id,
          selectedSlotId: participant.id,
          instruction,
          history,
          round,
          stalls,
          resets,
          latest,
          budget: this.checkpointBudget(budget),
          expiresAt: this.checkpointExpiry(),
          plan,
        });
      }
      await append({ kind: 'speaker_selected', at: this.now().toISOString(), slotId: participant.id, childRunId: planning.childRunId, message: `magentic round ${round + 1}` });
      const result = await this.participant(harness, input, participant, `Task:\n${input.message}\n\nManager instruction:\n${instruction}`, history, signal, append, budget, Math.max(0, budget.remainingParticipantRuns - 1));
      if (result.error !== undefined) throw new HarnessRunError(`Magentic participant '${participant.label}' failed: ${result.error}`);
      latest = stripControlMarkers(result.response ?? '');
      history.push({ role: 'assistant', content: `${participant.label}: ${latest}` });
      await append({ kind: 'progress_updated', at: this.now().toISOString(), slotId: participant.id, childRunId: result.childRunId, message: summarize(latest) });
      round += 1;
    }
    const synthesis = await this.participant(harness, input, manager, `Synthesize the final answer from this completed Magentic progress ledger. Do not delegate further.\n\nTask:\n${input.message}`, history, signal, append, budget, 0);
    if (synthesis.error !== undefined) throw new HarnessRunError(`Magentic final synthesis failed: ${synthesis.error}`);
    return stripControlMarkers(synthesis.response ?? latest);
  }

  private async participant(harness: AgentHarness, input: StartHarnessRunInput, slot: AgentSlot, message: string, history: readonly AgentHistoryMessage[] | undefined, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget, futureParticipants: number, additionalAgents?: readonly AgentSubAgentRef[]): Promise<ParticipantResult> {
    try {
      this.reserveParticipant(budget);
      const allocation = this.reserveBudget(budget, futureParticipants);
      await append({ kind: 'participant_started', at: this.now().toISOString(), slotId: slot.id });
      const run = await this.agents.executeSaved({ scope: input.scope, agentId: slot.assignment.internalId, version: slot.assignment.version, message, mode: input.mode, purpose: 'interactive', ...(history === undefined ? {} : { history }), ...(additionalAgents === undefined ? {} : { additionalAgents }), budget: allocation }, signal);
      await append({ kind: 'participant_completed', at: this.now().toISOString(), slotId: slot.id, childRunId: run.runId });
      await append({ kind: 'intermediate_output', at: this.now().toISOString(), slotId: slot.id, childRunId: run.runId, message: summarize(run.response) });
      return { slot, response: run.response, childRunId: run.runId };
    } catch (error) {
      const childRunId = error instanceof RunFailedError ? error.runId : undefined;
      const message = error instanceof Error ? error.message : 'Participant failed';
      await append({ kind: 'participant_failed', at: this.now().toISOString(), slotId: slot.id, ...(childRunId === undefined ? {} : { childRunId }), message });
      return { slot, ...(childRunId === undefined ? {} : { childRunId }), error: message };
    }
  }

  private initialBudget(harness: AgentHarness): SharedHarnessBudget {
    return { remainingModelRounds: harness.policies.budget.maxModelRounds, remainingToolCalls: harness.policies.budget.maxToolCalls, remainingParticipantRuns: harness.policies.budget.maxParticipantRuns };
  }
  private budgetFromCheckpoint(checkpoint: HarnessRunBudgetCheckpoint): SharedHarnessBudget {
    return { remainingModelRounds: checkpoint.remainingModelRounds, remainingToolCalls: checkpoint.remainingToolCalls, remainingParticipantRuns: checkpoint.remainingParticipantRuns };
  }
  private checkpointBudget(budget: SharedHarnessBudget): HarnessRunBudgetCheckpoint {
    return { remainingModelRounds: budget.remainingModelRounds, remainingToolCalls: budget.remainingToolCalls, remainingParticipantRuns: budget.remainingParticipantRuns };
  }
  private checkpointExpiry(): string { return new Date(this.now().getTime() + INTERACTIVE_CHECKPOINT_TTL_MS).toISOString(); }
  private async event(record: HarnessRunRecord, event: Parameters<typeof appendHarnessEvent>[1]): Promise<HarnessRunRecord> { const next = appendHarnessEvent(record, event); await this.runs.save(next); return next; }
  private assertParticipantBudget(harness: AgentHarness, count: number): void { if (count > harness.policies.budget.maxParticipantRuns) throw new HarnessRunError(`Harness participant budget exceeded: requires ${count}, maximum ${harness.policies.budget.maxParticipantRuns}`); }
  private reserveParticipant(shared: SharedHarnessBudget): void {
    if (shared.remainingParticipantRuns < 1) throw new HarnessRunError('Harness participant budget exhausted before participant start');
    shared.remainingParticipantRuns -= 1;
  }
  private slot(harness: AgentHarness, id: SlotId): AgentSlot { const slot = harness.slots.find((item) => item.id === id); if (slot === undefined) throw new HarnessRunError(`Harness topology references unknown slot '${id}'`); return slot; }
  private reserveBudget(shared: SharedHarnessBudget, futureParticipants: number): Pick<RunBudget, 'remainingModelRounds' | 'remainingToolCalls'> {
    if (shared.remainingModelRounds < 1) throw new HarnessRunError('Harness model-round budget exhausted before participant start');
    const remainingModelRounds = Math.min(Math.max(1, shared.remainingModelRounds - futureParticipants), DEFAULT_MODEL_ROUNDS_BUDGET);
    const remainingToolCalls = Math.min(shared.remainingToolCalls, DEFAULT_TOOL_CALLS_BUDGET);
    shared.remainingModelRounds -= remainingModelRounds;
    shared.remainingToolCalls -= remainingToolCalls;
    return { remainingModelRounds, remainingToolCalls };
  }
  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    throw reason instanceof HarnessRunError ? reason : new HarnessRunError(reason instanceof Error ? reason.message : 'Harness run cancelled');
  }
}

export class QueryHarnessRunsUseCase {
  constructor(private readonly repo: HarnessRunRepository) {}
  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: HarnessRunRecord['status'] }): Promise<HarnessRunRecord[]> { return this.repo.list(scope, options); }
  async get(scope: TenantScope, runId: HarnessRunId): Promise<HarnessRunRecord> { const run = await this.repo.find(scope, runId); if (run === null) throw new HarnessRunNotFoundError(`Harness run not found: ${runId}`); return run; }
}

function summarize(value: string): string { return value.length > 500 ? `${value.slice(0, 500)}…` : value; }
function controlTarget(value: string, kind: 'handoff' | 'speaker' | 'delegate'): string | undefined {
  const match = new RegExp(`\\[\\[${kind}:([^\\]\\s]+)\\]\\]`, 'i').exec(value);
  return match?.[1];
}
function hasControl(value: string, kind: 'final'): boolean { return /\[\[final\]\]/i.test(value); }
function stripControlMarkers(value: string): string { return value.replace(/\[\[(?:handoff|speaker|delegate):[^\]\s]+\]\]|\[\[final\]\]/gi, '').trim(); }
function voteResult(results: readonly ParticipantResult[], collected: string): string {
  const votes = new Map<string, number>();
  const order: string[] = [];
  for (const result of results) {
    if (result.error !== undefined) continue;
    const response = result.response ?? '';
    const vote = /\[\[vote:([^\]]+)\]\]/i.exec(response)?.[1]?.trim() || response.split(/\r?\n/, 1)[0]?.trim() || '(empty)';
    if (!votes.has(vote)) order.push(vote);
    votes.set(vote, (votes.get(vote) ?? 0) + 1);
  }
  if (order.length === 0) return collected;
  const winner = order.reduce((current, candidate) => (votes.get(candidate) ?? 0) > (votes.get(current) ?? 0) ? candidate : current);
  return `Vote winner: ${winner} (${votes.get(winner)} vote${votes.get(winner) === 1 ? '' : 's'})\n\n${collected}`;
}
