/**
 * application層: 保存済み検証ケースの実行（単体 / 一括）。
 *
 * 実行のたびにケースの lastResult（状態・時刻・実行した版・要約）を更新して保存する。
 * 一括実行（regression の「Run all」）は一覧順に逐次実行し、1件が error でも止まらない。
 * 版を固定したケースの Tool が削除されていた場合も HTTP 404 にせず `status: 'error'`
 * （code TOOL_NOT_FOUND）の結果にする — 一括実行の途中で全体が失敗になると、残りのケースの
 * 結果が見えなくなるため。
 */
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { ToolNotFoundError } from '../../domain/tool/errors';
import { SemVer } from '../../domain/tool/semver';
import { ToolCheckNotFoundError } from '../../domain/tool-check/errors';
import { withToolCheckLastResult, type ToolCheckCase } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckCaseListOptions, ToolCheckCaseRepository } from '../../domain/tool-check/tool-check-case-repository';
import type { RunToolCheckUseCase } from './run-tool-check';
import { EMPTY_TABLE, summarizeToolCheckResult, type ToolCheckRunResult } from './tool-check-result';

export interface ToolCheckCaseRun {
  readonly case: ToolCheckCase;
  readonly result: ToolCheckRunResult;
}

export class RunToolCheckCaseUseCase {
  constructor(
    private readonly cases: ToolCheckCaseRepository,
    private readonly runToolCheck: RunToolCheckUseCase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, id: string): Promise<ToolCheckCaseRun> {
    const item = await this.cases.find(scope, id);
    if (item === null) throw new ToolCheckNotFoundError(`tool check case not found: ${id}`);
    return this.runOne(item);
  }

  async runAll(scope: TenantScope, options?: ToolCheckCaseListOptions): Promise<readonly ToolCheckCaseRun[]> {
    const items = await this.cases.list(scope, options);
    const runs: ToolCheckCaseRun[] = [];
    for (const item of items) runs.push(await this.runOne(item));
    return runs;
  }

  private async runOne(item: ToolCheckCase): Promise<ToolCheckCaseRun> {
    const result = await this.run(item);
    const updated = withToolCheckLastResult(item, {
      status: result.status,
      checkedAt: result.checkedAt,
      toolVersion: result.tool.version,
      summary: summarizeToolCheckResult(result),
    });
    await this.cases.save(updated);
    return { case: updated, result };
  }

  private async run(item: ToolCheckCase): Promise<ToolCheckRunResult> {
    try {
      const version = item.toolVersion === undefined ? undefined : SemVer.parse(item.toolVersion);
      return await this.runToolCheck.execute({
        scope: item.scope, toolId: item.toolId, ...(version === undefined ? {} : { version }),
        arguments: item.arguments, expectations: item.expectations,
      });
    } catch (error) {
      if (!(error instanceof ToolNotFoundError)) throw error;
      // 版が消えた・Tool が削除された: 結果として残し、一括実行を止めない。publishName は分からないので空。
      return {
        tool: { internalId: item.toolId, version: item.toolVersion ?? '', publishName: '' },
        status: 'error', assertions: [], output: EMPTY_TABLE, rowCount: 0, nodes: [], durationMs: 0,
        error: { code: error.code, message: error.message },
        checkedAt: this.now().toISOString(),
      };
    }
  }
}
