import { describe, expect, it } from 'vitest';
import { DEFAULT_CHART_OF_ACCOUNTS } from './default-chart';
import { createJournalDocument } from './document';
import { createJournalEntry } from './entry';
import { entryProps } from './entry.test';
import { JournalDomainError } from './errors';
import { createHearingSession } from './hearing';
import { createJournalRule } from './rule';
import { ruleProps } from './rule.test';
import { deserializeChartOfAccounts, deserializeHearingSession, deserializeJournalDocument, deserializeJournalEntry, deserializeJournalRule, serializeChartOfAccounts, serializeHearingSession, serializeJournalDocument, serializeJournalEntry, serializeJournalRule } from './serialization';
import { AMBIGUITY_CATALOG, findAmbiguityCase } from './ambiguity-catalog';

const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-13T00:00:00.000Z';

describe('serialization round trips', () => {
  it('正常: 科目マスタ・文書・ルール・仕訳・ヒアリングが JSON を経由して等価に戻る', () => {
    const chart = DEFAULT_CHART_OF_ACCOUNTS;
    expect(deserializeChartOfAccounts(JSON.parse(JSON.stringify(serializeChartOfAccounts(chart))))).toEqual(chart);
    const document = createJournalDocument({ tenant, id: 'd', kind: 'invoice', source: { type: 'text', text: 'hello' }, facts: { grandTotal: 1, extra: { a: [1, 'x', null] } }, status: 'undecided', judgment: { stage: 'undecided', reasons: [{ code: 'no-rule' }], candidates: [], judgedAt: at }, createdAt: at, updatedAt: at });
    expect(deserializeJournalDocument(JSON.parse(JSON.stringify(serializeJournalDocument(document))))).toEqual(document);
    const rule = createJournalRule(ruleProps({ askIf: [{ conditions: [{ field: 'grandTotal', op: 'gte', value: 1 }], questionId: 'q', prompt: 'p' }], outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: { ratio: 0.5 }, partnerFrom: { fixed: 'x' } }, { side: 'credit', accountId: 'b', taxCode: 't', amount: 'remainder' }] } }));
    expect(deserializeJournalRule(JSON.parse(JSON.stringify(serializeJournalRule(rule))))).toEqual(rule);
    const entry = createJournalEntry(entryProps({ tags: ['t'], confidence: 0.5 }));
    expect(deserializeJournalEntry(JSON.parse(JSON.stringify(serializeJournalEntry(entry))))).toEqual(entry);
    const hearing = createHearingSession({ tenant, id: 'h', documentId: 'd', turns: [{ role: 'assistant', question: { id: 'q', text: 't', kind: 'text' }, at }], createdAt: at, updatedAt: at });
    expect(deserializeHearingSession(JSON.parse(JSON.stringify(serializeHearingSession(hearing))))).toEqual(hearing);
  });

  it('境界: 直列化は複製（元の参照を共有しない）', () => {
    const entry = createJournalEntry(entryProps());
    const serialized = serializeJournalEntry(entry);
    expect(serialized).not.toBe(entry);
    expect(serialized.lines).not.toBe(entry.lines);
  });

  it('異常: 形が壊れている（必須キー欠落・型違い）は JournalDomainError で、黙って null にしない', () => {
    expect(() => deserializeJournalDocument({ id: 'x' })).toThrow(JournalDomainError);
    expect(() => deserializeJournalRule({ tenant, id: 'r', name: 1 })).toThrow(/deserializeJournalRule: invalid record/u);
    expect(() => deserializeJournalEntry('nope')).toThrow(/deserializeJournalEntry: invalid record/u);
    expect(() => deserializeHearingSession(null)).toThrow(JournalDomainError);
    expect(() => deserializeChartOfAccounts({ accounts: [] })).toThrow(/deserializeChartOfAccounts: invalid record/u);
  });

  it('異常: 形は合っていても不変条件を破る（貸借不一致）は create* が拒む', () => {
    const entry = serializeJournalEntry(createJournalEntry(entryProps()));
    const broken = { ...entry, lines: [entry.lines[0], { ...entry.lines[1]!, amount: 1 }] };
    expect(() => deserializeJournalEntry(broken)).toThrow(/debit total/u);
  });
});

describe('AMBIGUITY_CATALOG', () => {
  it('正常: docs/20 §4 の 12 件。id は一意で、各エントリに質問・選択肢・書き戻し先がある', () => {
    expect(AMBIGUITY_CATALOG.map((entry) => entry.id)).toEqual(['meal_purpose', 'ec_item_type', 'fixed_asset_check', 'transport_kind', 'prepaid_period', 'withholding_check', 'invoice_registration', 'tax_exempt_kind', 'household_ratio', 'bank_transfer_in', 'account_transfer', 'reduced_rate_check']);
    for (const entry of AMBIGUITY_CATALOG) {
      expect(entry.question.length).toBeGreaterThan(0);
      expect(entry.options.length).toBeGreaterThan(0);
      expect(entry.factPath.startsWith('extra.')).toBe(true);
      expect(new Set(entry.options.map((option) => option.value)).size).toBe(entry.options.length);
    }
    expect(findAmbiguityCase('meal_purpose')?.options.map((option) => option.sets?.accountHint)).toEqual(['接待交際費', '会議費', '福利厚生費', '事業主貸']);
    expect(findAmbiguityCase('nope')).toBeUndefined();
  });
});
