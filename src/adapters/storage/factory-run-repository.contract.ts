import { expect } from 'vitest';
import { appendFactoryEvent, beginFactoryRun, cancelFactoryRun, DEFAULT_FACTORY_OPTIONS, startFactoryRun, type FactoryRun } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';

const scope = { tenantId: 't', workspaceId: 'w' };
function make(id: string, startedAt: string, tenant = scope): FactoryRun {
  return startFactoryRun({
    id,
    scope: tenant,
    input: { goal: { goal: '売上について質問に答えるアシスタントが欲しい', language: 'ja' }, dataSourceIds: ['ds-1'], options: DEFAULT_FACTORY_OPTIONS },
    startedAt,
  });
}

export async function factoryRunRepositoryContract(repo: FactoryRunRepository): Promise<void> {
  const first = make('first', '2026-07-10T00:00:00Z');
  const second = make('second', '2026-07-10T00:00:02Z');
  const hidden = make('hidden', '2026-07-10T00:00:03Z', { tenantId: 'other', workspaceId: 'w' });
  await repo.save(first); await repo.save(second); await repo.save(hidden);

  // list: DESC by startedAt, tenant isolation
  expect((await repo.list(scope)).map((run) => run.id)).toEqual(['second', 'first']);
  expect((await repo.list({ tenantId: 'other', workspaceId: 'w' })).map((run) => run.id)).toEqual(['hidden']);

  // upsert-on-save: saving again with an updated status must be reflected on find/list
  const running = beginFactoryRun(first);
  await repo.save(running);
  expect(await repo.find(scope, 'first')).toMatchObject({ status: 'running' });
  expect(await repo.list(scope)).toHaveLength(2);

  // status filtering
  expect((await repo.list(scope, { status: 'running' })).map((run) => run.id)).toEqual(['first']);
  expect((await repo.list(scope, { status: 'queued' })).map((run) => run.id)).toEqual(['second']);

  // limit
  expect((await repo.list(scope, { limit: 1 })).map((run) => run.id)).toEqual(['second']);

  const cancelled = cancelFactoryRun(running, '2026-07-10T00:10:00Z');
  await repo.save(cancelled);
  expect(await repo.find(scope, 'first')).toMatchObject({ status: 'cancelled', finishedAt: '2026-07-10T00:10:00Z' });

  // listAllByStatus: 起動時の孤児Run回収が使う横断クエリ。テナント境界を越え、startedAt 昇順で返す
  // （回収は「このプロセスが持っていた全ジョブ」が対象なので、スコープで絞ってはならない）。
  expect((await repo.listAllByStatus('queued')).map((run) => run.id)).toEqual(['second', 'hidden']);
  expect((await repo.listAllByStatus('cancelled')).map((run) => run.id)).toEqual(['first']);
  expect(await repo.listAllByStatus('running')).toEqual([]);

  // tenant isolation on find + missing run
  expect(await repo.find({ tenantId: 'other', workspaceId: 'w' }, 'first')).toBeNull();
  expect(await repo.find(scope, 'missing')).toBeNull();

  // saveIfStatus（compare-and-set）: worker の進捗保存と cancel の確定が同じ行で競合するための条件付き書き込み。
  // 期待と違う状態 → false で何も書かない（second は queued のまま）。
  const secondRunning = beginFactoryRun(second);
  expect(await repo.saveIfStatus(secondRunning, ['running'])).toBe(false);
  expect(await repo.find(scope, 'second')).toMatchObject({ status: 'queued' });
  // 期待が空 → false で何も書かない（「どの状態でも書く」ではない）。
  expect(await repo.saveIfStatus(secondRunning, [])).toBe(false);
  expect(await repo.find(scope, 'second')).toMatchObject({ status: 'queued' });
  // 期待に含まれる → true で書く（status 列も更新され、status フィルタに反映される）。
  expect(await repo.saveIfStatus(secondRunning, ['queued', 'running'])).toBe(true);
  expect(await repo.find(scope, 'second')).toMatchObject({ status: 'running' });
  expect((await repo.list(scope, { status: 'running' })).map((run) => run.id)).toEqual(['second']);
  // 同じ状態のまま中身だけ更新する（イベント追記）も、期待にその状態を含めれば通る。
  const withEvent = appendFactoryEvent(secondRunning, { kind: 'stage_started', at: '2026-07-10T00:01:00Z', stage: 'profiling' });
  expect(await repo.saveIfStatus(withEvent, ['running'])).toBe(true);
  expect((await repo.find(scope, 'second'))?.events).toHaveLength(1);
  // cancel が先に終端へ確定させた後は、running を期待する worker の保存は通らず、記録は cancelled のまま。
  const secondCancelled = cancelFactoryRun(withEvent, '2026-07-10T00:02:00Z');
  expect(await repo.saveIfStatus(secondCancelled, ['queued', 'running', 'waiting-approval'])).toBe(true);
  const staleEvent = appendFactoryEvent(withEvent, { kind: 'stage_completed', at: '2026-07-10T00:03:00Z', stage: 'profiling' });
  expect(await repo.saveIfStatus(staleEvent, ['running'])).toBe(false);
  expect(await repo.find(scope, 'second')).toMatchObject({ status: 'cancelled', finishedAt: '2026-07-10T00:02:00Z' });
  expect((await repo.find(scope, 'second'))?.events).toHaveLength(1);
  // 終端からの再 cancel も通らない（期待に終端を含めない限り上書きしない）。
  expect(await repo.saveIfStatus(secondCancelled, ['queued', 'running', 'waiting-approval'])).toBe(false);
  // 未知の id → false で行を作らない（upsert ではない）。
  expect(await repo.saveIfStatus(make('ghost', '2026-07-10T00:00:05Z'), ['queued'])).toBe(false);
  expect(await repo.find(scope, 'ghost')).toBeNull();
  // スコープ分離: 別テナントの同名 id は対象にならず、自テナントの行だけが書き換わる。
  expect(await repo.saveIfStatus(beginFactoryRun(make('hidden', '2026-07-10T00:00:03Z')), ['queued'])).toBe(false);
  expect(await repo.find({ tenantId: 'other', workspaceId: 'w' }, 'hidden')).toMatchObject({ status: 'queued' });
  expect(await repo.saveIfStatus(beginFactoryRun(hidden), ['queued'])).toBe(true);
  expect(await repo.find({ tenantId: 'other', workspaceId: 'w' }, 'hidden')).toMatchObject({ status: 'running' });
  expect(await repo.find(scope, 'hidden')).toBeNull();
}
