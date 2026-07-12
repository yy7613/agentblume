import { expect } from 'vitest';
import type { JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationAssetVersionConflictError } from '../../domain/evaluation/errors';
import { createJudgeRubric } from '../../domain/evaluation/judge-rubric';
import { SemVer } from '../../domain/tool/semver';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const rubric = (version: SemVer) => createJudgeRubric({ metadata: { internalId: 'quality', workingName: 'Quality', displayName: `Quality ${version}`, publishName: 'quality', version, owner: 'owner', state: 'draft', tenant: scope }, instructions: 'Judge.', referencePolicy: 'optional', reasonRequired: true, criteria: [{ id: 'q', label: 'Q', description: 'Quality', weight: 1, levels: [{ score: 0, label: 'Bad', description: 'Bad' }, { score: 1, label: 'Good', description: 'Good' }] }] });
export async function judgeRubricRepositoryContract(repo: JudgeRubricRepository): Promise<void> {
  const v1 = SemVer.of(1, 0, 0); const v2 = SemVer.of(1, 1, 0); await repo.save(rubric(v2)); await repo.save(rubric(v1));
  expect((await repo.findLatest(scope, 'quality'))?.metadata.version).toEqual(v2); expect(await repo.findVersion(scope, 'quality', v1)).toEqual(rubric(v1)); expect((await repo.listVersions(scope, 'quality')).map(String)).toEqual(['1.0.0', '1.1.0']);
  expect(await repo.list(scope)).toEqual([{ internalId: 'quality', displayName: 'Quality 1.1.0', publishName: 'quality', latestVersion: v2, state: 'draft', criterionCount: 1 }]);
  await expect(repo.save(rubric(v1))).rejects.toBeInstanceOf(EvaluationAssetVersionConflictError); expect(await repo.findLatest({ tenantId: 'other', workspaceId: 'workspace' }, 'quality')).toBeNull();
}
