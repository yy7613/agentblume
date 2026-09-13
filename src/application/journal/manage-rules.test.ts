import { describe, expect, it } from 'vitest';
import { InMemoryChartOfAccountsRepository, InMemoryJournalDocumentRepository, InMemoryJournalRuleRepository } from '../../adapters/storage/in-memory-journal-repositories';
import { createJournalDocument } from '../../domain/journal/document';
import { JournalRuleNotFoundError } from '../../domain/journal/errors';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../../domain/journal/default-chart';
import { createChartOfAccounts } from '../../domain/journal/chart-of-accounts';
import type { JournalRuleDraft } from '../../domain/journal/rule';
import { DeleteJournalRuleUseCase, ListJournalRulesUseCase, SaveJournalRuleUseCase, TestJournalRuleUseCase } from './manage-rules';

const scope = { tenantId: 't', workspaceId: 'w' };
const NOW = new Date('2026-09-13T10:00:00.000Z');
const clock = (): Date => NOW;

function ids(): () => string {
  let counter = 0;
  return () => `rule-${(counter += 1)}`;
}

const draft: JournalRuleDraft = {
  name: 'テスト消耗品',
  enabled: true,
  mode: 'auto',
  priority: 100,
  scope: {},
  conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'テスト' }],
  outcome: {
    lines: [
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ],
  },
  askIf: [],
  requiredFacts: [],
};

async function seededCharts() {
  const charts = new InMemoryChartOfAccountsRepository();
  await charts.save(scope, DEFAULT_CHART_OF_ACCOUNTS);
  return charts;
}

describe('SaveJournalRuleUseCase', () => {
  it('正常: id 省略で新規作成（makeId で採番し createdAt = 保存時刻）', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const rule = await new SaveJournalRuleUseCase(rules, await seededCharts(), ids(), clock).execute({ scope, rule: draft });
    expect(rule.id).toBe('rule-1');
    expect(rule.createdAt).toBe(NOW.toISOString());
    expect(rule.updatedAt).toBe(NOW.toISOString());
    expect(await rules.findById(scope, 'rule-1')).not.toBeNull();
  });

  it('正常: 既存 id の更新は createdAt を保つ（編集で優先順が入れ替わらない）', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const charts = await seededCharts();
    const created = await new SaveJournalRuleUseCase(rules, charts, ids(), clock).execute({ scope, rule: draft });

    const later = new Date('2026-09-20T00:00:00.000Z');
    const updated = await new SaveJournalRuleUseCase(rules, charts, ids(), () => later)
      .execute({ scope, rule: { ...draft, id: created.id, name: '改名' } });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('改名');
    expect(updated.createdAt).toBe(NOW.toISOString());
    expect(updated.updatedAt).toBe(later.toISOString());
  });

  it('境界: 未知の id を指定すればその id で新規作成する', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const rule = await new SaveJournalRuleUseCase(rules, await seededCharts(), ids(), clock).execute({ scope, rule: { ...draft, id: 'chosen' } });
    expect(rule.id).toBe('chosen');
    expect(rule.createdAt).toBe(NOW.toISOString());
  });

  it('異常: マスタに無い科目・税区分を指す outcome は JournalDomainError', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const charts = await seededCharts();
    const usecase = new SaveJournalRuleUseCase(rules, charts, ids(), clock);

    await expect(usecase.execute({ scope, rule: { ...draft, outcome: { lines: [
      { side: 'debit', accountId: 'expense.nope', taxCode: 'JP-IN-10-S', amount: 'total' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ] } } })).rejects.toThrow(/expense\.nope/);

    await expect(usecase.execute({ scope, rule: { ...draft, outcome: { lines: [
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NOPE', amount: 'total' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ] } } })).rejects.toThrow(/JP-NOPE/);

    // 弾かれたルールは保存されない。
    expect(await rules.list(scope)).toEqual([]);
  });

  it('異常: 無効化された科目を指す outcome も断る（判定のたびに unknown-account になるため）', async () => {
    const charts = new InMemoryChartOfAccountsRepository();
    await charts.save(scope, createChartOfAccounts({
      ...DEFAULT_CHART_OF_ACCOUNTS,
      accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts.map((account) => (account.id === 'expense.supplies' ? { ...account, enabled: false } : account)),
    }));
    await expect(new SaveJournalRuleUseCase(new InMemoryJournalRuleRepository(), charts, ids(), clock).execute({ scope, rule: draft }))
      .rejects.toThrow(/disabled account/);
  });

  it('境界: マスタ未保存のワークスペースは標準セットで検査する', async () => {
    const rule = await new SaveJournalRuleUseCase(new InMemoryJournalRuleRepository(), new InMemoryChartOfAccountsRepository(), ids(), clock)
      .execute({ scope, rule: draft });
    expect(rule.id).toBe('rule-1');
  });
});

describe('ListJournalRulesUseCase / DeleteJournalRuleUseCase', () => {
  it('正常: 一覧はリポジトリの並び（priority 降順）。削除できる', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const charts = await seededCharts();
    const save = new SaveJournalRuleUseCase(rules, charts, ids(), clock);
    await save.execute({ scope, rule: { ...draft, priority: 10 } });
    await save.execute({ scope, rule: { ...draft, priority: 900 } });

    const listed = await new ListJournalRulesUseCase(rules).execute(scope);
    expect(listed.map((rule) => rule.priority)).toEqual([900, 10]);

    await new DeleteJournalRuleUseCase(rules).execute(scope, listed[0]!.id);
    expect(await new ListJournalRulesUseCase(rules).execute(scope)).toHaveLength(1);
  });

  it('異常: 存在しないルールの削除は JournalRuleNotFoundError（404 になる）', async () => {
    await expect(new DeleteJournalRuleUseCase(new InMemoryJournalRuleRepository()).execute(scope, 'missing'))
      .rejects.toThrow(JournalRuleNotFoundError);
  });
});

describe('TestJournalRuleUseCase', () => {
  async function seededDocuments() {
    const documents = new InMemoryJournalDocumentRepository();
    await documents.save(createJournalDocument({
      tenant: scope, id: 'hit', kind: 'invoice', source: { type: 'structured' },
      facts: { direction: 'out', transactionDate: '2026-09-10', grandTotal: 1100, descriptionNorm: 'テスト仕入' },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
    await documents.save(createJournalDocument({
      tenant: scope, id: 'miss', kind: 'invoice', source: { type: 'structured' },
      facts: { direction: 'out', transactionDate: '2026-09-10', grandTotal: 500, descriptionNorm: '別の取引' },
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    }));
    return documents;
  }

  it('正常: 一致した文書は仕訳草案と特異度つき、一致しない文書は matched: false', async () => {
    const usecase = new TestJournalRuleUseCase(await seededDocuments(), await seededCharts(), clock);
    const result = await usecase.execute({ scope, rule: draft, documentIds: ['hit', 'miss'] });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ documentId: 'hit', matched: true });
    expect(result[0]?.entry?.lines).toHaveLength(2);
    expect(result[0]?.specificity).toBeGreaterThan(0);
    expect(result[1]).toEqual({ documentId: 'miss', matched: false });
  });

  it('正常: requiredFacts が足りなければ missing-fact を返す（仕訳は作らない）', async () => {
    const usecase = new TestJournalRuleUseCase(await seededDocuments(), await seededCharts(), clock);
    const result = await usecase.execute({ scope, rule: { ...draft, requiredFacts: ['issuerName'] }, documentIds: ['hit'] });
    expect(result[0]).toMatchObject({ matched: true, reasons: [{ code: 'missing-fact', facts: ['issuerName'] }] });
    expect(result[0]?.entry).toBeUndefined();
  });

  it('正常: askIf に該当すれば ask-if を返す', async () => {
    const usecase = new TestJournalRuleUseCase(await seededDocuments(), await seededCharts(), clock);
    const result = await usecase.execute({
      scope, documentIds: ['hit'],
      rule: { ...draft, askIf: [{ conditions: [{ field: 'grandTotal', op: 'gte', value: 1000 }], questionId: 'fixed_asset_check', prompt: '確認' }] },
    });
    expect(result[0]?.reasons).toEqual([{ code: 'ask-if', ruleId: 'draft', questionId: 'fixed_asset_check', prompt: '確認' }]);
  });

  it('境界: 見つからない文書 id は結果に現れない。何も保存しない', async () => {
    const rules = new InMemoryJournalRuleRepository();
    const usecase = new TestJournalRuleUseCase(await seededDocuments(), await seededCharts(), clock);
    const result = await usecase.execute({ scope, rule: draft, documentIds: ['missing', 'hit'] });
    expect(result.map((entry) => entry.documentId)).toEqual(['hit']);
    expect(await rules.list(scope)).toEqual([]);
  });

  it('境界: 未保存の草案の理由には id として draft が載る', async () => {
    const usecase = new TestJournalRuleUseCase(await seededDocuments(), await seededCharts(), clock);
    const result = await usecase.execute({ scope, rule: { ...draft, requiredFacts: ['issuerName'] }, documentIds: ['hit'] });
    expect(result[0]?.reasons?.[0]).toMatchObject({ ruleId: 'draft' });
  });
});