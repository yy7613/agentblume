import { expect } from 'vitest';
import type { TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import { ValidationDomainError } from '../../domain/validation/errors';
import { createScenarioRun, type ScenarioRun } from '../../domain/validation/scenario-run';
import type { ScenarioRunRepository } from '../../domain/validation/scenario-run-repository';

const scope: TenantScope = { tenantId: 'tenant', workspaceId: 'workspace' };

function run(id: string, startedAt: string, scenarioId = 'scenario-1'): ScenarioRun {
  return createScenarioRun({
    id, scope,
    scenario: { id: scenarioId, version: SemVer.of(1, 0, 0) },
    status: 'completed', goalAchieved: true,
    transcript: [
      { speaker: 'user', message: '質問' },
      { speaker: 'agent', message: '回答', runId: `${id}-agent-1` },
    ],
    survey: [{ questionId: 'q1', value: true }, { questionId: 'impressions', value: '良い' }],
    impressions: '良い',
    metrics: {
      userTurns: 1, agentRuns: 1, totalToolCalls: 1,
      expectedToolHit: { expected: ['sales_summary'], called: ['sales_summary'], hitRate: 1 },
      durationMs: 800, usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
    },
    startedAt, finishedAt: startedAt,
  });
}

/** アンケートだけ回収できなかった実行（会話は成立・理由つき）。 */
function surveyFailedRun(id: string, startedAt: string): ScenarioRun {
  return createScenarioRun({
    ...run(id, startedAt),
    survey: [], impressions: '',
    error: { stage: 'survey', message: "survey answer 'q2' must be between 1 and 5" },
  });
}

export async function scenarioRunRepositoryContract(repo: ScenarioRunRepository): Promise<void> {
  const first = run('run-1', '2026-07-01T00:00:00.000Z');
  const second = run('run-2', '2026-07-01T00:00:02.000Z', 'scenario-2');
  const third = run('run-3', '2026-07-01T00:00:01.000Z');
  await repo.save(first);
  await repo.save(second);
  await repo.save(third);

  // save/find 往復（transcript・survey・metrics まで等価）。
  expect(await repo.find(scope, 'run-1')).toEqual(first);

  // 重複 id は拒否する。
  await expect(repo.save(run('run-1', '2026-07-01T00:00:09.000Z'))).rejects.toBeInstanceOf(ValidationDomainError);

  // list は startedAt の新しい順。filter.scenarioId で絞り込む。
  expect((await repo.list(scope)).map((item) => item.id)).toEqual(['run-2', 'run-3', 'run-1']);
  expect((await repo.list(scope, { scenarioId: 'scenario-1' })).map((item) => item.id)).toEqual(['run-3', 'run-1']);
  expect(await repo.list(scope, { scenarioId: 'missing' })).toEqual([]);

  // 失敗理由（error）も往復する: 「survey が空」だけでは不満な利用者と区別できない。
  const failed = surveyFailedRun('run-4', '2026-07-01T00:00:03.000Z');
  await repo.save(failed);
  const reloaded = await repo.find(scope, 'run-4');
  expect(reloaded).toEqual(failed);
  expect(reloaded?.error).toEqual({ stage: 'survey', message: "survey answer 'q2' must be between 1 and 5" });
  expect(reloaded?.status).toBe('completed');

  // テナント分離。
  expect(await repo.find({ tenantId: 'other', workspaceId: 'workspace' }, 'run-1')).toBeNull();
  expect(await repo.list({ tenantId: 'tenant', workspaceId: 'other' })).toEqual([]);
}
