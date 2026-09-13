/**
 * ドメイン: 仕訳 BC のリポジトリ境界。
 *
 * - 科目マスタはワークスペースに 1 つ（scope がキー）。無ければ null（application が標準セットを返す）。
 * - 文書 / ルール / 仕訳 / ヒアリングは (scope, id) で upsert。一覧は「新しいものが先」（createdAt 降順、同時刻は id 昇順）。
 * - 文書の一覧は**要約**（画像 data URL・原文・CSV 行を含まない）で返す。本体は findById で 1 件ずつ読む。
 */
import type { TenantScope } from '../shared/tenant-scope';
import type { ChartOfAccounts } from './chart-of-accounts';
import type { DocumentKind, DocumentStatus, JournalDocument, JournalDocumentSummary } from './document';
import type { EntryStatus, JournalEntry } from './entry';
import type { HearingSession } from './hearing';
import type { JournalRule } from './rule';

export interface ChartOfAccountsRepository {
  get(scope: TenantScope): Promise<ChartOfAccounts | null>;
  save(scope: TenantScope, chart: ChartOfAccounts): Promise<void>;
}

export interface JournalDocumentListOptions {
  readonly status?: DocumentStatus;
  readonly kind?: DocumentKind;
  /** 取引日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
}

export interface JournalDocumentRepository {
  save(document: JournalDocument): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<JournalDocument | null>;
  /** 見つかったものだけを返す（順序は ids の順）。 */
  findByIds(scope: TenantScope, ids: readonly string[]): Promise<readonly JournalDocument[]>;
  list(scope: TenantScope, options?: JournalDocumentListOptions): Promise<readonly JournalDocumentSummary[]>;
  /** 戻り値は削除前に存在したか。 */
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface JournalRuleRepository {
  save(rule: JournalRule): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<JournalRule | null>;
  /** priority 降順 → createdAt 昇順 → id 昇順（判定の優先順と同じ並び。特異度は呼び出し側が見る）。 */
  list(scope: TenantScope): Promise<readonly JournalRule[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface JournalEntryListOptions {
  readonly status?: EntryStatus;
  /** 仕訳日（`YYYY-MM-DD`）の範囲。両端を含む。 */
  readonly from?: string;
  readonly to?: string;
  readonly documentId?: string;
}

export interface JournalEntryRepository {
  save(entry: JournalEntry): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<JournalEntry | null>;
  /** 仕訳日 昇順 → createdAt 昇順 → id 昇順（CSV に出す順）。 */
  list(scope: TenantScope, options?: JournalEntryListOptions): Promise<readonly JournalEntry[]>;
  delete(scope: TenantScope, id: string): Promise<boolean>;
}

export interface JournalHearingRepository {
  save(session: HearingSession): Promise<void>;
  findById(scope: TenantScope, id: string): Promise<HearingSession | null>;
  /** その文書のヒアリング（新しいものが先）。 */
  findByDocument(scope: TenantScope, documentId: string): Promise<readonly HearingSession[]>;
  list(scope: TenantScope): Promise<readonly HearingSession[]>;
}
