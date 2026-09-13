import { describe, expect, it } from 'vitest';
import { createChartOfAccounts } from './chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from './default-chart';
import type { DocumentFacts, DocumentKind } from './document';
import { buildEntryFromRule, renderDescriptionTemplate } from './entry-builder';
import { judgeDocument, ruleMatches } from './judgment';
import { createJournalRule, type CreateJournalRuleProps } from './rule';
import { ruleProps } from './rule.test';

const chart = DEFAULT_CHART_OF_ACCOUNTS;
const now = new Date('2026-09-13T00:00:00.000Z');
const facts: DocumentFacts = { direction: 'out', transactionDate: '2026-09-13', grandTotal: 1100, description: 'AMAZON.CO.JP 注文', descriptionNorm: 'AMAZON.CO.JP 注文', counterpartyHint: 'AMAZON.CO.JP', paymentMethod: 'credit_card' };
const document = (kind: DocumentKind = 'card_statement', overrides: Partial<DocumentFacts> = {}) => ({ kind, facts: { ...facts, ...overrides } });
const rule = (overrides: Partial<CreateJournalRuleProps> = {}) => createJournalRule(ruleProps(overrides));

describe('judgeDocument', () => {
  it('正常: 1 件の auto ルールが一致すれば decided（仕訳草案・特異度・候補つき）', () => {
    const judgment = judgeDocument({ document: document(), rules: [rule()], chart, now });
    expect(judgment.stage).toBe('decided');
    if (judgment.stage !== 'decided') return;
    expect(judgment.ruleId).toBe('rule-1');
    expect(judgment.specificity).toBe(3);
    expect(judgment.candidates).toEqual([{ ruleId: 'rule-1', ruleName: 'Amazon は消耗品', mode: 'auto', priority: 10, specificity: 3 }]);
    expect(judgment.entry).toEqual({
      date: '2026-09-13',
      lines: [
        { side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 },
        { side: 'credit', accountId: 'liability.other_payables', accountName: '未払金', taxCode: 'JP-NA', amount: 1100 },
      ],
      description: 'AMAZON.CO.JP AMAZON.CO.JP 注文',
      // カード明細は登録番号を載せない帳票なので、経過措置ではなく not_required（区分は元の証憑で決める）。
      invoiceStatus: 'not_required',
    });
  });

  it('正常: 見積 / 納品は skipped', () => {
    expect(judgeDocument({ document: document('quotation'), rules: [rule()], chart, now })).toEqual({ stage: 'skipped', reason: 'document-kind' });
    expect(judgeDocument({ document: document('delivery_note'), rules: [rule()], chart, now })).toEqual({ stage: 'skipped', reason: 'document-kind' });
  });

  it('undecided: no-rule（一致なし・無効ルール・scope 外）', () => {
    expect(judgeDocument({ document: document(), rules: [], chart, now })).toEqual({ stage: 'undecided', reasons: [{ code: 'no-rule' }], candidates: [] });
    expect(judgeDocument({ document: document(), rules: [rule({ enabled: false })], chart, now })).toMatchObject({ reasons: [{ code: 'no-rule' }] });
    expect(judgeDocument({ document: document('card_statement', { direction: 'in' }), rules: [rule()], chart, now })).toMatchObject({ reasons: [{ code: 'no-rule' }] });
    expect(judgeDocument({ document: document(), rules: [rule({ scope: { documentKinds: ['invoice'] } })], chart, now })).toMatchObject({ reasons: [{ code: 'no-rule' }] });
    expect(judgeDocument({ document: document('card_statement', { accountHint: '楽天カード' }), rules: [rule({ scope: { accountHints: ['三井住友カード'] } })], chart, now })).toMatchObject({ reasons: [{ code: 'no-rule' }] });
  });

  it('undecided: rule-suggest-mode（suggest だけが一致。候補に残る）', () => {
    const judgment = judgeDocument({ document: document(), rules: [rule({ id: 's', mode: 'suggest' })], chart, now });
    expect(judgment).toEqual({ stage: 'undecided', reasons: [{ code: 'rule-suggest-mode', ruleIds: ['s'] }], candidates: [{ ruleId: 's', ruleName: 'Amazon は消耗品', mode: 'suggest', priority: 10, specificity: 3 }] });
  });

  it('undecided: multiple-rules（priority・特異度・createdAt が同点）。同点でなければ勝者が決まる', () => {
    const tied = judgeDocument({ document: document(), rules: [rule({ id: 'a' }), rule({ id: 'b' })], chart, now });
    expect(tied).toMatchObject({ stage: 'undecided', reasons: [{ code: 'multiple-rules', ruleIds: ['a', 'b'] }] });
    expect(tied.stage === 'undecided' ? tied.candidates.map((entry) => entry.ruleId) : []).toEqual(['a', 'b']);
    const byPriority = judgeDocument({ document: document(), rules: [rule({ id: 'a' }), rule({ id: 'b', priority: 20 })], chart, now });
    expect(byPriority).toMatchObject({ stage: 'decided', ruleId: 'b' });
    const bySpecificity = judgeDocument({ document: document(), rules: [rule({ id: 'a' }), rule({ id: 'b', conditions: [{ field: 'descriptionNorm', op: 'equals', value: 'AMAZON.CO.JP 注文' }] })], chart, now });
    expect(bySpecificity).toMatchObject({ stage: 'decided', ruleId: 'b' });
    const byCreatedAt = judgeDocument({ document: document(), rules: [rule({ id: 'a' }), rule({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' })], chart, now });
    expect(byCreatedAt).toMatchObject({ stage: 'decided', ruleId: 'b' });
    // suggest が同点で混ざっても auto 同士だけで競合を判定する（suggest は候補に残る）。
    const withSuggest = judgeDocument({ document: document(), rules: [rule({ id: 'a' }), rule({ id: 's', mode: 'suggest' })], chart, now });
    expect(withSuggest).toMatchObject({ stage: 'decided', ruleId: 'a' });
    expect(withSuggest.stage === 'decided' ? withSuggest.candidates.map((entry) => entry.ruleId) : []).toEqual(['a', 's']);
  });

  it('undecided: missing-fact（requiredFacts の欠落。欠けたパスを列挙）', () => {
    const judgment = judgeDocument({ document: document(), rules: [rule({ requiredFacts: ['extra.purpose', 'grandTotal', 'issuerName'] })], chart, now });
    expect(judgment).toMatchObject({ stage: 'undecided', reasons: [{ code: 'missing-fact', ruleId: 'rule-1', facts: ['extra.purpose', 'issuerName'] }] });
  });

  it('undecided: ask-if（askIf の条件に該当。questionId と prompt を返す）', () => {
    const asking = rule({ askIf: [{ conditions: [{ field: 'grandTotal', op: 'gte', value: 100000 }], questionId: 'fixed_asset_check', prompt: '固定資産ですか？' }] });
    expect(judgeDocument({ document: document('card_statement', { grandTotal: 150000 }), rules: [asking], chart, now })).toMatchObject({ stage: 'undecided', reasons: [{ code: 'ask-if', ruleId: 'rule-1', questionId: 'fixed_asset_check', prompt: '固定資産ですか？' }] });
    expect(judgeDocument({ document: document(), rules: [asking], chart, now })).toMatchObject({ stage: 'decided' });
  });

  it('undecided: unknown-account（マスタに無い / 無効化された科目）', () => {
    const disabled = createChartOfAccounts({ ...chart, accounts: chart.accounts.map((account) => (account.id === 'expense.supplies' ? { ...account, enabled: false } : account)) });
    expect(judgeDocument({ document: document(), rules: [rule()], chart: disabled, now })).toMatchObject({ reasons: [{ code: 'unknown-account', ruleId: 'rule-1', accountIds: ['expense.supplies'] }] });
    expect(judgeDocument({ document: document(), rules: [rule({ outcome: { lines: [{ side: 'debit', accountId: 'ghost', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' }] } })], chart, now })).toMatchObject({ reasons: [{ code: 'unknown-account', accountIds: ['ghost'] }] });
  });

  it('undecided: unbalanced（借方合計 ≠ 貸方合計）と missing-fact（金額・日付が無い）', () => {
    const unbalanced = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: { fixed: 100 } }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' }] } });
    expect(judgeDocument({ document: document(), rules: [unbalanced], chart, now })).toMatchObject({ reasons: [{ code: 'unbalanced', ruleId: 'rule-1' }] });
    expect(judgeDocument({ document: document('card_statement', { grandTotal: undefined }), rules: [rule()], chart, now })).toMatchObject({ reasons: [{ code: 'missing-fact', facts: ['grandTotal'] }] });
    expect(judgeDocument({ document: document('card_statement', { transactionDate: undefined }), rules: [rule({ conditions: [] })], chart, now })).toMatchObject({ reasons: [{ code: 'missing-fact', facts: ['transactionDate'] }] });
  });

  it('境界: 取引日が無く issueDate があればそれを仕訳日にする。登録番号があれば qualified', () => {
    const judgment = judgeDocument({ document: document('invoice', { transactionDate: undefined, issueDate: '2026-09-01', registrationNumber: 'T1234567890123' }), rules: [rule()], chart, now });
    expect(judgment).toMatchObject({ stage: 'decided', entry: { date: '2026-09-01', invoiceStatus: 'qualified', registrationNumber: 'T1234567890123' } });
  });
});

describe('ruleMatches', () => {
  it('正常: scope と conditions の両方を見る（enabled は見ない）', () => {
    expect(ruleMatches(rule({ enabled: false }), document())).toBe(true);
    expect(ruleMatches(rule({ scope: { direction: 'in' } }), document())).toBe(false);
    expect(ruleMatches(rule({ scope: { accountHints: ['楽天カード'] } }), document('card_statement', { accountHint: ' 楽天カード ' }))).toBe(true);
  });
});

describe('buildEntryFromRule', () => {
  const split: DocumentFacts = { ...facts, grandTotal: 2180, totalsByRate: [{ rate: 10, taxableAmount: 1100, amountIncludesTax: true }, { rate: 8, taxableAmount: 1080, amountIncludesTax: true }] };

  it('正常: taxable:10 / taxable:8 / tax:10 / tax:8 / remainder / fixed / ratio を解決し、税額は税区分の税率から切り捨てで出す', () => {
    const complex = rule({ outcome: { lines: [
      { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'taxable:10' },
      { side: 'debit', accountId: 'expense.welfare', taxCode: 'JP-IN-8R-S', amount: 'taxable:8', partnerFrom: 'issuerName' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: { fixed: 1000 } },
      { side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 'remainder', partnerFrom: 'counterpartyHint' },
    ] } });
    const built = buildEntryFromRule({ rule: complex, facts: split, chart });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.entry.lines).toEqual([
      { side: 'debit', accountId: 'expense.meetings', accountName: '会議費', taxCode: 'JP-IN-10-S', amount: 1100, taxAmount: 100 },
      { side: 'debit', accountId: 'expense.welfare', accountName: '福利厚生費', taxCode: 'JP-IN-8R-S', amount: 1080, taxAmount: 80 },
      { side: 'credit', accountId: 'asset.cash', accountName: '現金', taxCode: 'JP-NA', amount: 1000 },
      { side: 'credit', accountId: 'liability.other_payables', accountName: '未払金', taxCode: 'JP-NA', amount: 1180, partner: 'AMAZON.CO.JP' },
    ]);
    const taxLines = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: 'tax:10' }, { side: 'debit', accountId: 'expense.welfare', taxCode: 'JP-NA', amount: 'tax:8' }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: { fixed: 180 } }] } });
    const taxes = buildEntryFromRule({ rule: taxLines, facts: split, chart });
    expect(taxes.ok && taxes.entry.lines.map((line) => line.amount)).toEqual([100, 80, 180]);
    const ratio = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.rent', taxCode: 'JP-IN-10-S', amount: { ratio: 0.7 } }, { side: 'debit', accountId: 'equity.owner_drawings', taxCode: 'JP-NA', amount: 'remainder' }, { side: 'credit', accountId: 'asset.ordinary_deposit', taxCode: 'JP-NA', amount: 'total' }] } });
    const shared = buildEntryFromRule({ rule: ratio, facts: { ...facts, grandTotal: 100001 }, chart });
    expect(shared.ok && shared.entry.lines.map((line) => line.amount)).toEqual([70001, 30000, 100001]);
  });

  it('境界: remainder が 0 以下になる（fixed が total を超える）と unbalanced。partner は固定文字列も使える', () => {
    const over = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: { fixed: 5000 } }, { side: 'debit', accountId: 'expense.misc', taxCode: 'JP-IN-10-S', amount: 'remainder' }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' }] } });
    expect(buildEntryFromRule({ rule: over, facts, chart })).toEqual({ ok: false, reason: { code: 'unbalanced', ruleId: 'rule-1' } });
    const fixedPartner = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.utilities', taxCode: 'JP-IN-10-S', amount: 'total', partnerFrom: { fixed: '東京電力' } }, { side: 'credit', accountId: 'asset.ordinary_deposit', taxCode: 'JP-NA', amount: 'total' }] }, });
    const built = buildEntryFromRule({ rule: fixedPartner, facts, chart });
    expect(built.ok && built.entry.lines[0]?.partner).toBe('東京電力');
  });

  it('正常: 明示した invoiceStatus はそのまま、テンプレート省略時は description → issuerName → ルール名の順', () => {
    const explicit = rule({ outcome: { lines: [{ side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' }], invoiceStatus: 'none' } });
    const built = buildEntryFromRule({ rule: explicit, facts: { ...facts, description: undefined, issuerName: '山田商事' }, chart });
    expect(built.ok && built.entry).toMatchObject({ invoiceStatus: 'none', description: '山田商事' });
    const fallback = buildEntryFromRule({ rule: explicit, facts: { ...facts, description: undefined }, chart });
    expect(fallback.ok && fallback.entry.description).toBe('Amazon は消耗品');
  });
});

describe('renderDescriptionTemplate', () => {
  it('正常: facts の値を置換し、無い値は空、連続空白は圧縮', () => {
    expect(renderDescriptionTemplate('{issuerName} {description} {grandTotal}円 {extra.purpose}', { description: 'x', grandTotal: 100, extra: { purpose: 'meeting' } })).toBe('x 100円 meeting');
    expect(renderDescriptionTemplate('{lines[].description}', { lines: [{ description: 'a', amount: 1 }] })).toBe('');
  });
});

describe('judgeDocument（壊れた入力でも落ちない）', () => {
  const brokenLines = [
    { side: 'debit', accountId: 'no.such.account', taxCode: 'JP-IN-10-S', amount: 'total' },
    { side: 'credit', accountId: 'liability.other_payables', taxCode: 'JP-NA', amount: 'total' },
  ] as CreateJournalRuleProps['outcome']['lines'];

  it('例外: 科目マスタに無い科目を指すルールでも throw せず unknown-account を返す', () => {
    const judgment = judgeDocument({ document: document(), rules: [rule({ outcome: { lines: brokenLines } })], chart, now });
    expect(judgment.stage).toBe('undecided');
    if (judgment.stage !== 'undecided') return;
    expect(judgment.reasons.map((reason) => reason.code)).toContain('unknown-account');
  });

  it('例外: 事実が空の文書でも throw せず undecided を返す', () => {
    const judgment = judgeDocument({ document: { kind: 'invoice', facts: {} }, rules: [rule()], chart, now });
    expect(judgment.stage).toBe('undecided');
  });

  it('例外: ルールが 0 件でも throw せず no-rule を返す', () => {
    const judgment = judgeDocument({ document: document(), rules: [], chart, now });
    expect(judgment.stage).toBe('undecided');
    if (judgment.stage !== 'undecided') return;
    expect(judgment.reasons.map((reason) => reason.code)).toEqual(['no-rule']);
  });
});
