import type { AgentRepository } from '../../domain/agent/agent-repository';
import { AgentNotFoundError } from '../../domain/agent/errors';
import type { AgentId } from '../../domain/agent/ids';
import type { TenantScope } from '../../domain/tool/ids';

/**
 * 保存済みAgentの論理削除。repository.delete が false（未存在/削除済み）なら AgentNotFoundError。
 * findVersion は削除後も返るため、既存の参照Run・Harness slot割り当て・サブエージェント委譲は壊れない。
 */
export class DeleteAgentUseCase {
  constructor(private readonly repo: AgentRepository) {}
  async execute(scope: TenantScope, internalId: AgentId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new AgentNotFoundError(`Agent not found: ${internalId}`);
  }
}
