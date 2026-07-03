import { RunNotFoundError } from '../../domain/run/errors';
import type { RunRecord, RunStatus } from '../../domain/run/run';
import type { RunRepository } from '../../domain/run/run-repository';
import type { TenantScope } from '../../domain/tool/ids';

export class QueryRunsUseCase {
  constructor(private readonly repo: RunRepository) {}

  async get(scope: TenantScope, runId: string): Promise<RunRecord> {
    const record = await this.repo.find(scope, runId);
    if (record === null) throw new RunNotFoundError(`run not found: ${runId}`);
    return record;
  }

  async list(scope: TenantScope, options?: { readonly limit?: number; readonly status?: RunStatus }): Promise<RunRecord[]> {
    return this.repo.list(scope, options);
  }
}
