import { describe, expect, it } from 'vitest';
import type { InvoiceContent } from './invoice';
import { checkInvoice, type CheckInvoiceInput } from './invoice-check';
import { defaultReceivablesSettings, type ReceivablesSettings } from './settings';

const baseSettings: ReceivablesSettings = {
  ...defaultReceivablesSettings(),
  issuer: { name: '株式会社サンプルソフト', registered: true, registrationNumber: 'T9876543210987', transferAccounts: [] },
};

const baseInvoice: InvoiceContent = {
  customerId: 'c1', issueDate: '2026-09-30', transactionDate: '2026-09-30', dueDate: '2026-10-31',
  pricing: 'exclusive', lines: [{ description: '開発費', amount: 100_000, taxRate: 10 }],
};

function check(overrides: { invoice?: Partial<InvoiceContent>; settings?: Partial<ReceivablesSettings>; customer?: CheckInvoiceInput['customer'] | null; roundingMode?: CheckInvoiceInput['roundingMode'] } = {}) {
  return checkInvoice({
    invoice: { ...baseInvoice, ...overrides.invoice },
    settings: { ...baseSettings, ...overrides.settings },
    customer: overrides.customer === null ? undefined : overrides.customer ?? { name: '山田商事', enabled: true },
    ...(overrides.roundingMode === undefined ? {} : { roundingMode: overrides.roundingMode }),
  });
}
const codes = (issues: readonly { code: string }[]) => issues.map((issue) => issue.code);

describe('checkInvoice（記載事項）', () => {
  it('正常: 記載事項がそろった請求書は違反も警告も無く、集計を返す', () => {
    const result = check();
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.totals).toMatchObject({ taxTotal: 10_000, grandTotal: 110_000 });
  });

  it('異常: 発行者の名称・登録番号の欠落と形の誤りは違反（桁数を params に載せる）', () => {
    expect(codes(check({ settings: { issuer: { ...baseSettings.issuer, name: ' ' } } }).violations)).toEqual(['issuer-name-missing']);
    expect(codes(check({ settings: { issuer: { ...baseSettings.issuer, registrationNumber: undefined } } }).violations)).toEqual(['issuer-registration-number-missing']);
    const invalid = check({ settings: { issuer: { ...baseSettings.issuer, registrationNumber: 'T123456789012' } } }).violations;
    expect(invalid).toEqual([{ code: 'issuer-registration-number-invalid', path: 'settings.issuer.registrationNumber', params: { value: 'T123456789012', digits: 12 } }]);
  });

  it('境界: 登録事業者でない設定は警告だけ（登録番号が無くても違反にしない）', () => {
    const result = check({ settings: { issuer: { name: '個人事業', registered: false, transferAccounts: [] } } });
    expect(result.violations).toEqual([]);
    expect(codes(result.warnings)).toEqual(['issuer-not-registered']);
  });

  it('異常: 宛名が無い・無効な取引先は違反', () => {
    expect(codes(check({ customer: null }).violations)).toEqual(['recipient-missing']);
    expect(check({ customer: { name: '旧取引先', enabled: false } }).violations).toEqual([{ code: 'customer-disabled', path: 'customerId', params: { customer: '旧取引先' } }]);
  });

  it('異常: 発行日・取引日の欠落は違反。期間があれば末日を取引日とみなす', () => {
    expect(codes(check({ invoice: { issueDate: undefined } }).violations)).toContain('issue-date-missing');
    expect(codes(check({ invoice: { transactionDate: undefined } }).violations)).toEqual(['transaction-date-missing']);
    expect(check({ invoice: { transactionDate: undefined, transactionPeriod: { from: '2026-09-01', to: '2026-09-30' } } }).violations).toEqual([]);
  });

  it('境界: 期日 = 発行日は違反にならず、前日は違反。期日なしは警告', () => {
    expect(check({ invoice: { dueDate: '2026-09-30' } }).violations).toEqual([]);
    expect(codes(check({ invoice: { dueDate: '2026-09-29' } }).violations)).toEqual(['due-date-before-issue-date']);
    expect(codes(check({ invoice: { dueDate: undefined } }).warnings)).toEqual(['due-date-missing']);
  });

  it('境界: 取引日が発行日より後は警告（前払いの請求はあり得る）', () => {
    expect(check({ invoice: { transactionDate: '2026-10-01', dueDate: '2026-10-31' } }).warnings).toEqual([
      { code: 'transaction-date-after-issue-date', path: 'transactionDate', params: { transactionDate: '2026-10-01', issueDate: '2026-09-30' } },
    ]);
  });
});

describe('checkInvoice（明細と集計）', () => {
  it('異常: 明細が無い・品名が空・税率が無い・金額が無いのは違反（行番号つき）', () => {
    expect(codes(check({ invoice: { lines: [] } }).violations)).toEqual(['lines-empty']);
    const result = check({ invoice: { lines: [{ description: '', amount: 1000, taxRate: 10 }, { description: '保守', amount: 500 }, { description: '作業' , taxRate: 10 }] } });
    expect(result.violations).toEqual([
      { code: 'line-description-missing', path: 'lines[0].description', params: { row: 1 } },
      { code: 'line-tax-rate-missing', path: 'lines[1].taxRate', params: { row: 2 } },
      { code: 'line-amount-missing', path: 'lines[2].amount', params: { row: 3 } },
    ]);
  });

  it('異常: 単価 × 数量が円未満を含むのは line-amount-not-integer（金額を入れてもらう）', () => {
    expect(check({ invoice: { lines: [{ description: '部品', quantity: 3, unitPrice: 333.33, taxRate: 10 }] } }).violations.map((issue) => issue.code)).toEqual(['line-amount-not-integer', 'grand-total-not-positive']);
    expect(check({ invoice: { lines: [{ description: '部品', quantity: 3, unitPrice: 300, taxRate: 10 }] } }).totals.grandTotal).toBe(990);
  });

  it('異常: 値引が本体を上回る税率は rate-total-negative、請求額 0 円以下は grand-total-not-positive', () => {
    expect(codes(check({ invoice: { lines: [{ description: '本体', amount: 100, taxRate: 10 }, { description: '値引', amount: -200, taxRate: 10 }] } }).violations)).toEqual(['rate-total-negative']);
    expect(codes(check({ invoice: { lines: [{ description: '無償', amount: 0, taxRate: 10 }] } }).violations)).toEqual(['grand-total-not-positive']);
  });

  it('境界: 明細 1 行の金額は 10^11 円ちょうどまで。+1 円と 201 行は amount-out-of-range', () => {
    expect(check({ invoice: { lines: [{ description: '大口', amount: 100_000_000_000, taxRate: 10 }] } }).violations).toEqual([]);
    expect(codes(check({ invoice: { lines: [{ description: '大口', amount: 100_000_000_001, taxRate: 10 }] } }).violations)).toContain('amount-out-of-range');
    expect(codes(check({ invoice: { lines: Array.from({ length: 201 }, () => ({ description: 'x', amount: 1, taxRate: 10 as const })) } }).violations)).toEqual(['amount-out-of-range']);
    expect(codes(check({ invoice: { lines: Array.from({ length: 11 }, () => ({ description: 'x', amount: 100_000_000_000, taxRate: 10 as const })) } }).violations)).toEqual(['amount-out-of-range']);
  });

  it('警告: 0% の明細に区分が無ければ zero-rate-lines（区分を選べば消える）', () => {
    const lines = [{ description: '立替', amount: 500, taxRate: 0 as const }, { description: '開発', amount: 1000, taxRate: 10 as const }];
    expect(check({ invoice: { lines } }).warnings).toEqual([{ code: 'zero-rate-lines', path: 'lines[0].zeroRateKind', params: { rows: '1', row: 1 } }]);
    expect(check({ invoice: { lines: [{ ...lines[0]!, zeroRateKind: 'non-taxable' }, lines[1]!] } }).warnings).toEqual([]);
  });
});

describe('checkInvoice（持ち込んだ税額との突き合わせ）', () => {
  const lines = [{ description: 'A', amount: 1234, taxRate: 10 as const }, { description: 'B', amount: 2345, taxRate: 10 as const }, { description: 'C', amount: 3456, taxRate: 10 as const }];

  it('異常: 明細ごとの丸めと一致する申告は per-line-rounding（差額と正しい税額を載せる）', () => {
    const result = check({ invoice: { lines, declared: { lineTaxAmounts: [123, 234, 345] } } });
    expect(result.violations).toEqual([{ code: 'per-line-rounding', path: 'totals', params: { rate: 10, declared: 702, perLine: 702, once: 703, difference: -1 } }]);
    // 値は補正しない（発行する値は常に計算値）。
    expect(result.totals.taxTotal).toBe(703);
  });

  it('異常: 明細ごとの丸めでも説明できない申告は declared-tax-mismatch', () => {
    expect(check({ invoice: { lines, declared: { lineTaxAmounts: [100, 100, null] } } }).violations).toEqual([
      { code: 'declared-tax-mismatch', path: 'totals', params: { rate: 10, declared: 200, computed: 703, difference: -503 } },
    ]);
  });

  it('境界: 申告が計算値と一致すれば何も出さない。null の明細税額は数えない', () => {
    expect(check({ invoice: { lines, declared: { lineTaxAmounts: [null, null, null], taxByRate: [{ rate: 10, taxAmount: 703 }], grandTotal: 7738 } } })).toMatchObject({ violations: [], warnings: [] });
  });

  it('警告: 1 円差で別の丸めモードなら一致するのは rounding-mode-differs（違反にしない）', () => {
    const result = check({ invoice: { lines, declared: { taxByRate: [{ rate: 10, taxAmount: 704 }] } } });
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([{ code: 'rounding-mode-differs', path: 'settings.rounding.mode', params: { rate: 10, declared: 704, computed: 703, mode: 'round-half-up', currentMode: 'floor' } }]);
  });

  it('異常: 税率別の申告が 2 円以上違えば declared-tax-mismatch。0% と明細税額で指摘済みの税率は重ねない', () => {
    expect(codes(check({ invoice: { lines, declared: { taxByRate: [{ rate: 10, taxAmount: 710 }, { rate: 0, taxAmount: 5 }] } } }).violations)).toEqual(['declared-tax-mismatch']);
    expect(codes(check({ invoice: { lines, declared: { lineTaxAmounts: [123, 234, 345], taxByRate: [{ rate: 10, taxAmount: 702 }] } } }).violations)).toEqual(['per-line-rounding']);
  });

  it('警告: 申告の合計が違えば declared-total-mismatch（差額を載せる）', () => {
    expect(check({ invoice: { lines, declared: { grandTotal: 7700 } } }).warnings).toEqual([{ code: 'declared-total-mismatch', path: 'lines', params: { declared: 7700, computed: 7738, difference: -38 } }]);
  });

  it('正常: 丸めモードを明示すると設定より優先する（発行済みの凍結モードで再検査するとき）', () => {
    expect(check({ invoice: { lines }, roundingMode: 'ceil' }).totals.taxTotal).toBe(704);
  });
});
