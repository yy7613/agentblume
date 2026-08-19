import type { AgentHarnessRepository } from '../../domain/harness/harness-repository';
import { HarnessNotFoundError } from '../../domain/harness/errors';
import type { HarnessId } from '../../domain/harness/ids';
import type { TenantScope } from '../../domain/shared/tenant-scope';

/**
 * 保存済みHarnessの論理削除（docs/14-agent-harness-builder.md §10）。
 * repository.delete が false（未存在/削除済み）なら HarnessNotFoundError。
 * findVersion は削除後も返るため、既存の参照Run（trace・interactive resume）は壊れない。
 * Agent version削除時のHarness参照ガード（docs §10 後段）は別ユースケースの責務であり、ここでは扱わない。
 */
export class DeleteHarnessUseCase {
  constructor(private readonly repo: AgentHarnessRepository) {}
  async execute(scope: TenantScope, internalId: HarnessId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new HarnessNotFoundError(`Harness not found: ${internalId}`);
  }
}
