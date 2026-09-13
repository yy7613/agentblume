/**
 * adapters層: 仕訳 BC の InMemory 永続化（test プロファイルと契約テスト用）。
 *
 * 5つの集約を1ファイルにまとめる。どれも「Map + スコープ絞り込み + 並べ替え」だけの薄い実装で、
 * 1つずつファイルを分けても中身が3行違うだけになるため（SQLite 側は列とクエリが異なるので分ける）。
 *
 * **保存も読み出しも `structuredClone` する**。呼び出し側が受け取ったオブジェクトを書き換えても
 * リポジトリの中身が変わらないことは、SQLite 実装（JSON を経由するので当然そうなる）と挙動を
 * 揃えるために必要で、共有契約テストがこれを検査する。
 *
 * 並び順の正本は `domain/journal/repositories.ts` の doc コメント。ここと SQLite の
 * `ORDER BY` は必ず同じ結果にする（比較関数は SQLite 側のクエリと1対1に対応させてある）。
 */
import type { ChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { toJournalDocumentSummary, type JournalDocument, type JournalDocumentSummary } from '../../domain/journal/document';
import type { JournalEntry } from '../../domain/journal/entry';
import type { HearingSession } from '../../domain/journal/hearing';
import type {
  ChartOfAccountsRepository, JournalDocumentListOptions, JournalDocumentRepository,
  JournalEntryListOptions, JournalEntryRepository, JournalHearingRepository, JournalRuleRepository,
} from '../../domain/journal/repositories';
import type { JournalRule } from '../../domain/journal/rule';
import type { TenantScope } from '../../domain/shared/tenant-scope';

function scopeKey(scope: TenantScope): string { return `${scope.tenantId}${scope.workspaceId}`; }
function key(scope: TenantScope, id: string): string { return `${scopeKey(scope)}${id}`; }
function inScope(item: { readonly tenant: TenantScope }, scope: TenantScope): boolean {
  return item.tenant.tenantId === scope.tenantId && item.tenant.workspaceId === scope.workspaceId;
}
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 新しいものが先（createdAt 降順 → id 昇順）。文書とヒアリングの一覧順。 */
export function compareNewestFirst(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return compareIds(left.id, right.id);
}

/** priority 降順 → createdAt 昇順 → id 昇順（判定の優先順）。 */
export function compareJournalRules(left: JournalRule, right: JournalRule): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return compareIds(left.id, right.id);
}

/** 仕訳日 昇順 → createdAt 昇順 → id 昇順（CSV に出す順）。 */
export function compareJournalEntries(left: JournalEntry, right: JournalEntry): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return compareIds(left.id, right.id);
}

/** 一覧・範囲検索で使う取引日（取引日が無ければ発行日。要約と同じ規則）。 */
export function documentDateOf(document: JournalDocument): string | undefined {
  return document.facts.transactionDate ?? document.facts.issueDate;
}

export class InMemoryChartOfAccountsRepository implements ChartOfAccountsRepository {
  private readonly store = new Map<string, ChartOfAccounts>();

  async get(scope: TenantScope): Promise<ChartOfAccounts | null> {
    const chart = this.store.get(scopeKey(scope));
    return chart === undefined ? null : structuredClone(chart);
  }

  async save(scope: TenantScope, chart: ChartOfAccounts): Promise<void> {
    this.store.set(scopeKey(scope), structuredClone(chart));
  }
}

export class InMemoryJournalDocumentRepository implements JournalDocumentRepository {
  private readonly store = new Map<string, JournalDocument>();

  async save(document: JournalDocument): Promise<void> {
    this.store.set(key(document.tenant, document.id), structuredClone(document));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalDocument | null> {
    const document = this.store.get(key(scope, id));
    return document === undefined ? null : structuredClone(document);
  }

  async findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly JournalDocument[]> {
    return ids
      .map((id) => this.store.get(key(scope, id)))
      .filter((document): document is JournalDocument => document !== undefined)
      .map((document) => structuredClone(document));
  }

  async list(scope: TenantScope, options?: JournalDocumentListOptions): Promise<readonly JournalDocumentSummary[]> {
    const matched = [...this.store.values()].filter((document) => {
      if (!inScope(document, scope)) return false;
      if (options?.status !== undefined && document.status !== options.status) return false;
      if (options?.kind !== undefined && document.kind !== options.kind) return false;
      if (options?.from !== undefined || options?.to !== undefined) {
        // 日付を持たない文書は範囲指定から外れる（SQLite 側の NULL 比較と同じ）。
        const date = documentDateOf(document);
        if (date === undefined) return false;
        if (options.from !== undefined && date < options.from) return false;
        if (options.to !== undefined && date > options.to) return false;
      }
      return true;
    });
    const summaries = matched.map(toJournalDocumentSummary).sort(compareNewestFirst);
    return options?.limit === undefined ? summaries : summaries.slice(0, options.limit);
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }
}

export class InMemoryJournalRuleRepository implements JournalRuleRepository {
  private readonly store = new Map<string, JournalRule>();

  async save(rule: JournalRule): Promise<void> {
    this.store.set(key(rule.tenant, rule.id), structuredClone(rule));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalRule | null> {
    const rule = this.store.get(key(scope, id));
    return rule === undefined ? null : structuredClone(rule);
  }

  async list(scope: TenantScope): Promise<readonly JournalRule[]> {
    return [...this.store.values()]
      .filter((rule) => inScope(rule, scope))
      .sort(compareJournalRules)
      .map((rule) => structuredClone(rule));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }
}

export class InMemoryJournalEntryRepository implements JournalEntryRepository {
  private readonly store = new Map<string, JournalEntry>();

  async save(entry: JournalEntry): Promise<void> {
    this.store.set(key(entry.tenant, entry.id), structuredClone(entry));
  }

  async findById(scope: TenantScope, id: string): Promise<JournalEntry | null> {
    const entry = this.store.get(key(scope, id));
    return entry === undefined ? null : structuredClone(entry);
  }

  async list(scope: TenantScope, options?: JournalEntryListOptions): Promise<readonly JournalEntry[]> {
    return [...this.store.values()]
      .filter((entry) => {
        if (!inScope(entry, scope)) return false;
        if (options?.status !== undefined && entry.status !== options.status) return false;
        if (options?.documentId !== undefined && entry.documentId !== options.documentId) return false;
        if (options?.from !== undefined && entry.date < options.from) return false;
        if (options?.to !== undefined && entry.date > options.to) return false;
        return true;
      })
      .sort(compareJournalEntries)
      .map((entry) => structuredClone(entry));
  }

  async delete(scope: TenantScope, id: string): Promise<boolean> {
    return this.store.delete(key(scope, id));
  }
}

export class InMemoryJournalHearingRepository implements JournalHearingRepository {
  private readonly store = new Map<string, HearingSession>();

  async save(session: HearingSession): Promise<void> {
    this.store.set(key(session.tenant, session.id), structuredClone(session));
  }

  async findById(scope: TenantScope, id: string): Promise<HearingSession | null> {
    const session = this.store.get(key(scope, id));
    return session === undefined ? null : structuredClone(session);
  }

  async findByDocument(scope: TenantScope, documentId: string): Promise<readonly HearingSession[]> {
    return [...this.store.values()]
      .filter((session) => inScope(session, scope) && session.documentId === documentId)
      .sort(compareNewestFirst)
      .map((session) => structuredClone(session));
  }

  async list(scope: TenantScope): Promise<readonly HearingSession[]> {
    return [...this.store.values()]
      .filter((session) => inScope(session, scope))
      .sort(compareNewestFirst)
      .map((session) => structuredClone(session));
  }
}