import { describe, expect, it } from 'vitest';
import {
  InMemoryChartOfAccountsRepository, InMemoryJournalDocumentRepository,
  InMemoryJournalEntryRepository, InMemoryJournalRuleRepository,
} from '../../adapters/storage/in-memory-journal-repositories';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createJournalDocument, type DocumentKind } from '../../domain/journal/document';
import { createJournalRule } from '../../domain/journal/rule';
import { JudgeJournalDocumentsUseCase } from './judge-documents';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

function ids(): () => string {
  let counter = 0;
  return () => `entry-${(counter += 1)}`;
}

async function setup(options: { readonly withRule?: boolean } = {}) {
  const documents = new InMemoryJournalDocumentRepository();
  const rules = new InMemoryJournalRuleRepository();
  const charts = new InMemoryChartOfAccountsRepository();
  const entries = new InMemoryJournalEntryRepository();
  await charts.save(scope, DEFAULT_CHART_OF_ACCOUNTS);
  if (options.withRule !== false) {
    await rules.save(createJournalRule({
      tenant: scope, id: 'rule-1', name: 'テスト', enabled: true, mode: 'auto', priority: 100, scope: {},
      conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'テスト' }],
      outcome: { lines: [
        { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] },
      askIf: [], requiredFacts: [],
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
  }
  const usecase = new JudgeJournalDocumentsUseCase(documents, rules, charts, entries, ids(), clock);
  return { documents, rules, charts, entries, usecase };
}

async function addDocument(documents: InMemoryJournalDocumentRepository, id: string, overrides: Record<string, unknown> = {}) {
  const document = createJournalDocument({
    tenant: scope, id, kind: 'invoice', source: { type: 'structured' },
    facts: { direction: 'out', transactionDate: '2026-09-10', grandTotal: 1100, descriptionNorm: 'テスト仕入' },
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    ...overrides,
  });
  await documents.save(document);
  return document;
}

describe('JudgeJournalDocumentsUseCase', () => {
  it('正常: 確定したら仕訳（下書き）を作り、文書を decided にして紐づける', async () => {
    const { documents, entries, usecase } = await setup();
    await addDocument(documents, 'doc-1');

    const result = await usecase.execute({ scope });
    expect(result).toMatchObject({ decided: 1, undecided: 0, skipped: 0 });
    expect(result.judged).toHaveLength(1);

    const document = await documents.findById(scope, 'doc-1');
    expect(document?.status).toBe('decided');
    expect(document?.entryId).toBe('entry-1');
    expect(document?.judgment).toMatchObject({ stage: 'decided', ruleId: 'rule-1', entryId: 'entry-1' });

    const entry = await entries.findById(scope, 'entry-1');
    expect(entry).toMatchObject({ documentId: 'doc-1', ruleId: 'rule-1', status: 'draft', decidedBy: 'rule' });
    expect(entry?.lines).toHaveLength(2);
  });

  it('正常: 該当ルールが無ければ undecided（no-rule）— 例外にしない', async () => {
    const { documents, entries, usecase } = await setup({ withRule: false });
    await addDocument(documents, 'doc-1');

    const result = await usecase.execute({ scope });
    expect(result).toMatchObject({ decided: 0, undecided: 1 });
    const document = await documents.findById(scope, 'doc-1');
    expect(document?.status).toBe('undecided');
    expect(document?.judgment).toMatchObject({ stage: 'undecided', reasons: [{ code: 'no-rule' }] });
    expect(await entries.list(scope)).toEqual([]);
  });

  it('正常: 見積・納品は判定キューに乗せず skipped', async () => {
    const { documents, usecase } = await setup();
    await addDocument(documents, 'doc-1', { kind: 'quotation' as DocumentKind });

    const result = await usecase.execute({ scope });
    expect(result).toMatchObject({ skipped: 1, decided: 0, undecided: 0 });
    expect((await documents.findById(scope, 'doc-1'))?.status).toBe('skipped');
    expect((await documents.findById(scope, 'doc-1'))?.judgment).toMatchObject({ stage: 'skipped', reason: 'document-kind' });
  });

  it('境界: documentIds 省略時の対象は extracted / undecided だけ（decided は触らない）', async () => {
    const { documents, usecase } = await setup();
    await addDocument(documents, 'extracted-doc');
    await addDocument(documents, 'undecided-doc', { status: 'undecided' });
    await addDocument(documents, 'decided-doc', { status: 'decided', entryId: 'existing' });
    await addDocument(documents, 'skipped-doc', { status: 'skipped' });

    const result = await usecase.execute({ scope });
    expect(result.judged.map((summary) => summary.id).sort()).toEqual(['extracted-doc', 'undecided-doc']);
  });

  it('境界: documentIds を指定すればその文書だけを判定する', async () => {
    const { documents, usecase } = await setup();
    await addDocument(documents, 'doc-1');
    await addDocument(documents, 'doc-2');

    const result = await usecase.execute({ scope, documentIds: ['doc-2'] });
    expect(result.judged.map((summary) => summary.id)).toEqual(['doc-2']);
    expect((await documents.findById(scope, 'doc-1'))?.status).toBe('extracted');
  });

  it('境界: 出力済みの文書は明示指定しても飛ばす（1 件の状態で一括判定を落とさない）', async () => {
    const { documents, usecase } = await setup();
    await addDocument(documents, 'exported-doc', { status: 'exported', entryId: 'e1' });

    const result = await usecase.execute({ scope, documentIds: ['exported-doc'] });
    expect(result.judged).toEqual([]);
    expect((await documents.findById(scope, 'exported-doc'))?.status).toBe('exported');
  });

  it('正常: 再判定で下書きの仕訳は同じ id のまま中身が入れ替わる（下書きが増殖しない）', async () => {
    const { documents, entries, usecase } = await setup();
    await addDocument(documents, 'doc-1');
    await usecase.execute({ scope });
    const first = await entries.findById(scope, 'entry-1');
    expect(first?.status).toBe('draft');

    // 金額を変えてから再判定する。
    const document = (await documents.findById(scope, 'doc-1'))!;
    await documents.save({ ...document, status: 'undecided', facts: { ...document.facts, grandTotal: 3300 } });
    await usecase.execute({ scope });

    expect(await entries.list(scope)).toHaveLength(1);
    const second = await entries.findById(scope, 'entry-1');
    expect(second?.lines[0]?.amount).toBe(3300);
    expect(second?.createdAt).toBe(first?.createdAt);
  });

  it('境界: **確定済みの仕訳は再判定で上書きしない**（利用者の確認結果を守る）', async () => {
    const { documents, entries, usecase } = await setup();
    await addDocument(documents, 'doc-1');
    await usecase.execute({ scope });

    // 利用者が金額を直して確定した状態を作る。
    const confirmed = { ...(await entries.findById(scope, 'entry-1'))!, status: 'confirmed' as const, description: '利用者が直した摘要' };
    await entries.save(confirmed);
    // 文書側の facts を変えてから再判定する。
    const document = (await documents.findById(scope, 'doc-1'))!;
    await documents.save({ ...document, facts: { ...document.facts, grandTotal: 9999 } });

    const result = await usecase.execute({ scope, documentIds: ['doc-1'] });

    // 仕訳は一切変わらない。
    const after = await entries.findById(scope, 'entry-1');
    expect(after).toEqual(confirmed);
    expect(after?.description).toBe('利用者が直した摘要');
    expect(await entries.list(scope)).toHaveLength(1);
    // 文書は decided のままで、同じ仕訳を指し続ける。
    expect(result).toMatchObject({ decided: 1 });
    const updated = await documents.findById(scope, 'doc-1');
    expect(updated?.status).toBe('decided');
    expect(updated?.entryId).toBe('entry-1');
  });

  it('境界: 出力済みの仕訳も同じく上書きしない', async () => {
    const { documents, entries, usecase } = await setup();
    await addDocument(documents, 'doc-1');
    await usecase.execute({ scope });
    const exported = { ...(await entries.findById(scope, 'entry-1'))!, status: 'exported' as const };
    await entries.save(exported);

    await usecase.execute({ scope, documentIds: ['doc-1'] });
    expect(await entries.findById(scope, 'entry-1')).toEqual(exported);
  });

  it('境界: マスタから消えた科目を指すルールは unknown-account として未確定になる', async () => {
    const { documents, rules, entries, usecase } = await setup({ withRule: false });
    await rules.save(createJournalRule({
      tenant: scope, id: 'rule-broken', name: '壊れたルール', enabled: true, mode: 'auto', priority: 100, scope: {},
      conditions: [], outcome: { lines: [
        { side: 'debit', accountId: 'expense.deleted', taxCode: 'JP-IN-10-S', amount: 'total' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] },
      askIf: [], requiredFacts: [],
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
    await addDocument(documents, 'doc-1');

    const result = await usecase.execute({ scope });
    expect(result).toMatchObject({ undecided: 1, decided: 0 });
    expect((await documents.findById(scope, 'doc-1'))?.judgment).toMatchObject({
      stage: 'undecided', reasons: [{ code: 'unknown-account', accountIds: ['expense.deleted'] }],
    });
    expect(await entries.list(scope)).toEqual([]);
  });

  it('境界: 対象が無ければ 0 件で成功する', async () => {
    const { usecase } = await setup();
    expect(await usecase.execute({ scope })).toEqual({ judged: [], decided: 0, undecided: 0, skipped: 0 });
  });
});