import { describe, expect, it } from 'vitest';
import { HarnessValidationError } from './errors';
import {
  appendHarnessEvent,
  cancelHarnessRun,
  failHarnessRun,
  startHarnessRun,
  succeedHarnessRun,
  waitForHarnessApproval,
  waitForHarnessInput,
  type HarnessEvent,
  type HarnessRunRecord,
} from './harness-run';
import { deserializeHarnessRunRecord } from './run-serialization';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function running(runId = 'run-1'): HarnessRunRecord {
  return startHarnessRun({
    runId,
    scope,
    harness: { internalId: 'harness', version: '1.0.0', displayName: 'Harness' },
    mode: 'preview',
    message: 'go',
    startedAt: '2026-08-01T00:00:00.000Z',
  });
}

/** 永続化行の緩い型。テストが個別フィールドを壊したり拡張したりするために使う。 */
interface PersistedRunJson extends Record<string, unknown> {
  events: Record<string, unknown>[];
  checkpoint?: Record<string, unknown>;
}

/** 書き込み側(SqliteHarnessRunRepository.save の JSON.stringify)と同じ経路で永続化表現を作る。 */
function persisted(record: HarnessRunRecord): PersistedRunJson {
  return JSON.parse(JSON.stringify(record));
}

/** 全イベント種を、run-harness.ts が実際に書き込む optional フィールドの組み合わせで網羅する。 */
const EVENT_SAMPLES: readonly Omit<HarnessEvent, 'sequence'>[] = [
  { kind: 'harness_started', at: '2026-08-01T00:00:00.000Z' },
  { kind: 'harness_resumed', at: '2026-08-01T00:00:01.000Z', message: 'resumed' },
  { kind: 'participant_started', at: '2026-08-01T00:00:02.000Z', slotId: 'writer' },
  { kind: 'participant_completed', at: '2026-08-01T00:00:03.000Z', slotId: 'writer', childRunId: 'child-1' },
  { kind: 'participant_failed', at: '2026-08-01T00:00:04.000Z', slotId: 'writer', message: 'boom' },
  { kind: 'intermediate_output', at: '2026-08-01T00:00:05.000Z', slotId: 'writer', childRunId: 'child-1', message: 'draft' },
  { kind: 'handoff_requested', at: '2026-08-01T00:00:06.000Z', slotId: 'writer', childRunId: 'child-1', message: 'writer -> reviewer' },
  { kind: 'speaker_selected', at: '2026-08-01T00:00:07.000Z', slotId: 'reviewer', message: 'round 1' },
  { kind: 'plan_created', at: '2026-08-01T00:00:08.000Z', slotId: 'manager', message: 'the plan' },
  { kind: 'plan_revised', at: '2026-08-01T00:00:09.000Z', slotId: 'manager', message: 'automatic replan 1' },
  { kind: 'approval_requested', at: '2026-08-01T00:00:10.000Z', slotId: 'manager', childRunId: 'child-2', message: 'plan text' },
  { kind: 'progress_updated', at: '2026-08-01T00:00:11.000Z', slotId: 'reviewer', childRunId: 'child-2', message: 'round 1: summary' },
  { kind: 'stall_detected', at: '2026-08-01T00:00:12.000Z', slotId: 'manager', childRunId: 'child-2', message: 'round 2: manager did not select an allowed participant' },
  { kind: 'input_requested', at: '2026-08-01T00:00:13.000Z', slotId: 'writer', childRunId: 'child-3', message: 'Who is the audience?' },
  { kind: 'checkpoint_saved', at: '2026-08-01T00:00:14.000Z', slotId: 'writer', message: 'expires 2026-08-02T00:00:00.000Z' },
  { kind: 'harness_completed', at: '2026-08-01T00:00:15.000Z' },
  { kind: 'harness_failed', at: '2026-08-01T00:00:16.000Z', message: 'failed' },
  { kind: 'harness_cancelled', at: '2026-08-01T00:00:17.000Z', slotId: 'manager', message: 'Cancelled by user' },
];

describe('deserializeHarnessRunRecord', () => {
  it('running(開始直後・optionalなし・events空)を往復できる', () => {
    const record = running();
    expect(deserializeHarnessRunRecord(persisted(record))).toEqual(record);
  });

  it('全イベント種を含む succeeded を往復できる', () => {
    const withEvents = EVENT_SAMPLES.reduce((acc, event) => appendHarnessEvent(acc, event), running());
    const record = succeedHarnessRun(withEvents, 'done', '2026-08-01T00:01:00.000Z');
    const revived = deserializeHarnessRunRecord(persisted(record));
    expect(revived).toEqual(record);
    expect(revived.events).toHaveLength(EVENT_SAMPLES.length);
  });

  it('failed(failure付き)を往復できる', () => {
    const record = failHarnessRun(
      appendHarnessEvent(running('run-failed'), { kind: 'harness_failed', at: '2026-08-01T00:00:16.000Z', message: 'boom' }),
      { code: 'HARNESS_RUN', message: 'boom' },
      '2026-08-01T00:01:00.000Z',
    );
    expect(deserializeHarnessRunRecord(persisted(record))).toEqual(record);
  });

  it('waiting-input(handoff-input checkpoint)を往復できる', () => {
    const record = waitForHarnessInput(running('run-waiting'), 'Who is the audience?', {
      kind: 'handoff-input',
      activeSlotId: 'writer',
      history: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'Who is the audience?' },
      ],
      budget: { remainingModelRounds: 2, remainingToolCalls: 3, remainingParticipantRuns: 1 },
      expiresAt: '2026-08-02T00:00:00.000Z',
      prompt: 'Who is the audience?',
    });
    expect(deserializeHarnessRunRecord(persisted(record))).toEqual(record);
  });

  it('waiting-approval(magentic-approval checkpoint)を往復できる', () => {
    const record = waitForHarnessApproval(running('run-approval'), 'plan ready', {
      kind: 'magentic-approval',
      managerSlotId: 'manager',
      selectedSlotId: 'reviewer',
      instruction: 'review the draft',
      history: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'plan ready' },
      ],
      round: 2,
      stalls: 1,
      resets: 0,
      latest: 'latest output',
      budget: { remainingModelRounds: 4, remainingToolCalls: 8, remainingParticipantRuns: 2 },
      expiresAt: '2026-08-02T00:00:00.000Z',
      plan: 'the plan',
    });
    expect(deserializeHarnessRunRecord(persisted(record))).toEqual(record);
  });

  it('cancelled(checkpoint破棄済み)を往復できる', () => {
    const waiting = waitForHarnessInput(running('run-cancelled'), 'need input', {
      kind: 'handoff-input',
      activeSlotId: 'writer',
      history: [{ role: 'user', content: 'go' }],
      budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 },
      expiresAt: '2026-08-02T00:00:00.000Z',
      prompt: 'need input',
    });
    const record = cancelHarnessRun(waiting, '2026-08-01T00:02:00.000Z');
    expect(deserializeHarnessRunRecord(persisted(record))).toEqual(record);
  });

  it('未知フィールドは拒否せず読み飛ばす(前方互換)', () => {
    const record = waitForHarnessInput(
      appendHarnessEvent(running('run-forward'), { kind: 'harness_started', at: '2026-08-01T00:00:00.000Z' }),
      'need input',
      {
        kind: 'handoff-input',
        activeSlotId: 'writer',
        history: [{ role: 'user', content: 'go' }],
        budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 },
        expiresAt: '2026-08-02T00:00:00.000Z',
        prompt: 'need input',
      },
    );
    const json = persisted(record);
    const extended = {
      ...json,
      futureField: 'ignored',
      events: [{ ...json.events[0], futureEventField: 1 }],
      checkpoint: { ...json.checkpoint, futureCheckpointField: true },
    };
    expect(deserializeHarnessRunRecord(extended)).toEqual(record);
  });

  it('オブジェクトでない値を HarnessValidationError で拒否する', () => {
    expect(() => deserializeHarnessRunRecord(null)).toThrow(HarnessValidationError);
    expect(() => deserializeHarnessRunRecord('{"runId":"x"}')).toThrow(/^deserializeHarnessRunRecord: /);
  });

  it('必須フィールド欠落を経路つきで拒否する', () => {
    const withoutRunId = persisted(running());
    delete withoutRunId['runId'];
    expect(() => deserializeHarnessRunRecord(withoutRunId)).toThrow(HarnessValidationError);
    expect(() => deserializeHarnessRunRecord(withoutRunId)).toThrow(/^deserializeHarnessRunRecord: runId/);
  });

  it('未知の status を拒否する', () => {
    const broken = { ...persisted(running()), status: 'paused' };
    expect(() => deserializeHarnessRunRecord(broken)).toThrow(HarnessValidationError);
    expect(() => deserializeHarnessRunRecord(broken)).toThrow(/^deserializeHarnessRunRecord: status/);
  });

  it('未知のイベント種・不正な sequence を経路つきで拒否する', () => {
    const base = persisted(appendHarnessEvent(running(), { kind: 'harness_started', at: '2026-08-01T00:00:00.000Z' }));
    const badKind = { ...base, events: [{ sequence: 1, kind: 'mystery_event', at: '2026-08-01T00:00:00.000Z' }] };
    expect(() => deserializeHarnessRunRecord(badKind)).toThrow(/^deserializeHarnessRunRecord: events\.0\.kind/);
    const badSequence = { ...base, events: [{ sequence: 'first', kind: 'harness_started', at: '2026-08-01T00:00:00.000Z' }] };
    expect(() => deserializeHarnessRunRecord(badSequence)).toThrow(/^deserializeHarnessRunRecord: events\.0\.sequence/);
  });

  it('checkpoint の不正(未知kind・budget欠落)を拒否する', () => {
    const base = persisted(running());
    const unknownKind = { ...base, status: 'waiting-input', checkpoint: { kind: 'mystery', prompt: 'x' } };
    expect(() => deserializeHarnessRunRecord(unknownKind)).toThrow(HarnessValidationError);
    const missingBudget = {
      ...base,
      status: 'waiting-input',
      checkpoint: { kind: 'handoff-input', activeSlotId: 'writer', history: [], expiresAt: '2026-08-02T00:00:00.000Z', prompt: 'x' },
    };
    expect(() => deserializeHarnessRunRecord(missingBudget)).toThrow(/^deserializeHarnessRunRecord: checkpoint\.budget/);
  });
});
