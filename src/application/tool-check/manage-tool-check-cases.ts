/**
 * application層: 検証ケースの保存・一覧・削除。
 *
 * 保存時に参照先 Tool（版固定なら固定版、無ければ最新版）が存在することを確かめる。
 * 存在しない Tool のケースを保存できてしまうと、実行するまで気付けない「必ず error になるケース」が
 * 一覧に溜まる。上書き保存では lastResult と createdAt を引き継ぐ（定義の変更で履歴を消さない）。
 */
import { randomUUID } from 'node:crypto';
import type { TenantScope } from '../../domain/shared/tenant-scope';
import { ToolNotFoundError } from '../../domain/tool/errors';
import { SemVer } from '../../domain/tool/semver';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import { ToolCheckNotFoundError } from '../../domain/tool-check/errors';
import { createToolCheckCase, type JsonCell, type ToolCheckCase, type ToolCheckExpectations } from '../../domain/tool-check/tool-check-case';
import type { ToolCheckCaseListOptions, ToolCheckCaseRepository } from '../../domain/tool-check/tool-check-case-repository';

export interface SaveToolCheckCaseInput {
  readonly scope: TenantScope;
  /** 省略時は新規作成、指定時は上書き（無ければその id で新規作成）。 */
  readonly id?: string;
  readonly toolId: string;
  readonly toolVersion?: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonCell>>;
  readonly expectations: ToolCheckExpectations;
}

export class SaveToolCheckCaseUseCase {
  constructor(
    private readonly cases: ToolCheckCaseRepository,
    private readonly tools: ToolRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveToolCheckCaseInput): Promise<ToolCheckCase> {
    const at = this.now().toISOString();
    const existing = input.id === undefined ? null : await this.cases.find(input.scope, input.id);
    // 先にドメイン検証を通す（toolVersion の形が壊れていれば Tool を探す前に 400 で返す）。
    const draft = createToolCheckCase({
      scope: input.scope,
      ...(input.id === undefined ? {} : { id: input.id }),
      toolId: input.toolId,
      ...(input.toolVersion === undefined ? {} : { toolVersion: input.toolVersion }),
      name: input.name,
      arguments: input.arguments,
      expectations: input.expectations,
      ...(existing?.lastResult === undefined ? {} : { lastResult: existing.lastResult }),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }, this.makeId);
    await this.assertToolExists(input.scope, draft);
    await this.cases.save(draft);
    return draft;
  }

  private async assertToolExists(scope: TenantScope, draft: ToolCheckCase): Promise<void> {
    const tool = draft.toolVersion === undefined
      ? await this.tools.findLatest(scope, draft.toolId)
      : await this.tools.findVersion(scope, draft.toolId, SemVer.parse(draft.toolVersion));
    if (tool === null) {
      throw new ToolNotFoundError(draft.toolVersion === undefined ? `tool not found: ${draft.toolId}` : `tool not found: ${draft.toolId}@${draft.toolVersion}`);
    }
  }
}

export class ListToolCheckCasesUseCase {
  constructor(private readonly cases: ToolCheckCaseRepository) {}

  async execute(scope: TenantScope, options?: ToolCheckCaseListOptions): Promise<readonly ToolCheckCase[]> {
    return this.cases.list(scope, options);
  }
}

export class DeleteToolCheckCaseUseCase {
  constructor(private readonly cases: ToolCheckCaseRepository) {}

  async execute(scope: TenantScope, id: string): Promise<void> {
    const deleted = await this.cases.delete(scope, id);
    if (!deleted) throw new ToolCheckNotFoundError(`tool check case not found: ${id}`);
  }
}
