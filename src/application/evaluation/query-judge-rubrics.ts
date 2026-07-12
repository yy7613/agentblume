import type { JudgeRubricRepository, JudgeRubricSummary } from '../../domain/evaluation/evaluation-asset-repositories';
import { JudgeRubricNotFoundError } from '../../domain/evaluation/errors';
import type { JudgeRubric } from '../../domain/evaluation/judge-rubric';
import type { TenantScope } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';

export class QueryJudgeRubricsUseCase {
  constructor(private readonly repo: JudgeRubricRepository) {}
  list(scope: TenantScope): Promise<JudgeRubricSummary[]> { return this.repo.list(scope); }
  versions(scope: TenantScope, id: string): Promise<SemVer[]> { return this.repo.listVersions(scope, id); }
  async get(scope: TenantScope, id: string, version?: SemVer): Promise<JudgeRubric> { const value = version === undefined ? await this.repo.findLatest(scope, id) : await this.repo.findVersion(scope, id, version); if (value === null) throw new JudgeRubricNotFoundError(`Judge rubric not found: ${id}${version === undefined ? '' : `@${version.toString()}`}`); return value; }
}
