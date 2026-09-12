import { expect } from 'vitest';
import { appendHarnessEvent, cancelHarnessRun, failHarnessRun, startHarnessRun, succeedHarnessRun, waitForHarnessInput, type HarnessRunRecord } from '../../domain/harness/harness-run';
import type { HarnessRunRepository } from '../../domain/harness/harness-run-repository';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function running(runId: string, startedAt: string, tenant = scope): HarnessRunRecord {
  return startHarnessRun({
    runId, scope: tenant, harness: { internalId: 'harness', version: '1.0.0', displayName: 'Harness' },
    mode: 'preview', message: 'go', startedAt,
  });
}

/**
 * `HarnessRunRepository` の共有契約。in-memory / sqlite の両実装へ同じ検証を当てる。
 * 横断クエリ（`listAllByStatus`）は起動時の孤児Run回収が使うため、両実装で同じ答えでなければならない。
 */
export async function harnessRunRepositoryContract(repo: HarnessRunRepository): Promise<void> {
  const first = running('run-1', '2026-07-03T00:00:00.000Z');
  const second = running('run-2', '2026-07-03T00:00:02.000Z');
  const hidden = running('run-hidden', '2026-07-03T00:00:03.000Z', { tenantId: 'other', workspaceId: 'workspace' });
  await repo.save(first); await repo.save(second); await repo.save(hidden);

  await expect(repo.find(scope, 'run-1')).resolves.toMatchObject({ runId: 'run-1', status: 'running' });
  await expect(repo.find({ tenantId: 'other', workspaceId: 'workspace' }, 'run-1')).resolves.toBeNull();
  expect((await repo.list(scope)).map((record) => record.runId)).toEqual(['run-2', 'run-1']);
  expect((await repo.list(scope, { limit: 1 })).map((record) => record.runId)).toEqual(['run-2']);

  // 待機中のRunは checkpoint ごと往復する（プロセスをまたいで再開できることが前提）。
  const waiting = waitForHarnessInput(second, 'need input', {
    kind: 'handoff-input', activeSlotId: 'a', history: [{ role: 'user', content: 'go' }],
    budget: { remainingModelRounds: 2, remainingToolCalls: 3, remainingParticipantRuns: 1 },
    expiresAt: '2026-07-04T00:00:00.000Z', prompt: 'need input',
  });
  await repo.save(waiting);
  await expect(repo.find(scope, 'run-2')).resolves.toMatchObject({ status: 'waiting-input', checkpoint: { kind: 'handoff-input', activeSlotId: 'a' } });
  expect((await repo.list(scope, { status: 'running' })).map((record) => record.runId)).toEqual(['run-1']);

  // listAllByStatus: スコープ境界を越え、startedAt 昇順で返す（起動時の孤児Run回収が使う）。
  expect((await repo.listAllByStatus('running')).map((record) => record.runId)).toEqual(['run-1', 'run-hidden']);
  // waiting-* は正常な待機状態であり、running とは必ず区別できなければならない（回収対象外）。
  expect((await repo.listAllByStatus('waiting-input')).map((record) => record.runId)).toEqual(['run-2']);
  expect(await repo.listAllByStatus('cancelled')).toEqual([]);

  await repo.save(succeedHarnessRun(first, 'done', '2026-07-03T00:01:00.000Z'));
  await repo.save(failHarnessRun(hidden, { code: 'BOOM', message: 'boom' }, '2026-07-03T00:01:01.000Z'));
  expect(await repo.listAllByStatus('running')).toEqual([]);
  await expect(repo.find(scope, 'run-1')).resolves.toMatchObject({ status: 'succeeded', response: 'done' });
  await expect(repo.find(scope, 'missing')).resolves.toBeNull();
}

/**
 * `saveIfStatus`（compare-and-set）の共有契約。worker の進捗保存と cancel() は同じ行を取り合うので、
 * 「期待状態のときだけ書く・それ以外は一切書かない」を両実装で同じ答えにしなければならない。
 * 境界・異常系: 未知の run、空の expected、状態不一致、複数の期待状態、終端の蘇生、スコープ隔離。
 */
export async function harnessRunRepositoryCompareAndSetContract(repo: HarnessRunRepository): Promise<void> {
  const other = { tenantId: 'other', workspaceId: 'workspace' };
  const started = running('run-cas', '2026-07-03T00:00:00.000Z');
  await repo.save(started);
  await repo.save(running('run-cas', '2026-07-03T00:00:00.000Z', other));
  const withEvent = appendHarnessEvent(started, { kind: 'harness_started', at: '2026-07-03T00:00:00.500Z' });

  // 未知の run: 何も書かず false（挿入にもならない）。
  expect(await repo.saveIfStatus(running('run-missing', '2026-07-03T00:00:00.000Z'), ['running'])).toBe(false);
  await expect(repo.find(scope, 'run-missing')).resolves.toBeNull();

  // expected が空: 常に false で、行は不変。
  expect(await repo.saveIfStatus(withEvent, [])).toBe(false);
  await expect(repo.find(scope, 'run-cas')).resolves.toMatchObject({ status: 'running', events: [] });

  // 期待状態の不一致: false で、行は不変。
  expect(await repo.saveIfStatus(withEvent, ['waiting-input', 'cancelled'])).toBe(false);
  await expect(repo.find(scope, 'run-cas')).resolves.toMatchObject({ status: 'running', events: [] });

  // 期待状態の一致: true で、行が更新される。
  expect(await repo.saveIfStatus(withEvent, ['running'])).toBe(true);
  await expect(repo.find(scope, 'run-cas')).resolves.toMatchObject({ status: 'running', events: [{ kind: 'harness_started', sequence: 1 }] });

  // 複数の期待状態: 現在状態がそのどれかなら書ける（cancel() が running / waiting-* をまとめて狙う形）。
  const waiting = waitForHarnessInput(withEvent, 'need input', {
    kind: 'handoff-input', activeSlotId: 'a', history: [],
    budget: { remainingModelRounds: 1, remainingToolCalls: 1, remainingParticipantRuns: 1 },
    expiresAt: '2026-07-04T00:00:00.000Z', prompt: 'need input',
  });
  expect(await repo.saveIfStatus(waiting, ['running', 'waiting-input', 'waiting-approval'])).toBe(true);
  expect(await repo.saveIfStatus(cancelHarnessRun(waiting, '2026-07-03T00:01:00.000Z'), ['running', 'waiting-input', 'waiting-approval'])).toBe(true);
  await expect(repo.find(scope, 'run-cas')).resolves.toMatchObject({ status: 'cancelled', completedAt: '2026-07-03T00:01:00.000Z' });

  // 終端は蘇らない: running を期待する worker の遅い書き込みは拒まれ、行は cancelled のまま。
  expect(await repo.saveIfStatus(succeedHarnessRun(withEvent, 'late', '2026-07-03T00:02:00.000Z'), ['running'])).toBe(false);
  const settled = await repo.find(scope, 'run-cas');
  expect(settled?.status).toBe('cancelled');
  // 待機時の応答はそのまま、遅い succeed の 'late' には置き換わっていない。
  expect(settled?.response).toBe('need input');
  // status 列も同時に更新されている（一覧・横断クエリが CAS の結果を見る）。
  expect((await repo.list(scope, { status: 'cancelled' })).map((record) => record.runId)).toEqual(['run-cas']);
  expect((await repo.list(scope, { status: 'running' })).map((record) => record.runId)).toEqual([]);

  // スコープ隔離: 同じ runId の別テナント行は一切触られていない。
  await expect(repo.find(other, 'run-cas')).resolves.toMatchObject({ status: 'running', events: [] });
  expect((await repo.listAllByStatus('running')).map((record) => record.scope.tenantId)).toEqual(['other']);
}
