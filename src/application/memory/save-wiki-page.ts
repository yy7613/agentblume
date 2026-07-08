/**
 * application層: Wiki ページ保存（v21 実装契約 §3 / ADR-0016 M1）
 *
 * id 指定かつ既存なら改訂（version+1）、無ければ新規（version=1）。
 * 手動編集・提案承認の双方から使う「現在版の置換」保存。
 */
import { randomUUID } from 'node:crypto';
import type { TenantScope } from '../../domain/tool/ids';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { createWikiPage, reviseWikiPage, type WikiPage } from '../../domain/memory/wiki-page';

export interface SaveWikiPageInput {
  readonly scope: TenantScope;
  /** 省略時は新規（id 自動採番）。既存 id なら改訂。 */
  readonly id?: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  /** 由来 Run（提案承認経路で付与）。 */
  readonly sourceRunId?: string;
}

export class SaveWikiPageUseCase {
  constructor(
    private readonly wiki: WikiRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveWikiPageInput): Promise<WikiPage> {
    const updatedAt = this.now().toISOString();
    const existing = input.id !== undefined ? await this.wiki.find(input.scope, input.id) : null;
    const page = existing !== null
      ? reviseWikiPage(existing, {
          title: input.title,
          tags: input.tags,
          body: input.body,
          ...(input.sourceRunId !== undefined ? { addSourceRun: input.sourceRunId } : {}),
          updatedAt,
        })
      : createWikiPage({
          id: input.id ?? this.makeId(),
          tenant: input.scope,
          title: input.title,
          tags: input.tags,
          body: input.body,
          ...(input.sourceRunId !== undefined ? { sourceRuns: [input.sourceRunId] } : {}),
          updatedAt,
        });
    await this.wiki.save(page);
    return page;
  }
}
