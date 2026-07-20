/**
 * application層: Agent Factory `QueryFactoryRunsUseCase`（v33 実装契約 §3）。
 * `QueryHarnessRunsUseCase` / `QueryExperimentsUseCase` と同じ形。
 */
import type { TenantScope } from '../../domain/tool/ids';
import type { FactoryRun, FactoryRunStatus } from '../../domain/factory/factory-run';
import type { FactoryRunRepository } from '../../domain/factory/factory-run-repository';
import { FactoryNotFoundError } from '../../domain/factory/errors';

export class QueryFactoryRunsUseCase {
  constructor(private readonly repo: FactoryRunRepository) {}

  list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: FactoryRunStatus }): Promise<FactoryRun[]> {
    return this.repo.list(scope, options);
  }

  async get(scope: TenantScope, runId: string): Promise<FactoryRun> {
    const run = await this.repo.find(scope, runId);
    if (run === null) throw new FactoryNotFoundError(`Factory run not found: ${runId}`);
    return run;
  }
}
