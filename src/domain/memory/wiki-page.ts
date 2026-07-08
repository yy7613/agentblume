/**
 * ドメイン: LLM Wiki のページ（v21 実装契約 §1.1 / ADR-0016）
 *
 * 宣言的知識の単位。改訂は version をインクリメントし、由来 Run を追記する
 * （履歴は保持せず「現在の版」のみ。監査は sourceRuns と MemoryProposal 側で担う）。
 */
import type { TenantScope } from '../tool/ids';
import { MemoryDomainError } from './errors';

export interface WikiPage {
  readonly id: string;
  readonly tenant: TenantScope;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly version: number;
  readonly sourceRuns: readonly string[];
  readonly updatedAt: string;
}

export interface WikiPageSummary {
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly version: number;
  readonly updatedAt: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MemoryDomainError(`WikiPage: ${field} must be a non-empty string`);
  }
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
  readonly id: string;
  readonly tenant: TenantScope;
  readonly title: string;
  readonly tags?: readonly string[];
  readonly body: string;
  readonly sourceRuns?: readonly string[];
  readonly updatedAt: string;
}

export function createWikiPage(props: CreateWikiPageProps): WikiPage {
  nonEmpty(props.id, 'id');
  nonEmpty(props.title, 'title');
  nonEmpty(props.body, 'body');
  nonEmpty(props.tenant?.tenantId, 'tenant.tenantId');
  nonEmpty(props.tenant.workspaceId, 'tenant.workspaceId');
  nonEmpty(props.updatedAt, 'updatedAt');
  return {
    id: props.id,
    tenant: { ...props.tenant },
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
  readonly updatedAt: string;
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
  return { id: page.id, title: page.title, tags: [...page.tags], version: page.version, updatedAt: page.updatedAt };
}
