/**
 * ドメイン: 記憶提案（v21 実装契約 §1.2 / ADR-0016）
 *
 * Run 相当の対話から抽出した「記憶への変更案」。target に承認時へ適用する
 * 全内容を内包し、承認時に追加推論を要さない。人手承認制のエスケープハッチ。
 */
import { assertNonEmpty } from '../shared/assert';
import type { SkillId } from '../skill/ids';
import type { TenantScope } from '../tool/ids';
import { MemoryDomainError } from './errors';
import type { MemoryProposalId, WikiPageId, WikiSpaceId } from './ids';

export type MemoryProposalState = 'draft' | 'approved' | 'rejected';

export type MemoryProposalTarget =
  | {
      readonly kind: 'wiki';
      readonly wikiId?: WikiSpaceId;
      readonly pageId: WikiPageId;
      readonly isNewPage: boolean;
      readonly title: string;
      readonly tags: readonly string[];
      readonly body: string;
    }
  | {
      readonly kind: 'skill';
      readonly skillId: SkillId;
      readonly instructions: string;
    };

export interface MemoryProposal {
  readonly id: MemoryProposalId;
  readonly tenant: TenantScope;
  readonly target: MemoryProposalTarget;
  readonly summary: string;
  readonly state: MemoryProposalState;
  readonly sourceRun?: string;
  readonly createdAt: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  assertNonEmpty(value, `MemoryProposal: ${field}`, (m) => new MemoryDomainError(m));
}

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

function normalizeTarget(target: MemoryProposalTarget): MemoryProposalTarget {
  if (target.kind === 'wiki') {
    if (target.wikiId !== undefined) nonEmpty(target.wikiId, 'target.wikiId');
    nonEmpty(target.pageId, 'target.pageId');
    nonEmpty(target.title, 'target.title');
    nonEmpty(target.body, 'target.body');
    return { kind: 'wiki', ...(target.wikiId !== undefined ? { wikiId: target.wikiId } : {}), pageId: target.pageId, isNewPage: target.isNewPage, title: target.title, tags: normalizeTags(target.tags), body: target.body };
  }
  nonEmpty(target.skillId, 'target.skillId');
  nonEmpty(target.instructions, 'target.instructions');
  return { kind: 'skill', skillId: target.skillId, instructions: target.instructions };
}

export interface CreateMemoryProposalProps {
  readonly id: MemoryProposalId;
  readonly tenant: TenantScope;
  readonly target: MemoryProposalTarget;
  readonly summary: string;
  readonly sourceRun?: string;
  readonly createdAt: string;
}

export function createMemoryProposal(props: CreateMemoryProposalProps): MemoryProposal {
  nonEmpty(props.id, 'id');
  nonEmpty(props.summary, 'summary');
  nonEmpty(props.tenant?.tenantId, 'tenant.tenantId');
  nonEmpty(props.tenant.workspaceId, 'tenant.workspaceId');
  nonEmpty(props.createdAt, 'createdAt');
  return {
    id: props.id,
    tenant: { ...props.tenant },
    target: normalizeTarget(props.target),
    summary: props.summary,
    state: 'draft',
    ...(props.sourceRun !== undefined && props.sourceRun.trim().length > 0 ? { sourceRun: props.sourceRun } : {}),
    createdAt: props.createdAt,
  };
}

/** draft のみ決定可能（再決定は不変条件違反）。 */
export function decideProposal(proposal: MemoryProposal, decision: 'approved' | 'rejected'): MemoryProposal {
  if (proposal.state !== 'draft') {
    throw new MemoryDomainError(`MemoryProposal: cannot ${decision} a proposal already ${proposal.state}: ${proposal.id}`);
  }
  return { ...proposal, state: decision };
}
