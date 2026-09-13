/**
 * application層: 仕訳（JournalEntry）の手入力・一覧・確定・削除（docs/20 §2.4 / §9）。
 *
 * ## 科目名はマスタから写し直す
 *
 * 仕訳の各行は科目 id と**そのときの科目名**（`accountName`）の両方を持つ。名称はマスタで改名されても
 * 仕訳側は当時の名前を保つ設計だが、**保存のたびに現在のマスタから写す**のが正しい
 * （クライアントが送ってきた名前を信じると、id と名前が食い違う行を作れてしまい CSV の中身が壊れる）。
 * 貸借一致・金額の正負などの不変条件は domain の `createJournalEntry` が課す。
 *
 * ## 仕訳を消したら文書を未判定へ戻す
 *
 * 文書は `entryId` で仕訳を指す。仕訳だけを消すと、画面には「確定済み」と出るのに開くと 404 になる
 * 文書が残る。削除時にその参照を持つ文書を `extracted`（未判定）へ戻し、再判定できる状態にする。
 */
import { randomUUID } from 'node:crypto';
import { findAccount } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_UPDATED_AT, defaultChartOfAccounts } from '../../domain/journal/default-chart';
import { clearJudgment } from '../../domain/journal/document';
import { confirmEntry, createJournalEntry, type DecidedBy, type JournalEntry, type JournalEntryLine } from '../../domain/journal/entry';
import { JournalDomainError, JournalEntryNotFoundError } from '../../domain/journal/errors';
import type { InvoiceStatus } from '../../domain/journal/document';
import type { ChartOfAccountsRepository, JournalDocumentRepository, JournalEntryListOptions, JournalEntryRepository } from '../../domain/journal/repositories';
import type { TenantScope } from '../../domain/shared/tenant-scope';

export interface SaveJournalEntryInput {
  readonly scope: TenantScope;
  /** 省略で新規、指定で更新（無ければその id で新規）。 */
  readonly id?: string;
  readonly documentId?: string;
  readonly ruleId?: string;
  readonly date: string;
  readonly lines: readonly JournalEntryLine[];
  readonly description: string;
  readonly invoiceStatus: InvoiceStatus;
  readonly registrationNumber?: string;
  readonly item?: string;
  readonly tags?: readonly string[];
  /** 省略時は `manual`（この入口は手入力のためのもの）。 */
  readonly decidedBy?: DecidedBy;
}

export class SaveJournalEntryUseCase {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly charts: ChartOfAccountsRepository,
    private readonly makeId: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: SaveJournalEntryInput): Promise<JournalEntry> {
    const at = this.now().toISOString();
    const chart = (await this.charts.get(input.scope)) ?? defaultChartOfAccounts(DEFAULT_CHART_UPDATED_AT);
    const lines = input.lines.map((line, index) => {
      const account = findAccount(chart, line.accountId);
      if (account === undefined) throw new JournalDomainError(`journal entry: lines[${index}].accountId refers to an account that is not in the chart of accounts: ${line.accountId}`);
      if (!account.enabled) throw new JournalDomainError(`journal entry: lines[${index}].accountId refers to a disabled account: ${line.accountId} (${account.name})`);
      // 科目名は必ずマスタから写す（クライアントの申告を採らない）。
      return { ...line, accountName: account.name };
    });

    const existing = input.id === undefined ? null : await this.entries.findById(input.scope, input.id);
    const entry = createJournalEntry({
      tenant: input.scope,
      ...(input.id === undefined ? {} : { id: input.id }),
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      ...(input.ruleId === undefined ? {} : { ruleId: input.ruleId }),
      date: input.date,
      lines,
      description: input.description,
      invoiceStatus: input.invoiceStatus,
      ...(input.registrationNumber === undefined ? {} : { registrationNumber: input.registrationNumber }),
      ...(input.item === undefined ? {} : { item: input.item }),
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      // 状態は編集で戻らない（確定済みを直しても確定のまま）。
      ...(existing === null ? {} : { status: existing.status }),
      decidedBy: input.decidedBy ?? existing?.decidedBy ?? 'manual',
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    }, this.makeId);
    await this.entries.save(entry);
    return entry;
  }
}

export class ListJournalEntriesUseCase {
  constructor(private readonly entries: JournalEntryRepository) {}

  /** 仕訳日 昇順 → createdAt 昇順 → id 昇順（CSV に出す順）。 */
  async execute(scope: TenantScope, options?: JournalEntryListOptions): Promise<readonly JournalEntry[]> {
    return this.entries.list(scope, options);
  }
}

export class ConfirmJournalEntryUseCase {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, id: string): Promise<JournalEntry> {
    const entry = await this.entries.findById(scope, id);
    if (entry === null) throw new JournalEntryNotFoundError(`journal entry not found: ${id}`);
    // 確定済みは冪等、出力済みは domain が拒否する（JournalDomainError → 400）。
    const confirmed = confirmEntry(entry, this.now().toISOString());
    await this.entries.save(confirmed);
    return confirmed;
  }
}

export class DeleteJournalEntryUseCase {
  constructor(
    private readonly entries: JournalEntryRepository,
    private readonly documents: JournalDocumentRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(scope: TenantScope, id: string): Promise<void> {
    const entry = await this.entries.findById(scope, id);
    if (entry === null) throw new JournalEntryNotFoundError(`journal entry not found: ${id}`);
    await this.entries.delete(scope, id);
    if (entry.documentId === undefined) return;
    const document = await this.documents.findById(scope, entry.documentId);
    // 参照していた文書だけを戻す（別の仕訳へ差し替わっていれば触らない）。
    if (document !== null && document.entryId === id) {
      await this.documents.save(clearJudgment(document, this.now().toISOString()));
    }
  }
}