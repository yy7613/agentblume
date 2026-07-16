import { randomUUID } from 'node:crypto';
import { DEFAULT_MODEL_ROUNDS_BUDGET, DEFAULT_TOOL_CALLS_BUDGET, type AgentHistoryMessage, type RunAgentPreviewUseCase, type RunBudget } from '../agent/run-agent-preview';
import type { AgentHarness, AgentSlot } from '../../domain/harness/agent-harness';
import type { AgentHarnessRepository } from '../../domain/harness/harness-repository';
import { appendHarnessEvent, failHarnessRun, startHarnessRun, succeedHarnessRun, type HarnessEvent, type HarnessRunMode, type HarnessRunRecord } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';
import { HarnessNotFoundError, HarnessRunError, HarnessRunNotFoundError } from '../../domain/harness/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import { RunFailedError } from '../agent/errors';

export interface StartHarnessRunInput { readonly scope: TenantScope; readonly harnessId: string; readonly version?: SemVer; readonly message: string; readonly mode: HarnessRunMode; }
interface ParticipantResult { readonly slot: AgentSlot; readonly response?: string; readonly childRunId?: string; readonly error?: string; }
interface SharedHarnessBudget { remainingModelRounds: number; remainingToolCalls: number; }
type AppendEvent = (event: Omit<HarnessEvent, 'sequence'>) => Promise<void>;

export class RunHarnessUseCase {
  constructor(private readonly harnesses: AgentHarnessRepository, private readonly runs: HarnessRunRepository, private readonly agents: RunAgentPreviewUseCase, private readonly makeId: () => string = randomUUID, private readonly now: () => Date = () => new Date()) {}
  async execute(input: StartHarnessRunInput, signal?: AbortSignal): Promise<HarnessRunRecord> {
    const harness = input.version === undefined ? await this.harnesses.findLatest(input.scope, input.harnessId) : await this.harnesses.findVersion(input.scope, input.harnessId, input.version);
    if (harness === null) throw new HarnessNotFoundError(`Harness not found: ${input.harnessId}${input.version === undefined ? '' : `@${input.version.toString()}`}`);
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new HarnessRunError(`Harness duration budget exceeded: ${harness.policies.budget.maxDurationMs}ms`)), harness.policies.budget.maxDurationMs);
    try {
      let record = startHarnessRun({ runId: this.makeId(), scope: input.scope, harness: { internalId: harness.metadata.internalId, version: harness.metadata.version.toString(), displayName: harness.metadata.displayName }, mode: input.mode, message: input.message, startedAt: this.now().toISOString() });
      const state = { record, queue: Promise.resolve() };
      const append: AppendEvent = async (event) => {
        state.queue = state.queue.then(async () => { state.record = await this.event(state.record, event); });
        await state.queue;
      };
      await append({ kind: 'harness_started', at: this.now().toISOString() });
      try {
        this.throwIfAborted(controller.signal);
        const response = await this.run(harness, input, controller.signal, append, { remainingModelRounds: harness.policies.budget.maxModelRounds, remainingToolCalls: harness.policies.budget.maxToolCalls });
        await state.queue;
        record = succeedHarnessRun(state.record, response, this.now().toISOString());
        state.record = record;
        await append({ kind: 'harness_completed', at: this.now().toISOString() });
        record = state.record;
        await this.runs.save(record);
        return record;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Harness run failed';
        const code = error instanceof HarnessRunError ? error.code : 'HARNESS_RUN';
        await state.queue;
        record = failHarnessRun(state.record, { code, message }, this.now().toISOString());
        state.record = record;
        await append({ kind: 'harness_failed', at: this.now().toISOString(), message });
        record = state.record;
        await this.runs.save(record);
        return record;
      }
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
  private async run(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    switch (harness.topology.pattern) {
      case 'sequential': return this.sequential(harness, input, signal, append, budget);
      case 'concurrent': return this.concurrent(harness, input, signal, append, budget);
      default: throw new HarnessRunError(`Pattern '${harness.pattern}' is defined but not executable in this release; use sequential or concurrent`);
    }
  }
  private async sequential(harness: AgentHarness, input: StartHarnessRunInput, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget): Promise<string> {
    const topology = harness.topology;
    if (topology.pattern !== 'sequential') throw new HarnessRunError('Invalid sequential topology');
    this.assertParticipantBudget(harness, topology.orderedSlotIds.length);
    const history: AgentHistoryMessage[] = [];
    let previous = '';
    for (const [index, slotId] of topology.orderedSlotIds.entries()) {
      this.throwIfAborted(signal);
      const slot = this.slot(harness, slotId);
      const message = topology.contextMode === 'previous-response' && previous.length > 0
        ? `Original task:\n${input.message}\n\nPrevious participant output:\n${previous}`
        : input.message;
      const result = await this.participant(harness, input, slot, message, topology.contextMode === 'full-conversation' ? history : undefined, signal, append, budget, topology.orderedSlotIds.length - index - 1);
      this.throwIfAborted(signal);
      if (result.error !== undefined) {
        if (harness.policies.failure.mode === 'fail-fast') throw new HarnessRunError(`Sequential participant '${slot.label}' failed: ${result.error}`);
        previous = `[${slot.label} failed: ${result.error}]`;
      } else previous = result.response ?? '';
      if (topology.contextMode === 'full-conversation') {
        history.push({ role: 'assistant', content: `${slot.label}: ${previous}` });
      }
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
        results[index] = await this.participant(harness, input, slots[index]!, input.message, undefined, signal, append, budget, slots.length - index - 1 + needsAggregator);
      }
    });
    await Promise.all(workers);
    this.throwIfAborted(signal);
    const failed = results.filter((result) => result?.error !== undefined);
    if (failed.length > 0 && harness.policies.failure.mode === 'fail-fast') throw new HarnessRunError(`Concurrent participant failed: ${failed[0]!.slot.label}: ${failed[0]!.error}`);
    const collected = results.map((result) => `## ${result.slot.label}\n${result.error === undefined ? result.response ?? '' : `[failed: ${result.error}]`}`).join('\n\n');
    if (topology.aggregation !== 'agent') return collected;
    const aggregator = this.slot(harness, topology.aggregatorSlotId!);
    const summary = await this.participant(harness, input, aggregator, `Original task:\n${input.message}\n\nIndependent participant results (slot order):\n${collected}\n\nSynthesize a final answer.`, undefined, signal, append, budget, 0);
    this.throwIfAborted(signal);
    if (summary.error !== undefined) throw new HarnessRunError(`Aggregator '${aggregator.label}' failed: ${summary.error}`);
    return summary.response ?? '';
  }
  private async participant(harness: AgentHarness, input: StartHarnessRunInput, slot: AgentSlot, message: string, history: readonly AgentHistoryMessage[] | undefined, signal: AbortSignal | undefined, append: AppendEvent, budget: SharedHarnessBudget, futureParticipants: number): Promise<ParticipantResult> {
    try {
      const allocation = this.reserveBudget(budget, futureParticipants);
      await append({ kind: 'participant_started', at: this.now().toISOString(), slotId: slot.id });
      const run = await this.agents.executeSaved({ scope: input.scope, agentId: slot.assignment.internalId, version: slot.assignment.version, message, mode: input.mode, purpose: 'interactive', ...(history === undefined ? {} : { history }), budget: allocation }, signal);
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
  private async event(record: HarnessRunRecord, event: Parameters<typeof appendHarnessEvent>[1]): Promise<HarnessRunRecord> { const next = appendHarnessEvent(record, event); await this.runs.save(next); return next; }
  private assertParticipantBudget(harness: AgentHarness, count: number): void { if (count > harness.policies.budget.maxParticipantRuns) throw new HarnessRunError(`Harness participant budget exceeded: requires ${count}, maximum ${harness.policies.budget.maxParticipantRuns}`); }
  private slot(harness: AgentHarness, id: string): AgentSlot { const slot = harness.slots.find((item) => item.id === id); if (slot === undefined) throw new HarnessRunError(`Harness topology references unknown slot '${id}'`); return slot; }
  private reserveBudget(shared: SharedHarnessBudget, futureParticipants: number): Pick<RunBudget, 'remainingModelRounds' | 'remainingToolCalls'> {
    if (shared.remainingModelRounds < 1) throw new HarnessRunError('Harness model-round budget exhausted before participant start');
    // 後続slotへ最低1 roundずつ残す。全slotへ配り切れないときも、順序どおりに
    // 先行slotを開始し、残余slotは明示的なbudget failureとして記録する。
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
  async get(scope: TenantScope, runId: string): Promise<HarnessRunRecord> { const run = await this.repo.find(scope, runId); if (run === null) throw new HarnessRunNotFoundError(`Harness run not found: ${runId}`); return run; }
}

function summarize(value: string): string { return value.length > 500 ? `${value.slice(0, 500)}…` : value; }
