import { expect } from 'vitest';
import { failHarnessRun, startHarnessRun, succeedHarnessRun, waitForHarnessInput, type HarnessRunRecord } from '../../domain/harness/harness-run';
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
