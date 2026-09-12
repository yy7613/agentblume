import { describe, expect, it } from 'vitest';
import { HarnessRunError } from './errors';
import {
  appendHarnessEvent,
  cancelHarnessRun,
  failHarnessRun,
  isTerminalHarnessRunStatus,
  startHarnessRun,
  succeedHarnessRun,
  waitForHarnessApproval,
  waitForHarnessInput,
  type HarnessEventKind,
  type HarnessRunRecord,
  type HarnessRunStatus,
} from './harness-run';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-08-01T00:00:01.000Z';

function running(): HarnessRunRecord {
  return startHarnessRun({ runId: 'run-1', scope, harness: { internalId: 'harness', version: '1.0.0', displayName: 'Harness' }, mode: 'preview', message: 'go', startedAt: '2026-08-01T00:00:00.000Z' });
}
function waitingInput(): HarnessRunRecord {
  return waitForHarnessInput(running(), 'need input', { kind: 'handoff-input', activeSlotId: 'writer', history: [], budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 }, expiresAt: '2026-08-02T00:00:00.000Z', prompt: 'need input' });
}
function waitingApproval(): HarnessRunRecord {
  return waitForHarnessApproval(running(), 'plan', { kind: 'magentic-approval', managerSlotId: 'manager', selectedSlotId: 'writer', instruction: 'do', history: [], round: 0, stalls: 0, resets: 0, latest: '', budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 }, expiresAt: '2026-08-02T00:00:00.000Z', plan: 'plan' });
}

const TERMINAL_MARKERS = ['harness_completed', 'harness_failed', 'harness_cancelled'] as const;
const PROGRESS_KINDS: readonly HarnessEventKind[] = ['participant_started', 'participant_completed', 'intermediate_output', 'progress_updated', 'checkpoint_saved', 'harness_resumed'];

describe('appendHarnessEvent の終端ガード（異常系: cancel 後に遅れて届く worker のイベント）', () => {
  const terminal: readonly { readonly status: HarnessRunStatus; readonly record: HarnessRunRecord; readonly marker: HarnessEventKind }[] = [
    { status: 'succeeded', record: succeedHarnessRun(running(), 'done', at), marker: 'harness_completed' },
    { status: 'failed', record: failHarnessRun(running(), { code: 'BOOM', message: 'boom' }, at), marker: 'harness_failed' },
    { status: 'cancelled', record: cancelHarnessRun(running(), at), marker: 'harness_cancelled' },
  ];

  for (const { status, record, marker } of terminal) {
    it(`${status} のレコードへ進捗イベントは足せず、HarnessRunError で拒む`, () => {
      for (const kind of PROGRESS_KINDS) {
        expect(() => appendHarnessEvent(record, { kind, at, slotId: 'writer' })).toThrow(HarnessRunError);
      }
      expect(() => appendHarnessEvent(record, { kind: 'intermediate_output', at, slotId: 'writer', message: 'late' }))
        .toThrow(`Harness run 'run-1' is already ${status}; cannot append 'intermediate_output' event`);
      // 拒んだときに元のレコードは汚れていない。
      expect(record.events).toEqual([]);
    });

    it(`${status} のレコードへ自身の終端マーカー（${marker}）だけは足せる`, () => {
      const marked = appendHarnessEvent(record, { kind: marker, at, message: 'settled' });
      expect(marked.events).toEqual([{ kind: marker, at, message: 'settled', sequence: 1 }]);
      expect(marked.status).toBe(status);
    });

    it(`${status} のレコードへ他の終端マーカーは足せない`, () => {
      for (const kind of TERMINAL_MARKERS.filter((candidate) => candidate !== marker)) {
        expect(() => appendHarnessEvent(record, { kind, at })).toThrow(HarnessRunError);
      }
    });
  }

  it('running / waiting-* のレコードへは終端マーカーを含めどのイベントも足せる（ガードは終端だけに効く）', () => {
    for (const record of [running(), waitingInput(), waitingApproval()]) {
      for (const kind of [...PROGRESS_KINDS, ...TERMINAL_MARKERS]) {
        expect(appendHarnessEvent(record, { kind, at }).events.at(-1)).toMatchObject({ kind, sequence: 1 });
      }
    }
  });

  it('連番は追記ごとに増え、元のレコードは変更しない', () => {
    const first = appendHarnessEvent(running(), { kind: 'harness_started', at });
    const second = appendHarnessEvent(first, { kind: 'participant_started', at, slotId: 'writer' });
    expect(second.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.events).toHaveLength(1);
  });
});

describe('isTerminalHarnessRunStatus', () => {
  it('succeeded / failed / cancelled だけを終端と判定する', () => {
    const statuses: readonly HarnessRunStatus[] = ['running', 'succeeded', 'failed', 'waiting-input', 'waiting-approval', 'cancelled'];
    expect(statuses.filter(isTerminalHarnessRunStatus)).toEqual(['succeeded', 'failed', 'cancelled']);
  });
});
