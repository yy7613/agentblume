import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateConditions, hasFact, readFactPath } from './conditions';
import type { DocumentFacts } from './document';
import { JournalDomainError } from './errors';
import { compareRulePrecedence, createJournalRule, ruleSpecificity, type CreateJournalRuleProps, type RuleCondition } from './rule';

const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-13T00:00:00.000Z';

export function ruleProps(overrides: Partial<CreateJournalRuleProps> = {}): CreateJournalRuleProps {
  return {
    tenant, id: 'rule-1', name: 'Amazon は消耗品', enabled: true, mode: 'auto', priority: 10,
    scope: { direction: 'out' },
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'amazon' }],
    outcome: { lines: [{ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 'total' }], descriptionTemplate: '{counterpartyHint} {description}', invoiceStatus: 'auto' },
    askIf: [], requiredFacts: [],
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

describe('createJournalRule', () => {
  it('正常: 検証して複製する（名前 trim、provenance 既定 manual、scope 省略は空）', () => {
    const rule = createJournalRule(ruleProps({ name: '  Amazon  ', scope: undefined as unknown as CreateJournalRuleProps['scope'] }));
    expect(rule.name).toBe('Amazon');
    expect(rule.scope).toEqual({});
    expect(rule.provenance).toEqual({ origin: 'manual', exampleDocumentIds: [] });
    expect(rule.outcome.lines[0]).toEqual({ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' });
  });

  it('正常: id 省略は makeId。askIf・requiredFacts・fixed / ratio / partnerFrom を受ける', () => {
    const rule = createJournalRule(ruleProps({
      id: undefined,
      outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: { ratio: 0.7 }, partnerFrom: { fixed: '東京電力' } }, { side: 'debit', accountId: 'b', taxCode: 't', amount: 'remainder' }, { side: 'credit', accountId: 'c', taxCode: 't', amount: { fixed: 100 }, partnerFrom: 'issuerName' }] },
      askIf: [{ conditions: [{ field: 'grandTotal', op: 'gte', value: 100000 }], questionId: 'fixed_asset_check', prompt: '固定資産?' }],
      requiredFacts: ['extra.purpose'], provenance: { origin: 'hearing', hearingId: 'h1', exampleDocumentIds: ['d1'] },
    }), () => 'gen');
    expect(rule.id).toBe('gen');
    expect(rule.askIf[0]?.questionId).toBe('fixed_asset_check');
    expect(rule.provenance).toEqual({ origin: 'hearing', hearingId: 'h1', exampleDocumentIds: ['d1'] });
  });

  it('異常: 名前空・priority 非整数・outcome 空・行の必須項目', () => {
    expect(() => createJournalRule(ruleProps({ name: ' ' }))).toThrow(new JournalDomainError('createJournalRule: name must be a non-empty string'));
    expect(() => createJournalRule(ruleProps({ priority: 1.5 }))).toThrow(/priority must be an integer/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [] } }))).toThrow(/outcome\.lines must have at least one line/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: '', taxCode: 't', amount: 'total' }] } }))).toThrow(/lines\[0\]\.accountId must be a non-empty string/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: ' ', amount: 'total' }] } }))).toThrow(/lines\[0\]\.taxCode must be a non-empty string/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'up' as 'debit', accountId: 'a', taxCode: 't', amount: 'total' }] } }))).toThrow(/side must be debit or credit/u);
  });

  it('異常: 金額指定（未知のキーワード・負の fixed・範囲外の ratio）と invoiceStatus', () => {
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: 'half' as 'total' }] } }))).toThrow(/amount must be one of/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: { fixed: -1 } }] } }))).toThrow(/fixed must be a non-negative integer/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: { ratio: 2 } }] } }))).toThrow(/ratio must be a number between 0 and 1/u);
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: 'total' }], invoiceStatus: 'maybe' as 'auto' } }))).toThrow(/invoiceStatus must be auto or one of/u);
  });

  it('異常: 条件（regex がコンパイルできない・between が 2 要素でない・in が配列でない・値の欠落）', () => {
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: 'descriptionNorm', op: 'regex', value: '(' }] }))).toThrow(/is not a valid regular expression/u);
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: 'grandTotal', op: 'between', value: [1] }] }))).toThrow(/must be a \[low, high\] pair/u);
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: 'kind', op: 'in', value: 'a' }] }))).toThrow(/must be an array for op 'in'/u);
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: 'kind', op: 'equals' }] }))).toThrow(/value is required for op 'equals'/u);
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: '', op: 'exists' }] }))).toThrow(/conditions\[0\]\.field must be a non-empty string/u);
    expect(() => createJournalRule(ruleProps({ conditions: [{ field: 'x', op: 'like' as 'equals', value: 1 }] }))).toThrow(/op must be one of/u);
  });

  it('異常: descriptionTemplate の未知の置換子、scope の未知の kind、askIf の必須項目', () => {
    expect(() => createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: 'total' }], descriptionTemplate: '{nope}' } }))).toThrow(/unknown placeholder: \{nope\}/u);
    expect(createJournalRule(ruleProps({ outcome: { lines: [{ side: 'debit', accountId: 'a', taxCode: 't', amount: 'total' }], descriptionTemplate: '{extra.purpose} {grandTotal}' } })).outcome.descriptionTemplate).toBe('{extra.purpose} {grandTotal}');
    expect(() => createJournalRule(ruleProps({ scope: { documentKinds: ['memo' as 'other'] } }))).toThrow(/documentKinds contains an unknown kind: memo/u);
    expect(() => createJournalRule(ruleProps({ askIf: [{ conditions: [], questionId: '', prompt: 'p' }] }))).toThrow(/askIf\[0\]\.questionId must be a non-empty string/u);
  });

  it('例外: tenant / 時刻', () => {
    expect(() => createJournalRule(ruleProps({ tenant: { tenantId: 't', workspaceId: '' } }))).toThrow(/tenant\.workspaceId must be a non-empty string/u);
    expect(() => createJournalRule(ruleProps({ updatedAt: 'x' }))).toThrow(/updatedAt must be an ISO 8601 date-time string/u);
  });
});

describe('ruleSpecificity / compareRulePrecedence', () => {
  it('正常: 条件数 + 演算子点 + scope 点', () => {
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: {}, conditions: [] })))).toBe(0);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: {}, conditions: [{ field: 'a', op: 'equals', value: 1 }] })))).toBe(3);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: {}, conditions: [{ field: 'a', op: 'startsWith', value: 'x' }] })))).toBe(2.5);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: {}, conditions: [{ field: 'a', op: 'contains', value: 'x' }, { field: 'b', op: 'regex', value: 'x' }] })))).toBe(4);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: {}, conditions: [{ field: 'a', op: 'exists' }] })))).toBe(1);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: { direction: 'out', documentKinds: ['invoice'], accountHints: ['A'] }, conditions: [] })))).toBe(3);
    expect(ruleSpecificity(createJournalRule(ruleProps({ scope: { documentKinds: [] }, conditions: [] })))).toBe(0);
  });

  it('正常: priority 降順 → 特異度 降順 → createdAt 昇順 → id 昇順', () => {
    const base = createJournalRule(ruleProps({ id: 'b', priority: 1, scope: {}, conditions: [{ field: 'a', op: 'contains', value: 'x' }] }));
    const higher = createJournalRule(ruleProps({ id: 'a', priority: 2, scope: {}, conditions: [] }));
    const specific = createJournalRule(ruleProps({ id: 'c', priority: 1, scope: {}, conditions: [{ field: 'a', op: 'equals', value: 'x' }] }));
    const older = createJournalRule(ruleProps({ id: 'd', priority: 1, scope: {}, conditions: [{ field: 'a', op: 'contains', value: 'x' }], createdAt: '2026-01-01T00:00:00.000Z' }));
    const same = createJournalRule(ruleProps({ id: 'a', priority: 1, scope: {}, conditions: [{ field: 'a', op: 'contains', value: 'x' }] }));
    expect([base, higher, specific, older, same].sort(compareRulePrecedence).map((rule) => rule.id)).toEqual(['a', 'c', 'd', 'a', 'b']);
  });
});

describe('readFactPath / hasFact', () => {
  const facts: DocumentFacts = { grandTotal: 1100, descriptionNorm: 'AMAZON 注文', lines: [{ description: 'ペン', amount: 550 }, { description: 'ノート', amount: 550 }], extra: { purpose: 'meeting', headcount: 3, flag: true } };

  it('正常: トップレベル・extra.<key>・lines[].<key>', () => {
    expect(readFactPath(facts, 'grandTotal')).toBe(1100);
    expect(readFactPath(facts, 'extra.purpose')).toBe('meeting');
    expect(readFactPath(facts, 'lines[].description')).toEqual(['ペン', 'ノート']);
  });

  it('境界: 無いパス・空パス・配列が無い lines[]', () => {
    expect(readFactPath(facts, 'issuerName')).toBeUndefined();
    expect(readFactPath(facts, 'extra.nope')).toBeUndefined();
    expect(readFactPath(facts, '')).toBeUndefined();
    expect(readFactPath({}, 'lines[].description')).toEqual([]);
    expect(hasFact(facts, 'lines[].description')).toBe(true);
    expect(hasFact({}, 'lines[].description')).toBe(false);
    expect(hasFact({ issuerName: '' }, 'issuerName')).toBe(false);
  });
});

describe('evaluateCondition', () => {
  const facts: DocumentFacts = { direction: 'out', grandTotal: 1100, transactionDate: '2026-09-13', descriptionNorm: 'ＡＭＡＺＯＮ 注文', paymentMethod: 'credit_card', registrationNumber: 'T1234567890123', lines: [{ description: 'ペン', amount: 550 }, { description: 'ノート', amount: 550 }], extra: { purpose: 'meeting', flag: true, off: false } };
  const check = (condition: RuleCondition): boolean => evaluateCondition(facts, condition);

  it('正常: 文字列演算は NFKC・大文字小文字を無視する', () => {
    expect(check({ field: 'descriptionNorm', op: 'contains', value: 'amazon' })).toBe(true);
    expect(check({ field: 'descriptionNorm', op: 'startsWith', value: 'amazon' })).toBe(true);
    expect(check({ field: 'descriptionNorm', op: 'endsWith', value: '注文' })).toBe(true);
    expect(check({ field: 'descriptionNorm', op: 'equals', value: 'amazon 注文' })).toBe(true);
    expect(check({ field: 'descriptionNorm', op: 'regex', value: '^amazon' })).toBe(true);
    expect(check({ field: 'descriptionNorm', op: 'contains', value: 'rakuten' })).toBe(false);
  });

  it('正常: 数値・日付の比較（gte / lte / between / in）', () => {
    expect(check({ field: 'grandTotal', op: 'gte', value: 1100 })).toBe(true);
    expect(check({ field: 'grandTotal', op: 'lte', value: 1099 })).toBe(false);
    expect(check({ field: 'grandTotal', op: 'between', value: [1000, 2000] })).toBe(true);
    expect(check({ field: 'transactionDate', op: 'between', value: ['2026-09-01', '2026-09-30'] })).toBe(true);
    expect(check({ field: 'transactionDate', op: 'gte', value: '2026-10-01' })).toBe(false);
    expect(check({ field: 'paymentMethod', op: 'in', value: ['cash', 'credit_card'] })).toBe(true);
    expect(check({ field: 'grandTotal', op: 'in', value: [1, 2] })).toBe(false);
  });

  it('正常: exists / notExists / isTrue / isFalse', () => {
    expect(check({ field: 'registrationNumber', op: 'exists' })).toBe(true);
    expect(check({ field: 'issuerName', op: 'exists' })).toBe(false);
    expect(check({ field: 'issuerName', op: 'notExists' })).toBe(true);
    expect(check({ field: 'extra.flag', op: 'isTrue' })).toBe(true);
    expect(check({ field: 'extra.off', op: 'isFalse' })).toBe(true);
    expect(check({ field: 'extra.purpose', op: 'isTrue' })).toBe(false);
  });

  it('正常: lines[] は 1 行でも一致すれば真、notExists は全行が空のときだけ真', () => {
    expect(check({ field: 'lines[].description', op: 'equals', value: 'ノート' })).toBe(true);
    expect(check({ field: 'lines[].description', op: 'contains', value: '消しゴム' })).toBe(false);
    expect(check({ field: 'lines[].description', op: 'notExists' })).toBe(false);
    expect(evaluateCondition({ lines: [] }, { field: 'lines[].description', op: 'notExists' })).toBe(true);
  });

  it('境界: 型が合わない比較は偽、evaluateConditions の空は真', () => {
    expect(check({ field: 'grandTotal', op: 'contains', value: '11' })).toBe(true);
    expect(check({ field: 'extra.flag', op: 'gte', value: 1 })).toBe(false);
    expect(check({ field: 'grandTotal', op: 'between', value: [1] })).toBe(false);
    expect(check({ field: 'descriptionNorm', op: 'regex', value: '(' })).toBe(false);
    expect(evaluateConditions(facts, [])).toBe(true);
    expect(evaluateConditions(facts, [{ field: 'direction', op: 'equals', value: 'out' }, { field: 'grandTotal', op: 'gte', value: 5000 }])).toBe(false);
  });
});
