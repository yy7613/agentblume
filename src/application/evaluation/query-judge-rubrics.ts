import type { JudgeRubricRepository, JudgeRubricSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { JudgeRubricNotFoundError } from '../../domain/evaluation/errors';
import type { JudgeRubricId } from '../../domain/evaluation/ids';
import type { JudgeRubric } from '../../domain/evaluation/judge-rubric';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryJudgeRubricsUseCase {
  constructor(private readonly repo: JudgeRubricRepository) {}
  list(scope: TenantScope): Promise<JudgeRubricSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, id: JudgeRubricId): Promise<SemVer[]> { return this.repo.listVersions(scope, id); }
  async get(scope: TenantScope, id: JudgeRubricId, version?: SemVer): Promise<JudgeRubric> { const value = version === undefined ? await this.repo.findLatest(scope, id) : await this.repo.findVersion(scope, id, version); if (value === null) throw new JudgeRubricNotFoundError(`Judge rubric not found: ${id}${version === undefined ? '' : `@${version.toString()}`}`); return value; }
}

/** 保存済みJudge Rubricの論理削除。repository.delete が false(未存在/削除済み)なら JudgeRubricNotFoundError。 */
export class DeleteJudgeRubricUseCase {
  constructor(private readonly repo: JudgeRubricRepository) {}
  async execute(scope: TenantScope, internalId: JudgeRubricId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new JudgeRubricNotFoundError(`DeleteJudgeRubric: rubric not found: ${internalId}`);
  }
}
