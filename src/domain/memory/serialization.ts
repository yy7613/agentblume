/**
 * ドメイン: 記憶エンティティの直列化（v21 実装契約 §1.4）
 *
 * WikiPage / MemoryProposal は JSON 素直な素データのため、直列化は構造クローンに近い。
 * 永続化アダプタはこの Serialized 型を JSON 化して保存する。
 */
import type { MemoryProposal, MemoryProposalTarget } from './memory-proposal';
import type { WikiPage } from './wiki-page';

export interface SerializedWikiPage {
  readonly id: string;
  readonly tenant: { readonly tenantId: string; readonly workspaceId: string };
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  readonly version: number;
  readonly sourceRuns: readonly string[];
  readonly updatedAt: string;
}

export interface SerializedMemoryProposal {
  readonly id: string;
  readonly tenant: { readonly tenantId: string; readonly workspaceId: string };
  readonly target: MemoryProposalTarget;
  readonly summary: string;
  readonly state: MemoryProposal['state'];
  readonly sourceRun?: string;
  readonly createdAt: string;
}

export function serializeWikiPage(page: WikiPage): SerializedWikiPage {
  return {
    id: page.id,
    tenant: { tenantId: page.tenant.tenantId, workspaceId: page.tenant.workspaceId },
    title: page.title,
    tags: [...page.tags],
    body: page.body,
    version: page.version,
    sourceRuns: [...page.sourceRuns],
    updatedAt: page.updatedAt,
  };
}

export function deserializeWikiPage(value: SerializedWikiPage): WikiPage {
  return {
    id: value.id,
    tenant: { tenantId: value.tenant.tenantId, workspaceId: value.tenant.workspaceId },
    title: value.title,
    tags: [...value.tags],
    body: value.body,
    version: value.version,
    sourceRuns: [...value.sourceRuns],
    updatedAt: value.updatedAt,
  };
}

function cloneTarget(target: MemoryProposalTarget): MemoryProposalTarget {
  return target.kind === 'wiki'
    ? { kind: 'wiki', pageId: target.pageId, isNewPage: target.isNewPage, title: target.title, tags: [...target.tags], body: target.body }
    : { kind: 'skill', skillId: target.skillId, instructions: target.instructions };
}

export function serializeMemoryProposal(proposal: MemoryProposal): SerializedMemoryProposal {
  return {
    id: proposal.id,
    tenant: { tenantId: proposal.tenant.tenantId, workspaceId: proposal.tenant.workspaceId },
    target: cloneTarget(proposal.target),
    summary: proposal.summary,
    state: proposal.state,
    ...(proposal.sourceRun !== undefined ? { sourceRun: proposal.sourceRun } : {}),
    createdAt: proposal.createdAt,
  };
}

export function deserializeMemoryProposal(value: SerializedMemoryProposal): MemoryProposal {
  return {
    id: value.id,
    tenant: { tenantId: value.tenant.tenantId, workspaceId: value.tenant.workspaceId },
    target: cloneTarget(value.target),
    summary: value.summary,
    state: value.state,
    ...(value.sourceRun !== undefined ? { sourceRun: value.sourceRun } : {}),
    createdAt: value.createdAt,
  };
}
