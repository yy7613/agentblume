/**
 * application層テスト用フィクスチャ: 記憶ポートの in-memory フェイク実装（v21）
 *
 * application 層のテストは adapter 実装ではなく Port に依存する（depcruise 準拠）ため、
 * ドメインインターフェースだけを用いたフェイクをここに集約する。計測対象外（*.fixtures.ts）。
 */
import { tenantKey, type TenantScope } from '../../domain/tool/ids';
import { SemVer } from '../../domain/tool/semver';
import type { WikiRepository } from '../../domain/memory/wiki-repository';
import { summarizeWikiPage, type WikiPage, type WikiPageSummary } from '../../domain/memory/wiki-page';
import type { MemoryProposalRepository } from '../../domain/memory/memory-proposal-repository';
import type { MemoryProposal, MemoryProposalState } from '../../domain/memory/memory-proposal';
import type { SkillRepository, SkillSummary } from '../../domain/skill/skill-repository';
import type { Skill } from '../../domain/skill/skill';
import type { ToolRepository } from '../../domain/tool/tool-repository';
import type { Tool } from '../../domain/tool/tool';
import type { ToolId } from '../../domain/tool/ids';
import type { ToolSummary } from '../../domain/tool/metadata';

const key = (scope: TenantScope, id: string) => `${tenantKey(scope)} ${id}`;
const inScope = (a: TenantScope, b: TenantScope) => tenantKey(a) === tenantKey(b);

export class FakeWikiRepository implements WikiRepository {
  private readonly store = new Map<string, WikiPage>();
  async save(page: WikiPage): Promise<void> { this.store.set(key(page.tenant, page.id), page); }
  async find(scope: TenantScope, id: string): Promise<WikiPage | null> { return this.store.get(key(scope, id)) ?? null; }
  async list(scope: TenantScope): Promise<WikiPageSummary[]> { return this.pages(scope).map(summarizeWikiPage); }
  async search(scope: TenantScope, query: string, limit: number): Promise<WikiPageSummary[]> {
    const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 0);
    return this.pages(scope)
      .filter((page) => terms.every((term) => `${page.title}\n${page.body}\n${page.tags.join(' ')}`.toLowerCase().includes(term)))
      .slice(0, Math.max(0, limit))
      .map(summarizeWikiPage);
  }
  private pages(scope: TenantScope): WikiPage[] {
    return [...this.store.values()].filter((page) => inScope(page.tenant, scope)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export class FakeMemoryProposalRepository implements MemoryProposalRepository {
  private readonly store = new Map<string, MemoryProposal>();
  async save(proposal: MemoryProposal): Promise<void> { this.store.set(key(proposal.tenant, proposal.id), proposal); }
  async find(scope: TenantScope, id: string): Promise<MemoryProposal | null> { return this.store.get(key(scope, id)) ?? null; }
  async list(scope: TenantScope, state?: MemoryProposalState): Promise<MemoryProposal[]> {
    return [...this.store.values()]
      .filter((p) => inScope(p.tenant, scope) && (state === undefined || p.state === state))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export class FakeSkillRepository implements SkillRepository {
  private readonly store: Skill[] = [];
  constructor(seed: readonly Skill[] = []) { this.store.push(...seed); }
  async save(skill: Skill): Promise<void> { this.store.push(skill); }
  async findVersion(scope: TenantScope, id: string, version: SemVer): Promise<Skill | null> {
    return this.store.find((s) => inScope(s.metadata.tenant, scope) && s.metadata.internalId === id && s.metadata.version.equals(version)) ?? null;
  }
  async findLatest(scope: TenantScope, id: string): Promise<Skill | null> {
    const versions = this.store.filter((s) => inScope(s.metadata.tenant, scope) && s.metadata.internalId === id);
    return versions.length === 0 ? null : versions.reduce((max, s) => (s.metadata.version.compare(max.metadata.version) > 0 ? s : max));
  }
  async listVersions(scope: TenantScope, id: string): Promise<SemVer[]> {
    return this.store.filter((s) => inScope(s.metadata.tenant, scope) && s.metadata.internalId === id).map((s) => s.metadata.version).sort((a, b) => a.compare(b));
  }
  async list(scope: TenantScope): Promise<SkillSummary[]> {
    const latest = new Map<string, Skill>();
    for (const s of this.store) {
      if (!inScope(s.metadata.tenant, scope)) continue;
      const current = latest.get(s.metadata.internalId);
      if (current === undefined || s.metadata.version.compare(current.metadata.version) > 0) latest.set(s.metadata.internalId, s);
    }
    return [...latest.values()].map((s) => ({ internalId: s.metadata.internalId, displayName: s.metadata.displayName, publishName: s.metadata.publishName, latestVersion: s.metadata.version, state: s.metadata.state }));
  }
}

/** SaveSkill が参照Toolを検証する経路用の最小フェイク（登録Toolを findVersion で返す）。 */
export class FakeToolRepository implements ToolRepository {
  private readonly store: Tool[] = [];
  constructor(seed: readonly Tool[] = []) { this.store.push(...seed); }
  async save(tool: Tool): Promise<void> { this.store.push(tool); }
  async findVersion(scope: TenantScope, id: ToolId, version: SemVer): Promise<Tool | null> {
    return this.store.find((t) => inScope(t.metadata.tenant, scope) && t.metadata.internalId === id && t.metadata.version.equals(version)) ?? null;
  }
  async findLatest(scope: TenantScope, id: ToolId): Promise<Tool | null> {
    const versions = this.store.filter((t) => inScope(t.metadata.tenant, scope) && t.metadata.internalId === id);
    return versions.length === 0 ? null : versions.reduce((max, t) => (t.metadata.version.compare(max.metadata.version) > 0 ? t : max));
  }
  async listVersions(scope: TenantScope, id: ToolId): Promise<SemVer[]> {
    return this.store.filter((t) => inScope(t.metadata.tenant, scope) && t.metadata.internalId === id).map((t) => t.metadata.version);
  }
  async list(scope: TenantScope): Promise<ToolSummary[]> {
    return this.store.filter((t) => inScope(t.metadata.tenant, scope)).map((t) => ({ internalId: t.metadata.internalId, displayName: t.metadata.displayName, publishName: t.metadata.publishName, latestVersion: t.metadata.version, state: t.metadata.state, sideEffect: t.sideEffect }));
  }
}
