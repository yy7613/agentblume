/**
 * ドメイン: LLM Wiki のページ（v21 実装契約 §1.1 / ADR-0016）
 *
 * 宣言的知識の単位。改訂は version をインクリメントし、由来 Run を追記する
 * （履歴は保持せず「現在の版」のみ。監査は sourceRuns と MemoryProposal 側で担う）。
 */
import { assertNonEmpty } from '../shared/assert';
import type { IsoDateTime } from '../shared/time';
import type { TenantScope } from '../shared/tenant-scope';
import { MemoryDomainError } from './errors';
import type { WikiPageId, WikiSpaceId } from './ids';
import { DEFAULT_WIKI_ID } from './wiki-space';

export interface WikiPage {
  readonly id: WikiPageId;
  readonly tenant: TenantScope;
  /** 旧recordでは欠損を許容し、default Wiki所属として解釈する。 */
  readonly wikiId?: WikiSpaceId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly version: number;
  readonly sourceRuns: readonly string[];
  readonly updatedAt: IsoDateTime;
}

export interface WikiPageSummary {
  readonly id: WikiPageId;
  readonly wikiId?: WikiSpaceId;
  readonly title: string;
  readonly tags: readonly string[];
  readonly version: number;
  readonly updatedAt: IsoDateTime;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, `WikiPage: ${field}`, (m) => new MemoryDomainError(m));
}

/** タグを trim・空要素除去・重複排除して正規化する。 */
function normalizeTags(tags: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export interface CreateWikiPageProps {
  readonly id: WikiPageId;
  readonly tenant: TenantScope;
  readonly wikiId?: WikiSpaceId;
  readonly title: string;
  readonly tags?: readonly string[];
  readonly body: string;
  readonly sourceRuns?: readonly string[];
  readonly updatedAt: IsoDateTime;
}

export function createWikiPage(props: CreateWikiPageProps): WikiPage {
  nonEmpty(props.id, 'id');
  nonEmpty(props.title, 'title');
  nonEmpty(props.body, 'body');
  nonEmpty(props.tenant?.tenantId, 'tenant.tenantId');
  nonEmpty(props.tenant.workspaceId, 'tenant.workspaceId');
  nonEmpty(props.updatedAt, 'updatedAt');
  if (props.wikiId !== undefined) nonEmpty(props.wikiId, 'wikiId');
  return {
    id: props.id,
    tenant: { ...props.tenant },
    ...(props.wikiId !== undefined ? { wikiId: props.wikiId.trim() } : {}),
    title: props.title,
    tags: normalizeTags(props.tags ?? []),
    body: props.body,
    version: 1,
    sourceRuns: normalizeTags(props.sourceRuns ?? []),
    updatedAt: props.updatedAt,
  };
}

export interface ReviseWikiPageChanges {
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly body?: string;
  readonly addSourceRun?: string;
  readonly updatedAt: IsoDateTime;
}

export function reviseWikiPage(page: WikiPage, changes: ReviseWikiPageChanges): WikiPage {
  nonEmpty(changes.updatedAt, 'updatedAt');
  const title = changes.title ?? page.title;
  const body = changes.body ?? page.body;
  nonEmpty(title, 'title');
  nonEmpty(body, 'body');
  const sourceRuns = changes.addSourceRun !== undefined && changes.addSourceRun.trim().length > 0
    ? normalizeTags([...page.sourceRuns, changes.addSourceRun])
    : page.sourceRuns;
  return {
    ...page,
    title,
    tags: changes.tags !== undefined ? normalizeTags(changes.tags) : page.tags,
    body,
    version: page.version + 1,
    sourceRuns,
    updatedAt: changes.updatedAt,
  };
}

export function summarizeWikiPage(page: WikiPage): WikiPageSummary {
  return { id: page.id, ...(page.wikiId !== undefined ? { wikiId: page.wikiId } : {}), title: page.title, tags: [...page.tags], version: page.version, updatedAt: page.updatedAt };
}

export function effectiveWikiId(page: Pick<WikiPage, 'wikiId'>): WikiSpaceId { return page.wikiId ?? DEFAULT_WIKI_ID; }
