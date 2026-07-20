import { expect } from 'vitest';
import { beginFactoryRun, cancelFactoryRun, DEFAULT_FACTORY_OPTIONS, startFactoryRun, type FactoryRun } from '../../domain/factory/factory-run';
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

  // tenant isolation on find + missing run
  expect(await repo.find({ tenantId: 'other', workspaceId: 'w' }, 'first')).toBeNull();
  expect(await repo.find(scope, 'missing')).toBeNull();
}
