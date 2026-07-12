import type { JudgeRubricRepository } from '../../domain/evaluation/evaluation-asset-repositories';
import { createJudgeRubric, type JudgeCriterion, type JudgeReferencePolicy, type JudgeRubric } from '../../domain/evaluation/judge-rubric';
import type { TenantScope } from '../../domain/tool/ids';
import type { PublishState } from '../../domain/tool/metadata';
import { SemVer } from '../../domain/tool/semver';

export interface SaveJudgeRubricInput {
  readonly scope: TenantScope; readonly internalId: string; readonly workingName: string; readonly displayName: string; readonly publishName: string; readonly owner: string;
  readonly instructions: string; readonly criteria: readonly JudgeCriterion[]; readonly referencePolicy: JudgeReferencePolicy; readonly bump?: 'major' | 'minor' | 'patch'; readonly state?: PublishState;
}
const nextVersion = (versions: readonly SemVer[], bump: 'major' | 'minor' | 'patch'): SemVer => versions.length === 0 ? SemVer.of(1, 0, 0) : versions.reduce((max, item) => item.compare(max) > 0 ? item : max).bump(bump);
export class SaveJudgeRubricUseCase {
  constructor(private readonly repo: JudgeRubricRepository) {}
  async execute(input: SaveJudgeRubricInput): Promise<JudgeRubric> {
    const rubric = createJudgeRubric({ metadata: { internalId: input.internalId, workingName: input.workingName, displayName: input.displayName, publishName: input.publishName, version: nextVersion(await this.repo.listVersions(input.scope, input.internalId), input.bump ?? 'patch'), owner: input.owner, state: input.state ?? 'draft', tenant: input.scope }, instructions: input.instructions, criteria: input.criteria, referencePolicy: input.referencePolicy, reasonRequired: true });
    await this.repo.save(rubric); return rubric;
  }
}
