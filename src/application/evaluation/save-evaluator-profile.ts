import { createEvaluatorProfile, type EvaluatorMetricDefinition, type EvaluatorProfile } from '../../domain/evaluation/evaluator-profile';
import type { EvaluatorProfileRepository, JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { EvaluationDomainError } from '../../domain/evaluation/errors';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';

export interface SaveEvaluatorProfileInput {
  readonly scope: TenantScope;
  readonly internalId: string;
  readonly workingName: string;
  readonly displayName: string;
  readonly publishName: string;
  readonly owner: string;
  readonly metrics: readonly EvaluatorMetricDefinition[];
  readonly bump?: 'major' | 'minor' | 'patch';
  readonly state?: PublishState;
}

function nextVersion(versions: readonly SemVer[], bump: 'major' | 'minor' | 'patch'): SemVer {
  return versions.length === 0 ? SemVer.of(1, 0, 0) : versions.reduce((max, item) => (item.compare(max) > 0 ? item : max)).bump(bump);
}

export class SaveEvaluatorProfileUseCase {
  constructor(private readonly profiles: EvaluatorProfileRepository, private readonly rubrics?: JudgeRubricRepository) {}
  async execute(input: SaveEvaluatorProfileInput): Promise<EvaluatorProfile> {
    for (const metric of input.metrics) {
      if (metric.kind !== 'judge') continue;
      if (this.rubrics === undefined || await this.rubrics.findVersion(input.scope, metric.rubric.id, metric.rubric.version) === null) throw new EvaluationDomainError(`SaveEvaluatorProfile: judge rubric not found: ${metric.rubric.id}@${metric.rubric.version.toString()}`);
    }
    const profile = createEvaluatorProfile({
      metadata: {
        internalId: input.internalId, workingName: input.workingName, displayName: input.displayName, publishName: input.publishName,
        version: nextVersion(await this.profiles.listVersions(input.scope, input.internalId), input.bump ?? 'patch'),
        owner: input.owner, state: input.state ?? 'draft', tenant: input.scope,
      },
      metrics: input.metrics,
    });
    await this.profiles.save(profile);
    return profile;
  }
}
