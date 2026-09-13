import { describe, expect, it } from 'vitest';
import {
  InMemoryChartOfAccountsRepository, InMemoryJournalDocumentRepository, InMemoryJournalEntryRepository,
} from '../../adapters/storage/in-memory-journal-repositories';
import { createChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalDocument } from '../../domain/journal/document';
import { JournalDomainError, JournalEntryNotFoundError } from '../../domain/journal/errors';
import {
  ConfirmJournalEntryUseCase, DeleteJournalEntryUseCase, ListJournalEntriesUseCase, SaveJournalEntryUseCase,
} from './manage-entries';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

function ids(): () => string {
  let counter = 0;
  return () => `entry-${(counter += 1)}`;
}

async function charts() {
  const repo = new InMemoryChartOfAccountsRepository();
  await repo.save(scope, DEFAULT_CHART_OF_ACCOUNTS);
  return repo;
}

const balanced = {
  scope,
  date: '2026-09-10',
  description: '手入力の仕訳',
  invoiceStatus: 'qualified' as const,
  lines: [
    { side: 'debit' as const, accountId: 'expense.supplies', accountName: '', taxCode: 'JP-IN-10-S', amount: 1100 },
    { side: 'credit' as const, accountId: 'asset.cash', accountName: '', taxCode: 'JP-NA', amount: 1100 },
  ],
};

describe('SaveJournalEntryUseCase', () => {
  it('正常: 新規作成し、科目名を**マスタから写し直す**（クライアントの申告を採らない）', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const entry = await new SaveJournalEntryUseCase(entries, await charts(), ids(), clock).execute({
      ...balanced,
      lines: [{ ...balanced.lines[0]!, accountName: '嘘の名前' }, balanced.lines[1]!],
    });
    expect(entry.id).toBe('entry-1');
    expect(entry.decidedBy).toBe('manual');
    expect(entry.status).toBe('draft');
    expect(entry.lines[0]?.accountName).toBe('消耗品費');
    expect(entry.lines[1]?.accountName).toBe('現金');
    expect(await entries.findById(scope, 'entry-1')).not.toBeNull();
  });

  it('正常: 更新は createdAt と状態を保つ（確定済みを直しても確定のまま）', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const chart = await charts();
    const created = await new SaveJournalEntryUseCase(entries, chart, ids(), clock).execute(balanced);
    await entries.save({ ...(await entries.findById(scope, created.id))!, status: 'confirmed' });

    const later = new Date('2026-09-20T00:00:00.000Z');
    const updated = await new SaveJournalEntryUseCase(entries, chart, ids(), () => later)
      .execute({ ...balanced, id: created.id, description: '直した' });
    expect(updated.createdAt).toBe(NOW.toISOString());
    expect(updated.updatedAt).toBe(later.toISOString());
    expect(updated.status).toBe('confirmed');
    expect(updated.description).toBe('直した');
  });

  it('異常: マスタに無い科目は JournalDomainError', async () => {
    const usecase = new SaveJournalEntryUseCase(new InMemoryJournalEntryRepository(), await charts(), ids(), clock);
    await expect(usecase.execute({ ...balanced, lines: [{ ...balanced.lines[0]!, accountId: 'expense.nope' }, balanced.lines[1]!] }))
      .rejects.toThrow(/expense\.nope/);
  });

  it('異常: 無効化された科目も断る', async () => {
    const repo = new InMemoryChartOfAccountsRepository();
    await repo.save(scope, createChartOfAccounts({
      ...DEFAULT_CHART_OF_ACCOUNTS,
      accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts.map((account) => (account.id === 'asset.cash' ? { ...account, enabled: false } : account)),
    }));
    await expect(new SaveJournalEntryUseCase(new InMemoryJournalEntryRepository(), repo, ids(), clock).execute(balanced))
      .rejects.toThrow(/disabled account/);
  });

  it('異常: 貸借が一致しなければ domain が弾く', async () => {
    const usecase = new SaveJournalEntryUseCase(new InMemoryJournalEntryRepository(), await charts(), ids(), clock);
    await expect(usecase.execute({ ...balanced, lines: [balanced.lines[0]!, { ...balanced.lines[1]!, amount: 1000 }] }))
      .rejects.toThrow(JournalDomainError);
  });

  it('異常: 借方だけ・貸方だけの仕訳は作れない', async () => {
    const usecase = new SaveJournalEntryUseCase(new InMemoryJournalEntryRepository(), await charts(), ids(), clock);
    await expect(usecase.execute({ ...balanced, lines: [balanced.lines[0]!] })).rejects.toThrow(JournalDomainError);
  });
});

describe('ListJournalEntriesUseCase', () => {
  it('正常: 絞り込みをリポジトリへ渡す', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const chart = await charts();
    const save = new SaveJournalEntryUseCase(entries, chart, ids(), clock);
    await save.execute(balanced);
    await save.execute({ ...balanced, date: '2026-08-01' });

    expect(await new ListJournalEntriesUseCase(entries).execute(scope)).toHaveLength(2);
    expect(await new ListJournalEntriesUseCase(entries).execute(scope, { from: '2026-09-01' })).toHaveLength(1);
    expect(await new ListJournalEntriesUseCase(entries).execute(scope, { status: 'confirmed' })).toHaveLength(0);
  });
});

describe('ConfirmJournalEntryUseCase', () => {
  it('正常: draft → confirmed。確定済みは冪等', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const created = await new SaveJournalEntryUseCase(entries, await charts(), ids(), clock).execute(balanced);
    const usecase = new ConfirmJournalEntryUseCase(entries, clock);

    expect((await usecase.execute(scope, created.id)).status).toBe('confirmed');
    expect((await usecase.execute(scope, created.id)).status).toBe('confirmed');
  });

  it('異常: 出力済みの仕訳は確定し直せない', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const created = await new SaveJournalEntryUseCase(entries, await charts(), ids(), clock).execute(balanced);
    await entries.save({ ...(await entries.findById(scope, created.id))!, status: 'exported' });
    await expect(new ConfirmJournalEntryUseCase(entries, clock).execute(scope, created.id)).rejects.toThrow(JournalDomainError);
  });

  it('異常: 無い仕訳は JournalEntryNotFoundError', async () => {
    await expect(new ConfirmJournalEntryUseCase(new InMemoryJournalEntryRepository(), clock).execute(scope, 'missing'))
      .rejects.toThrow(JournalEntryNotFoundError);
  });
});

describe('DeleteJournalEntryUseCase', () => {
  async function seeded() {
    const entries = new InMemoryJournalEntryRepository();
    const documents = new InMemoryJournalDocumentRepository();
    const created = await new SaveJournalEntryUseCase(entries, await charts(), ids(), clock).execute({ ...balanced, documentId: 'doc-1' });
    await documents.save(createJournalDocument({
      tenant: scope, id: 'doc-1', kind: 'invoice', source: { type: 'structured' },
      facts: { direction: 'out', transactionDate: '2026-09-10', grandTotal: 1100 },
      status: 'decided', entryId: created.id,
      judgment: { stage: 'decided', ruleId: 'r1', entryId: created.id, specificity: 2, candidates: [], judgedAt: NOW.toISOString() },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
    return { entries, documents, id: created.id };
  }

  it('正常: 削除すると紐づく文書は未判定へ戻る（参照切れの entryId を残さない）', async () => {
    const { entries, documents, id } = await seeded();
    await new DeleteJournalEntryUseCase(entries, documents, clock).execute(scope, id);

    expect(await entries.findById(scope, id)).toBeNull();
    const document = await documents.findById(scope, 'doc-1');
    expect(document?.status).toBe('extracted');
    expect(document?.entryId).toBeUndefined();
    expect(document?.judgment).toBeUndefined();
  });

  it('境界: 別の仕訳へ差し替わっている文書には触らない', async () => {
    const { entries, documents, id } = await seeded();
    await documents.save({ ...(await documents.findById(scope, 'doc-1'))!, entryId: 'other-entry' });

    await new DeleteJournalEntryUseCase(entries, documents, clock).execute(scope, id);
    const document = await documents.findById(scope, 'doc-1');
    expect(document?.status).toBe('decided');
    expect(document?.entryId).toBe('other-entry');
  });

  it('境界: 文書に紐づかない手入力の仕訳もそのまま消せる', async () => {
    const entries = new InMemoryJournalEntryRepository();
    const created = await new SaveJournalEntryUseCase(entries, await charts(), ids(), clock).execute(balanced);
    await new DeleteJournalEntryUseCase(entries, new InMemoryJournalDocumentRepository(), clock).execute(scope, created.id);
    expect(await entries.findById(scope, created.id)).toBeNull();
  });

  it('異常: 無い仕訳の削除は JournalEntryNotFoundError', async () => {
    await expect(new DeleteJournalEntryUseCase(new InMemoryJournalEntryRepository(), new InMemoryJournalDocumentRepository(), clock).execute(scope, 'missing'))
      .rejects.toThrow(JournalEntryNotFoundError);
  });
});