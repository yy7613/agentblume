/**
 * アプリ層: GetToolUseCase + ListToolVersionsUseCase（v2 実装契約 §11）
 *
 * - GetToolUseCase.latest / version: 存在しなければ ToolNotFoundError。
 * - ListToolVersionsUseCase.execute: 昇順の SemVer 配列（未存在→空配列）。
 */
import { ToolNotFoundError } from '../../domain/tool/errors';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import type { ToolId } from '../../domain/tool/ids';
import type { SemVer } from '../../domain/tool/semver';
import type { Tool } from '../../domain/tool/tool';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { ToolSummary } from '../../domain/tool/metadata';

/** Tool を取得するユースケース。無ければ ToolNotFoundError。 */
export class GetToolUseCase {
  constructor(private readonly repo: ToolRepository) {}

  /** 最新バージョンの Tool を取得する。無→ToolNotFoundError。 */
  async latest(scope: TenantScope, internalId: ToolId): Promise<Tool> {
    const tool = await this.repo.findLatest(scope, internalId);
    if (tool === null) {
      throw new ToolNotFoundError(
        `GetTool: tool not found: ${internalId} (tenant ${scope.tenantId}/${scope.workspaceId})`,
      );
    }
    return tool;
  }

  /** 指定バージョンの Tool を取得する。無→ToolNotFoundError。 */
  async version(scope: TenantScope, internalId: ToolId, version: SemVer): Promise<Tool> {
    const tool = await this.repo.findVersion(scope, internalId, version);
    if (tool === null) {
      throw new ToolNotFoundError(
        `GetTool: tool not found: ${internalId}@${version.toString()} (tenant ${scope.tenantId}/${scope.workspaceId})`,
      );
    }
    return tool;
  }
}

/** Tool の全バージョンを昇順で列挙するユースケース（未存在→空配列）。 */
export class ListToolVersionsUseCase {
  constructor(private readonly repo: ToolRepository) {}

  async execute(scope: TenantScope, internalId: ToolId): Promise<SemVer[]> {
    return this.repo.listVersions(scope, internalId);
  }
}

/** workspace内の各Toolのlatest summaryを返す。 */
export class ListToolsUseCase {
  constructor(private readonly repo: ToolRepository) {}
  execute(scope: TenantScope): Promise<ToolSummary[]> { return this.repo.list(scope); }
}

/**
 * 保存済みToolの論理削除。repository.delete が false（未存在/削除済み）なら ToolNotFoundError。
 * findVersion は削除後も返るため、既存の参照Run・Agent/Harness割り当ては壊れない。
 */
export class DeleteToolUseCase {
  constructor(private readonly repo: ToolRepository) {}
  async execute(scope: TenantScope, internalId: ToolId): Promise<void> {
    const existed = await this.repo.delete(scope, internalId);
    if (!existed) throw new ToolNotFoundError(`DeleteTool: tool not found: ${internalId} (tenant ${scope.tenantId}/${scope.workspaceId})`);
  }
}
