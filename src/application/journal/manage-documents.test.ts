import { describe, expect, it } from 'vitest';
import { InMemoryJournalDocumentRepository, InMemoryJournalEntryRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { createJournalEntry } from '../../domain/journal/entry';
import { JournalDocumentNotFoundError } from '../../domain/journal/errors';
import {
  DeleteJournalDocumentUseCase, GetJournalDocumentUseCase, ListJournalDocumentsUseCase,
  normalizeJournalFacts, SaveJournalDocumentUseCase,
} from './manage-documents';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

function ids(): () => string {
  let counter = 0;
  return () => `doc-${(counter += 1)}`;
}

const baseInput = {
  scope,
  kind: 'invoice' as const,
  source: { type: 'structured' as const },
  facts: { direction: 'out' as const, transactionDate: '2026-09-10', grandTotal: 1100, description: '振込 ｶ)ヤマダ' },
};

describe('normalizeJournalFacts', () => {
  it('正常: descriptionNorm を作り、相手先を切り出す（法人略号は落ちる）', () => {
    const facts = normalizeJournalFacts({ description: '振込 ｶ)ヤマダ' });
    expect(facts.descriptionNorm).toBe('振込 ヤマダ');
    expect(facts.counterpartyHint).toBe('ヤマダ');
  });

  it('正常: 登録番号を T + 13 桁へ寄せる（ハイフン・全角・小文字）', () => {
    expect(normalizeJournalFacts({ registrationNumber: 't-1234-5678-90123' }).registrationNumber).toBe('T1234567890123');
    expect(normalizeJournalFacts({ registrationNumber: 'Ｔ1234567890123' }).registrationNumber).toBe('T1234567890123');
  });

  it('境界: 形の合わない登録番号は「未取得」として落とす（保存が 400 にならない）', () => {
    expect(normalizeJournalFacts({ registrationNumber: 'ただの文字列' }).registrationNumber).toBeUndefined();
    expect(normalizeJournalFacts({ registrationNumber: 'T123' }).registrationNumber).toBeUndefined();
  });

  it('境界: 原文が無ければ渡された descriptionNorm を尊重する。指定済みの相手先は上書きしない', () => {
    expect(normalizeJournalFacts({ descriptionNorm: '手で正規化した' }).descriptionNorm).toBe('手で正規化した');
    expect(normalizeJournalFacts({ description: '振込 ｶ)ヤマダ', counterpartyHint: '指定済み' }).counterpartyHint).toBe('指定済み');
  });

  it('境界: 原文を直せば正規化も作り直される（古い正規化が残らない）', () => {
    expect(normalizeJournalFacts({ description: '新しい摘要', descriptionNorm: '古い正規化' }).descriptionNorm).toBe('新しい摘要');
  });
});

describe('SaveJournalDocumentUseCase', () => {
  it('正常: id 省略で新規作成し、facts を正規化して保存する', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const document = await new SaveJournalDocumentUseCase(documents, ids(), clock).execute(baseInput);
    expect(document.id).toBe('doc-1');
    expect(document.status).toBe('extracted');
    expect(document.createdAt).toBe(NOW.toISOString());
    expect(document.facts.descriptionNorm).toBe('振込 ヤマダ');
    expect(document.facts.counterpartyHint).toBe('ヤマダ');
    expect(await documents.findById(scope, 'doc-1')).not.toBeNull();
  });

  it('正常: 更新は createdAt を保つ', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const created = await new SaveJournalDocumentUseCase(documents, ids(), clock).execute(baseInput);
    const later = new Date('2026-09-20T00:00:00.000Z');
    const updated = await new SaveJournalDocumentUseCase(documents, ids(), () => later).execute({ ...baseInput, id: created.id, kind: 'receipt' });
    expect(updated.createdAt).toBe(NOW.toISOString());
    expect(updated.updatedAt).toBe(later.toISOString());
    expect(updated.kind).toBe('receipt');
  });

  it('正常: facts が変われば judgment / entryId を落として未判定へ戻す', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const save = new SaveJournalDocumentUseCase(documents, ids(), clock);
    const created = await save.execute(baseInput);
    // 判定済みの状態を作る。
    await documents.save({
      ...created, status: 'decided', entryId: 'entry-1',
      judgment: { stage: 'decided', ruleId: 'r1', entryId: 'entry-1', specificity: 3, candidates: [], judgedAt: NOW.toISOString() },
    });

    const updated = await save.execute({ ...baseInput, id: created.id, facts: { ...baseInput.facts, grandTotal: 2200 } });
    expect(updated.status).toBe('extracted');
    expect(updated.judgment).toBeUndefined();
    expect(updated.entryId).toBeUndefined();
  });

  it('境界: facts が同じなら状態・判定結果・仕訳参照を保つ（種別や添付だけ直した場合）', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const save = new SaveJournalDocumentUseCase(documents, ids(), clock);
    const created = await save.execute(baseInput);
    await documents.save({
      ...created, status: 'decided', entryId: 'entry-1',
      judgment: { stage: 'decided', ruleId: 'r1', entryId: 'entry-1', specificity: 3, candidates: [], judgedAt: NOW.toISOString() },
    });

    const updated = await save.execute({ ...baseInput, id: created.id, source: { type: 'structured', fileName: '添付.json' } });
    expect(updated.status).toBe('decided');
    expect(updated.entryId).toBe('entry-1');
    expect(updated.judgment).toMatchObject({ stage: 'decided' });
    expect(updated.source.fileName).toBe('添付.json');
  });
});

describe('ListJournalDocumentsUseCase / GetJournalDocumentUseCase', () => {
  it('正常: 一覧は要約、単体は本体を返す', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const created = await new SaveJournalDocumentUseCase(documents, ids(), clock).execute({
      ...baseInput, source: { type: 'text', text: '原文テキスト' },
    });

    const summaries = await new ListJournalDocumentsUseCase(documents).execute(scope);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('source');
    expect(JSON.stringify(summaries[0])).not.toContain('原文テキスト');

    const single = await new GetJournalDocumentUseCase(documents).execute(scope, created.id);
    expect(single.source.text).toBe('原文テキスト');
  });

  it('正常: 一覧は絞り込みをリポジトリへ渡す', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const save = new SaveJournalDocumentUseCase(documents, ids(), clock);
    await save.execute(baseInput);
    await save.execute({ ...baseInput, kind: 'receipt' });
    expect(await new ListJournalDocumentsUseCase(documents).execute(scope, { kind: 'receipt' })).toHaveLength(1);
  });

  it('異常: 無い文書の取得は JournalDocumentNotFoundError', async () => {
    await expect(new GetJournalDocumentUseCase(new InMemoryJournalDocumentRepository()).execute(scope, 'missing'))
      .rejects.toThrow(JournalDocumentNotFoundError);
  });
});

describe('DeleteJournalDocumentUseCase', () => {
  async function seeded(entryStatus: 'draft' | 'confirmed') {
    const documents = new InMemoryJournalDocumentRepository();
    const entries = new InMemoryJournalEntryRepository();
    const created = await new SaveJournalDocumentUseCase(documents, ids(), clock).execute(baseInput);
    await entries.save(createJournalEntry({
      tenant: scope, id: 'entry-1', documentId: created.id, date: '2026-09-10',
      lines: [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1100 },
      ],
      description: 'テスト', invoiceStatus: 'qualified', status: entryStatus, decidedBy: 'rule',
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
    await documents.save({ ...(await documents.findById(scope, created.id))!, status: 'decided', entryId: 'entry-1' });
    return { documents, entries, id: created.id };
  }

  it('正常: 下書きの仕訳は文書と一緒に消える（出所不明の下書きを残さない）', async () => {
    const { documents, entries, id } = await seeded('draft');
    await new DeleteJournalDocumentUseCase(documents, entries).execute(scope, id);
    expect(await documents.findById(scope, id)).toBeNull();
    expect(await entries.findById(scope, 'entry-1')).toBeNull();
  });

  it('境界: 確定済みの仕訳は残す（会計上の記録を消さない）', async () => {
    const { documents, entries, id } = await seeded('confirmed');
    await new DeleteJournalDocumentUseCase(documents, entries).execute(scope, id);
    expect(await documents.findById(scope, id)).toBeNull();
    expect(await entries.findById(scope, 'entry-1')).not.toBeNull();
  });

  it('境界: 仕訳が紐づかない文書もそのまま消せる', async () => {
    const documents = new InMemoryJournalDocumentRepository();
    const created = await new SaveJournalDocumentUseCase(documents, ids(), clock).execute(baseInput);
    await new DeleteJournalDocumentUseCase(documents, new InMemoryJournalEntryRepository()).execute(scope, created.id);
    expect(await documents.findById(scope, created.id)).toBeNull();
  });

  it('異常: 無い文書の削除は JournalDocumentNotFoundError', async () => {
    await expect(new DeleteJournalDocumentUseCase(new InMemoryJournalDocumentRepository(), new InMemoryJournalEntryRepository()).execute(scope, 'missing'))
      .rejects.toThrow(JournalDocumentNotFoundError);
  });
});