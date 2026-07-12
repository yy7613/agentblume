import { expect } from 'vitest';
import { createEvaluationDataset } from '../../domain/evaluation/evaluation-dataset';
import { createEvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { EvaluationDatasetRepository, EvaluatorProfileRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import { SemVer } from '../../domain/tool/semver';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const metadata = (id: string, version: SemVer, tenant = scope) => ({ internalId: id, workingName: `${id} draft`, displayName: id, publishName: id.replaceAll('-', '_'), version, owner: 'owner', state: 'draft' as const, tenant });

export async function evaluationAssetRepositoryContract(datasets: EvaluationDatasetRepository, profiles: EvaluatorProfileRepository): Promise<void> {
  const first = createEvaluationDataset({ metadata: metadata('set', SemVer.of(1, 0, 0)), cases: [{ id: 'a', kind: 'turn', input: 'a', tags: [], source: 'manual' }] });
  const second = createEvaluationDataset({ metadata: metadata('set', SemVer.of(1, 1, 0)), cases: [{ id: 'a', kind: 'turn', input: 'b', tags: ['new'], source: 'manual' }] });
  const other = createEvaluationDataset({ metadata: metadata('hidden', SemVer.of(1, 0, 0), { tenantId: 'other', workspaceId: 'workspace' }), cases: [{ id: 'a', kind: 'turn', input: 'x', tags: [], source: 'manual' }] });
  await datasets.save(second); await datasets.save(first); await datasets.save(other);
  expect(await datasets.findVersion(scope, 'set', SemVer.of(1, 0, 0))).toEqual(first);
  expect(await datasets.findLatest(scope, 'set')).toEqual(second);
  expect((await datasets.listVersions(scope, 'set')).map(String)).toEqual(['1.0.0', '1.1.0']);
  expect(await datasets.list(scope)).toEqual([{ internalId: 'set', displayName: 'set', publishName: 'set', latestVersion: SemVer.of(1, 1, 0), state: 'draft', caseCount: 1 }]);
  await expect(datasets.save(first)).rejects.toBeInstanceOf(EvaluationAssetVersionConflictError);

  const p1 = createEvaluatorProfile({ metadata: metadata('profile', SemVer.of(1, 0, 0)), metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }] });
  const p2 = createEvaluatorProfile({ metadata: metadata('profile', SemVer.of(1, 0, 1)), metrics: [{ id: 'coverage', kind: 'code', scorer: 'keyword-coverage', weight: 1, required: true }, { id: 'tone', kind: 'code', scorer: 'tone-consistency', weight: 1, required: false }] });
  await profiles.save(p1); await profiles.save(p2);
  expect(await profiles.findLatest(scope, 'profile')).toEqual(p2);
  expect((await profiles.listVersions(scope, 'profile')).map(String)).toEqual(['1.0.0', '1.0.1']);
  expect(await profiles.list(scope)).toEqual([{ internalId: 'profile', displayName: 'profile', publishName: 'profile', latestVersion: SemVer.of(1, 0, 1), state: 'draft', metricCount: 2 }]);
  await expect(profiles.save(p1)).rejects.toBeInstanceOf(EvaluationAssetVersionConflictError);
}
