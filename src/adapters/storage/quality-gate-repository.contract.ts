import { expect } from 'vitest';
import { createGatePolicy, createGateReport, createPromotionRequest, decidePromotion } from '../../domain/evaluation/quality-gate';
import type { QualityGateRepository } from '../../domain/evaluation/quality-gate-repository';
import { QualityGateConflictError, QualityGateNotFoundError } from '../../domain/evaluation/errors';
import { SemVer } from '../../domain/tool/semver';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' }; const v1 = SemVer.of(1, 0, 0); const v2 = SemVer.of(1, 1, 0);
const policy = (version = v1) => createGatePolicy({ metadata: { internalId: 'release', workingName: 'Release', displayName: `Release ${version}`, publishName: 'release', version, owner: 'owner', state: 'draft', tenant: scope }, rules: [{ id: 'quality', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }], reportTtlHours: 24 });
const report = createGateReport({ id: 'report', scope, policy: { id: 'release', version: v2 }, candidateExperimentId: 'candidate', baselineExperimentId: 'baseline', status: 'pass', ruleResults: [{ ruleId: 'quality', passed: true, observed: 0.9, message: 'pass' }], createdAt: '2026-07-10T00:00:00Z', expiresAt: '2026-07-11T00:00:00Z' });
const promotion = createPromotionRequest({ id: 'promotion', scope, agent: { id: 'agent', version: v1 }, gateReportId: 'report', status: 'pending', requestedBy: 'alice', requestedAt: '2026-07-10T00:00:00Z' });

export async function qualityGateRepositoryContract(repo: QualityGateRepository): Promise<void> {
  await repo.savePolicy(policy()); await repo.savePolicy(policy(v2));
  expect((await repo.findLatestPolicy(scope, 'release'))?.metadata.version.toString()).toBe('1.1.0');
  expect((await repo.findPolicyVersion(scope, 'release', v1))?.metadata.version.toString()).toBe('1.0.0');
  expect((await repo.listPolicyVersions(scope, 'release')).map(String)).toEqual(['1.0.0', '1.1.0']);
  expect(await repo.listPolicies(scope)).toEqual([{ internalId: 'release', displayName: 'Release 1.1.0', publishName: 'release', latestVersion: v2, state: 'draft', ruleCount: 1 }]);
  await expect(repo.savePolicy(policy(v2))).rejects.toBeInstanceOf(QualityGateConflictError);
  await repo.saveReport(report); expect(await repo.findReport(scope, 'report')).toEqual(report); expect(await repo.listReports(scope, 'candidate')).toEqual([report]); expect(await repo.listReports(scope, 'other')).toEqual([]);
  await expect(repo.saveReport(report)).rejects.toBeInstanceOf(QualityGateConflictError);
  await repo.createPromotion(promotion); expect(await repo.findPromotion(scope, 'promotion')).toEqual(promotion); expect(await repo.listPromotions(scope, 'agent')).toEqual([promotion]);
  const approved = decidePromotion(promotion, 'approved', 'reviewer', '2026-07-10T01:00:00Z'); await repo.updatePromotion(approved); expect(await repo.findPromotion(scope, 'promotion')).toEqual(approved);
  await expect(repo.createPromotion(promotion)).rejects.toBeInstanceOf(QualityGateConflictError);
  await expect(repo.updatePromotion({ ...promotion, id: 'missing' })).rejects.toBeInstanceOf(QualityGateNotFoundError);
  expect(await repo.findLatestPolicy({ tenantId: 'other', workspaceId: 'workspace' }, 'release')).toBeNull(); expect(await repo.findReport(scope, 'missing')).toBeNull(); expect(await repo.findPromotion(scope, 'missing')).toBeNull();

  // deletePolicy(論理削除): listPoliciesから除外され、findLatestPolicyはnullになるが、findPolicyVersionは既存versionを返し続ける。
  await repo.savePolicy(createGatePolicy({ metadata: { internalId: 'other-policy', workingName: 'Other', displayName: 'Other', publishName: 'other', version: v1, owner: 'owner', state: 'draft', tenant: scope }, rules: [{ id: 'quality', kind: 'metric-threshold', metric: 'quality', operator: 'gte', threshold: 0.8 }], reportTtlHours: 24 }));
  await expect(repo.deletePolicy(scope, 'release')).resolves.toBe(true);
  expect((await repo.listPolicies(scope)).map((item) => item.internalId)).toEqual(['other-policy']);
  await expect(repo.findLatestPolicy(scope, 'release')).resolves.toBeNull();
  await expect(repo.listPolicyVersions(scope, 'release')).resolves.toEqual([]);
  expect((await repo.findPolicyVersion(scope, 'release', v1))?.metadata.internalId).toBe('release');
  await expect(repo.deletePolicy(scope, 'release')).resolves.toBe(false);
  await expect(repo.deletePolicy(scope, 'missing')).resolves.toBe(false);
  expect((await repo.findLatestPolicy(scope, 'other-policy'))?.metadata.internalId).toBe('other-policy');
}
