import { describe, expect, it } from 'vitest';
import { createChartOfAccounts, type ChartOfAccounts } from './chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from './default-chart';
import type { DocumentFacts } from './document';
import { buildEntryFromRule, renderDescriptionTemplate } from './entry-builder';
import { createJournalRule, type CreateJournalRuleProps, type OutcomeLine } from './rule';

const chart = DEFAULT_CHART_OF_ACCOUNTS;
const AT = '2026-09-13T00:00:00.000Z';

function rule(lines: readonly OutcomeLine[], overrides: Partial<CreateJournalRuleProps> = {}) {
  return createJournalRule({
    tenant: { tenantId: 't', workspaceId: 'w' },
    id: 'rule-1',
    name: 'テストルール',
    enabled: true,
    mode: 'auto',
    priority: 100,
    scope: {},
    conditions: [],
    outcome: { lines, ...(overrides.outcome ?? {}) },
    askIf: [],
    requiredFacts: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as CreateJournalRuleProps);
}

const baseFacts: DocumentFacts = {
  direction: 'out',
  issuerName: 'テスト商事',
  transactionDate: '2026-09-10',
  grandTotal: 1100,
  description: '消耗品の購入',
  descriptionNorm: '消耗品の購入',
  counterpartyHint: 'テスト',
};

const simple: readonly OutcomeLine[] = [
  { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'total' },
  { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
];

function build(lines: readonly OutcomeLine[], facts: DocumentFacts = baseFacts, overrides: Partial<CreateJournalRuleProps> = {}) {
  return buildEntryFromRule({ rule: rule(lines, overrides), facts, chart, today: '2026-09-13' });
}

describe('buildEntryFromRule — 金額の解決', () => {
  it('正常: total は税込合計。科目名はマスタから写す', () => {
    const result = build(simple);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entry.date).toBe('2026-09-10');
    expect(result.entry.lines).toHaveLength(2);
    expect(result.entry.lines[0]).toMatchObject({ side: 'debit', accountId: 'expense.supplies', accountName: '消耗品費', taxCode: 'JP-IN-10-S', amount: 1100 });
    expect(result.entry.lines[1]).toMatchObject({ side: 'credit', accountId: 'asset.cash', accountName: '現金', amount: 1100 });
  });

  it('正常: 税区分に税率があれば税額（税込からの切り捨て）を入れる。対象外の行は入れない', () => {
    const result = build(simple);
    if (!result.ok) return expect.unreachable('should build');
    // 1100 の 10% 内税 = 100。
    expect(result.entry.lines[0]?.taxAmount).toBe(100);
    expect(result.entry.lines[1]?.taxAmount).toBeUndefined();
  });

  it('正常: taxable:10 / tax:10 は税率別集計から取る', () => {
    const facts: DocumentFacts = { ...baseFacts, totalsByRate: [{ rate: 10, taxableAmount: 1100, amountIncludesTax: true }] };
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-10-S', amount: 'taxable:10' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines[0]?.amount).toBe(1100);

    const taxOnly = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: 'tax:10' },
      { side: 'debit', accountId: 'expense.misc', taxCode: 'JP-NA', amount: 'remainder' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!taxOnly.ok) return expect.unreachable('should build');
    expect(taxOnly.entry.lines[0]?.amount).toBe(100);
    expect(taxOnly.entry.lines[1]?.amount).toBe(1000);
  });

  it('正常: taxable:8 / tax:8 は軽減税率の集計から取る', () => {
    const facts: DocumentFacts = { ...baseFacts, grandTotal: 1080, totalsByRate: [{ rate: 8, taxableAmount: 1080, amountIncludesTax: true }] };
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-IN-8R-S', amount: 'taxable:8' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines[0]?.amount).toBe(1080);
    // 1080 の 8% 内税 = 80。
    expect(result.entry.lines[0]?.taxAmount).toBe(80);
  });

  it('正常: { fixed } は固定額', () => {
    const facts: DocumentFacts = { ...baseFacts, grandTotal: 1000 };
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: { fixed: 300 } },
      { side: 'debit', accountId: 'expense.misc', taxCode: 'JP-NA', amount: { fixed: 700 } },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines.map((line) => line.amount)).toEqual([300, 700, 1000]);
  });

  it('境界: { ratio } は四捨五入する（按分の端数）', () => {
    const facts: DocumentFacts = { ...baseFacts, grandTotal: 1000 };
    const result = build([
      { side: 'debit', accountId: 'expense.rent', taxCode: 'JP-NA', amount: { ratio: 1 / 3 } },
      { side: 'debit', accountId: 'equity.owner_drawings', taxCode: 'JP-NA', amount: 'remainder' },
      { side: 'credit', accountId: 'asset.ordinary_deposit', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!result.ok) return expect.unreachable('should build');
    // 1000 * 1/3 = 333.33… → 333。残りは remainder が吸収して貸借が一致する。
    expect(result.entry.lines[0]?.amount).toBe(333);
    expect(result.entry.lines[1]?.amount).toBe(667);
  });

  it('境界: remainder は同じ側の他行の合計を total から引く（複数行あっても貸借が合う）', () => {
    const facts: DocumentFacts = { ...baseFacts, grandTotal: 1000 };
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: { fixed: 200 } },
      { side: 'debit', accountId: 'expense.misc', taxCode: 'JP-NA', amount: { fixed: 300 } },
      { side: 'debit', accountId: 'expense.books', taxCode: 'JP-NA', amount: 'remainder' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines.map((line) => line.amount)).toEqual([200, 300, 500, 1000]);
  });

  it('異常: remainder が 0 以下になる（他行の合計が total を超える）と unbalanced', () => {
    const facts: DocumentFacts = { ...baseFacts, grandTotal: 1000 };
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: { fixed: 1200 } },
      { side: 'debit', accountId: 'expense.misc', taxCode: 'JP-NA', amount: 'remainder' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], facts);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toEqual({ code: 'unbalanced', ruleId: 'rule-1' });
  });
});

describe('buildEntryFromRule — 摘要・取引先・インボイス区分', () => {
  it('正常: descriptionTemplate を facts で置換する', () => {
    const result = build(simple, baseFacts, { outcome: { lines: simple, descriptionTemplate: '{issuerName} / {description}' } } as Partial<CreateJournalRuleProps>);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.description).toBe('テスト商事 / 消耗品の購入');
  });

  it('境界: テンプレート未指定なら {description}、それも空なら発行者名・ルール名へ落ちる', () => {
    const withDescription = build(simple);
    if (!withDescription.ok) return expect.unreachable('should build');
    expect(withDescription.entry.description).toBe('消耗品の購入');

    const noDescription = build(simple, { ...baseFacts, description: undefined, descriptionNorm: undefined });
    if (!noDescription.ok) return expect.unreachable('should build');
    expect(noDescription.entry.description).toBe('テスト商事');

    const nothing = build(simple, { transactionDate: '2026-09-10', grandTotal: 1100 });
    if (!nothing.ok) return expect.unreachable('should build');
    expect(nothing.entry.description).toBe('テストルール');
  });

  it('正常: partnerFrom は issuerName / counterpartyHint / { fixed } を解決する', () => {
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: 'total', partnerFrom: 'issuerName' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total', partnerFrom: { fixed: '固定取引先' } },
    ]);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines[0]?.partner).toBe('テスト商事');
    expect(result.entry.lines[1]?.partner).toBe('固定取引先');

    // counterpartyHint は無ければ issuerName へ落ちる。
    const hinted = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: 'total', partnerFrom: 'counterpartyHint' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
    ], { ...baseFacts, counterpartyHint: undefined });
    if (!hinted.ok) return expect.unreachable('should build');
    expect(hinted.entry.lines[0]?.partner).toBe('テスト商事');
  });

  it('境界: partnerFrom 未指定なら partner を付けない', () => {
    const result = build(simple);
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.lines[0]?.partner).toBeUndefined();
  });

  it('正常: invoiceStatus: auto は登録番号があれば qualified', () => {
    const result = build(simple, { ...baseFacts, registrationNumber: 'T1234567890123' });
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.invoiceStatus).toBe('qualified');
    expect(result.entry.registrationNumber).toBe('T1234567890123');
  });

  it('境界: 登録番号が無いときは取引日の経過措置で transitional / none が切り替わる', () => {
    // 80% 控除の期限（2026-09-30）までは transitional。
    const during = build(simple, { ...baseFacts, transactionDate: '2026-09-30' });
    if (!during.ok) return expect.unreachable('should build');
    expect(during.entry.invoiceStatus).toBe('transitional');

    // 30% 控除の期限（2031-09-30）まではまだ transitional。
    const late = build(simple, { ...baseFacts, transactionDate: '2031-09-30' });
    if (!late.ok) return expect.unreachable('should build');
    expect(late.entry.invoiceStatus).toBe('transitional');

    // 2031-10-01 以後は控除なし。
    const after = build(simple, { ...baseFacts, transactionDate: '2031-10-01' });
    if (!after.ok) return expect.unreachable('should build');
    expect(after.entry.invoiceStatus).toBe('none');
  });

  it('境界: 収入（direction: in）は not_required。明示指定は auto より優先される', () => {
    const income = build(simple, { ...baseFacts, direction: 'in' });
    if (!income.ok) return expect.unreachable('should build');
    expect(income.entry.invoiceStatus).toBe('not_required');

    const fixed = build(simple, baseFacts, { outcome: { lines: simple, invoiceStatus: 'none' } } as Partial<CreateJournalRuleProps>);
    if (!fixed.ok) return expect.unreachable('should build');
    expect(fixed.entry.invoiceStatus).toBe('none');
  });
});

describe('buildEntryFromRule — 組み立てられない理由', () => {
  it('異常: 取引日も発行日も無ければ missing-fact', () => {
    const result = build(simple, { grandTotal: 1100 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toEqual({ code: 'missing-fact', ruleId: 'rule-1', facts: ['transactionDate'] });
  });

  it('異常: 合計金額が無ければ missing-fact。両方無ければ 2 つとも挙げる', () => {
    const noTotal = build(simple, { transactionDate: '2026-09-10' });
    if (noTotal.ok) return expect.unreachable('should fail');
    expect(noTotal.reason).toEqual({ code: 'missing-fact', ruleId: 'rule-1', facts: ['grandTotal'] });

    const neither = build(simple, {});
    if (neither.ok) return expect.unreachable('should fail');
    expect(neither.reason).toEqual({ code: 'missing-fact', ruleId: 'rule-1', facts: ['transactionDate', 'grandTotal'] });
  });

  it('境界: 取引日が無くても発行日があれば組み立てられる（発行日を仕訳日にする）', () => {
    const result = build(simple, { ...baseFacts, transactionDate: undefined, issueDate: '2026-09-05' });
    if (!result.ok) return expect.unreachable('should build');
    expect(result.entry.date).toBe('2026-09-05');
  });

  it('異常: マスタに無い科目は unknown-account（重複は 1 度だけ挙げる）', () => {
    const result = build([
      { side: 'debit', accountId: 'expense.nope', taxCode: 'JP-NA', amount: 'total' },
      { side: 'credit', accountId: 'expense.nope', taxCode: 'JP-NA', amount: 'total' },
    ]);
    if (result.ok) return expect.unreachable('should fail');
    expect(result.reason).toEqual({ code: 'unknown-account', ruleId: 'rule-1', accountIds: ['expense.nope'] });
  });

  it('異常: 無効化された科目も unknown-account（論理削除された科目を指すルール）', () => {
    const disabled: ChartOfAccounts = createChartOfAccounts({
      ...DEFAULT_CHART_OF_ACCOUNTS,
      accounts: DEFAULT_CHART_OF_ACCOUNTS.accounts.map((account) => (account.id === 'expense.supplies' ? { ...account, enabled: false } : account)),
    });
    const result = buildEntryFromRule({ rule: rule(simple), facts: baseFacts, chart: disabled, today: '2026-09-13' });
    if (result.ok) return expect.unreachable('should fail');
    expect(result.reason).toEqual({ code: 'unknown-account', ruleId: 'rule-1', accountIds: ['expense.supplies'] });
  });

  it('異常: 貸借が一致しなければ unbalanced', () => {
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: 'total' },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: { fixed: 1 } },
    ]);
    if (result.ok) return expect.unreachable('should fail');
    expect(result.reason).toEqual({ code: 'unbalanced', ruleId: 'rule-1' });
  });

  it('境界: 金額が 0 になる行は unbalanced（0 円の行を仕訳に残さない）', () => {
    const result = build([
      { side: 'debit', accountId: 'expense.supplies', taxCode: 'JP-NA', amount: { fixed: 0 } },
      { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: { fixed: 0 } },
    ]);
    if (result.ok) return expect.unreachable('should fail');
    expect(result.reason).toEqual({ code: 'unbalanced', ruleId: 'rule-1' });
  });
});

describe('renderDescriptionTemplate', () => {
  it('正常: 置換子を facts の値で埋める', () => {
    expect(renderDescriptionTemplate('{issuerName} / {description}', baseFacts)).toBe('テスト商事 / 消耗品の購入');
    expect(renderDescriptionTemplate('{grandTotal}円', baseFacts)).toBe('1100円');
  });

  it('境界: 値の無い置換子・未知の置換子は空文字になり、空白は詰められる', () => {
    // createJournalRule は未知の置換子を弾くが、描画側も落ちずに空へ倒す。
    expect(renderDescriptionTemplate('{nope}', baseFacts)).toBe('');
    expect(renderDescriptionTemplate('a {nope} b', baseFacts)).toBe('a b');
    expect(renderDescriptionTemplate('{issueDate}', baseFacts)).toBe('');
    expect(renderDescriptionTemplate('  {issuerName}  ', baseFacts)).toBe('テスト商事');
  });

  it('境界: 置換子を含まないテンプレートと空文字はそのまま（trim される）', () => {
    expect(renderDescriptionTemplate('固定の摘要', baseFacts)).toBe('固定の摘要');
    expect(renderDescriptionTemplate('', baseFacts)).toBe('');
  });

  it('境界: extra.<key> も引ける（ヒアリングの回答を摘要に出せる）', () => {
    expect(renderDescriptionTemplate('{extra.purpose}', { ...baseFacts, extra: { purpose: '会議' } })).toBe('会議');
  });
});

describe('buildEntryFromRule（帳票種別とインボイス区分）', () => {
  const debitId = chart.accounts.find((account) => account.name === '水道光熱費')?.id ?? '';
  const creditId = chart.accounts.find((account) => account.name === '普通預金')?.id ?? '';
  const lines: readonly OutcomeLine[] = [
    { side: 'debit', accountId: debitId, taxCode: 'JP-IN-10-S', amount: 'total' },
    { side: 'credit', accountId: creditId, taxCode: 'JP-NA', amount: 'total' },
  ];
  const auto = () => rule(lines, { outcome: { lines, invoiceStatus: 'auto' } });

  it('正常: 銀行明細は登録番号が無くても経過措置にせず not_required にする', () => {
    const built = buildEntryFromRule({ rule: auto(), facts: baseFacts, kind: 'bank_statement', chart, today: '2026-09-13' });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.entry.invoiceStatus).toBe('not_required');
  });

  it('正常: 請求書は登録番号が無ければ取引日に応じて経過措置になる', () => {
    const built = buildEntryFromRule({ rule: auto(), facts: baseFacts, kind: 'invoice', chart, today: '2026-09-13' });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.entry.invoiceStatus).toBe('transitional');
  });

  it('境界: 帳票種別を渡さなければ従来どおり取引日だけで判定する', () => {
    const built = buildEntryFromRule({ rule: auto(), facts: baseFacts, chart, today: '2026-09-13' });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.entry.invoiceStatus).toBe('transitional');
  });
});

describe('buildEntryFromRule（壊れたルールでも落ちない）', () => {
  const payableId = chart.accounts.find((account) => account.name === '未払金')?.id ?? '';

  it('例外: 科目マスタに無い科目を指しても throw せず unknown-account を返す', () => {
    const broken: readonly OutcomeLine[] = [
      { side: 'debit', accountId: 'no.such.account', taxCode: 'JP-IN-10-S', amount: 'total' },
      { side: 'credit', accountId: payableId, taxCode: 'JP-NA', amount: 'total' },
    ];
    const built = buildEntryFromRule({ rule: rule(broken), facts: baseFacts, chart, today: '2026-09-13' });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.reason.code).toBe('unknown-account');
  });

  it('例外: 帳票に無い税率を指す金額指定（8% の集計が無いのに taxable:8）でも throw しない', () => {
    const noEightPercent: readonly OutcomeLine[] = [
      { side: 'debit', accountId: payableId, taxCode: 'JP-IN-8R-S', amount: 'taxable:8' },
      { side: 'credit', accountId: payableId, taxCode: 'JP-NA', amount: 'total' },
    ];
    expect(() => buildEntryFromRule({ rule: rule(noEightPercent), facts: baseFacts, chart, today: '2026-09-13' })).not.toThrow();
  });

  it('例外: 摘要テンプレートに未知のプレースホルダがあっても throw せず空文字に置き換える', () => {
    expect(() => renderDescriptionTemplate('{extra.unknown} {nope}', baseFacts)).not.toThrow();
    expect(renderDescriptionTemplate('[{nope}]', baseFacts)).toBe('[]');
  });
});
