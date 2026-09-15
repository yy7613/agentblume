import { describe, expect, it } from 'vitest';
import type { BankTransactionDto, InvoiceIssueDto, MatchCandidateDto, MatchJudgmentDto } from '../api/receivables-types';
import {
  allocationBalance, csvWarningMessage, defaultDueDate, emptyLine, expectedOutstandingOf, fileToBase64, formatYen, formToInvoice, initialStep, invoiceIssueMessage,
  invoiceStatusLabel, invoiceToForm, isOpenInvoice, journalOrigin, mappingProblemLabel, newInvoiceForm, openReceivablesTarget, parsePastedInvoice,
  previewPayerName, roundingModeLabel, stageLabel, summarizeMatch,
} from './receivables-model';

const en = (english: string, _japanese: string) => english;
const ja = (_english: string, japanese: string) => japanese;

describe('表示の整形とラベル', () => {
  it('正常: 金額・丸めモード・状態・判定の段階のラベル', () => {
    expect(formatYen(110_000)).toBe('¥110,000');
    expect(formatYen(undefined)).toBe('—');
    expect([roundingModeLabel('floor', ja), roundingModeLabel('round-half-up', ja), roundingModeLabel('ceil', en)]).toEqual(['切り捨て', '四捨五入', 'round up']);
    expect((['draft', 'issued', 'partially_paid', 'paid', 'void'] as const).map((status) => invoiceStatusLabel(status, ja))).toEqual(['下書き', '発行済み', '一部入金', '入金済み', '取消']);
    expect([stageLabel('decided', ja), stageLabel('candidate', ja), stageLabel('unmatched', en)]).toEqual(['決定', '候補', 'Pending']);
    expect(mappingProblemLabel('date', ja)).toBe('日付の列');
    expect(mappingProblemLabel('deposit-or-amount', en)).toMatch(/Deposit column/);
  });

  it('正常: 最初に開くステップは設定未保存 → 取引先、未消込あり → 消込、それ以外 → 請求書作成', () => {
    expect(initialStep({ settingsSaved: false, unmatchedCount: 5 })).toBe('customers');
    expect(initialStep({ settingsSaved: true, unmatchedCount: 1 })).toBe('matching');
    expect(initialStep({ settingsSaved: true, unmatchedCount: 0 })).toBe('invoice');
    expect(initialStep({ settingsSaved: undefined, unmatchedCount: 0 })).toBe('invoice');
  });

  it('正常: ディープリンクの section → ステップ。知らない section は undefined', () => {
    expect(openReceivablesTarget({ internalId: 'c1', section: 'customer-aliases' })).toEqual({ step: 'customers', id: 'c1', section: 'customer-aliases' });
    expect(openReceivablesTarget({ internalId: 'c1', section: 'customer' })?.step).toBe('customers');
    expect(openReceivablesTarget({ internalId: 'i1', section: 'invoice' })?.step).toBe('issue');
    expect(openReceivablesTarget({ internalId: 't1', section: 'transaction' })?.step).toBe('matching');
    expect(openReceivablesTarget({ internalId: 'm1', section: 'matching' })?.step).toBe('matching');
    expect(openReceivablesTarget({ internalId: '', section: 'settings' })).toEqual({ step: 'customers', id: '', section: 'settings' });
    expect(openReceivablesTarget({ internalId: 'x' })).toBeUndefined();
  });
});

describe('invoiceIssueMessage（記載事項の違反・警告）', () => {
  const codes: readonly [string, Record<string, string | number>, string][] = [
    ['issuer-name-missing', {}, 'settings'], ['issuer-registration-number-missing', {}, 'settings'], ['issuer-registration-number-invalid', { value: 'T1', digits: 1 }, 'settings'],
    ['issuer-not-registered', {}, 'settings'], ['recipient-missing', {}, 'customerId'], ['customer-disabled', { customer: '旧社' }, 'customerId'],
    ['issue-date-missing', {}, 'issueDate'], ['transaction-date-missing', {}, 'transactionDate'], ['lines-empty', {}, 'lines'],
    ['line-description-missing', { row: 2 }, 'lines'], ['line-amount-missing', { row: 1 }, 'lines'], ['line-amount-not-integer', { row: 1 }, 'lines'],
    ['line-tax-rate-missing', { row: 3 }, 'lines'], ['rate-total-negative', { rate: 8 }, 'lines'], ['grand-total-not-positive', {}, 'lines'],
    ['amount-out-of-range', {}, 'lines'], ['per-line-rounding', { rate: 10, declared: 702, once: 703 }, 'totals'], ['declared-tax-mismatch', { rate: 10, declared: 1, computed: 703 }, 'totals'],
    ['rounding-mode-differs', { mode: 'round-half-up', currentMode: 'floor' }, 'settings'], ['declared-total-mismatch', { declared: 1, computed: 2, difference: -1 }, 'lines'],
    ['zero-rate-lines', { rows: '1, 3', row: 1 }, 'lines'], ['due-date-missing', {}, 'dueDate'], ['due-date-before-issue-date', {}, 'dueDate'],
    ['transaction-date-after-issue-date', {}, 'transactionDate'], ['unknown-code', {}, 'lines'],
  ];

  it.each(codes)('%s: 原因と直し方と直す場所を返す（日英）', (code, params, target) => {
    const issue: InvoiceIssueDto = { code, params };
    const message = invoiceIssueMessage(issue, ja);
    expect(message.cause.length).toBeGreaterThan(0);
    expect(message.fix.length).toBeGreaterThan(0);
    expect(message.target.kind === 'settings' ? 'settings' : message.target.field).toBe(target);
    expect(invoiceIssueMessage(issue, en).cause.length).toBeGreaterThan(0);
  });

  it('正常: params を文言に展開し、持ち込んだ税額の違反だけ「計算値で置き換える」を出す', () => {
    expect(invoiceIssueMessage({ code: 'per-line-rounding', params: { rate: 10, declared: 702, once: 703 } }, ja)).toMatchObject({ cause: expect.stringContaining('702 円'), replaceDeclared: true });
    expect(invoiceIssueMessage({ code: 'line-description-missing', params: { row: 2 } }, ja)).toMatchObject({ cause: '2 行目の品名（取引内容）が空です。', target: { kind: 'field', field: 'lines', row: 2 } });
    expect(invoiceIssueMessage({ code: 'rounding-mode-differs', params: { mode: 'round-half-up', currentMode: 'floor' } }, ja).cause).toContain('「四捨五入」なら一致');
    expect(invoiceIssueMessage({ code: 'issue-date-missing', params: {} }, ja)).not.toHaveProperty('replaceDeclared');
  });
});

describe('summarizeMatch（消込の理由 → 原因・次の一手・ボタン）', () => {
  const candidate: MatchCandidateDto = { invoiceIds: ['i1', 'i2'], allocations: [{ invoiceId: 'i1', amount: 33_000 }, { invoiceId: 'i2', amount: 22_000 }], candidateTotal: 55_000, difference: 440, feeAmount: 440, customerId: 'c1', nameMatch: 'kana', nameScore: 1, rank: 1 };
  const transaction: Pick<BankTransactionDto, 'payerName' | 'amount'> = { payerName: 'ﾃｽﾄ', amount: 54_560 };
  const lookup = { customerName: (id: string) => (id === 'c1' ? 'テスト工業' : '別会社'), invoiceNumber: (id: string) => `INV-${id}` };
  const judgment = (reason: string, overrides: Partial<MatchJudgmentDto> = {}): MatchJudgmentDto => ({ stage: 'candidate', reason, candidates: [candidate], ...overrides });

  it.each([
    ['exact-amount-and-name', 'confirm'], ['fee-difference', 'confirm'], ['combined-payment', 'confirm'], ['combined-payment-with-fee', 'confirm'],
    ['partial-payment', 'confirm'], ['name-partial', 'confirm'], ['amount-only', 'confirm'], ['no-candidate', 'new-invoice'], ['no-open-invoice', 'new-invoice'],
    ['multiple-candidates', 'edit-allocation'], ['ambiguous-combination', 'edit-allocation'], ['search-limit', 'edit-allocation'], ['overpayment', 'open-invoice'],
    ['magic', 'rejudge'],
  ])('%s: 最初のボタンは %s', (reason, firstAction) => {
    const summary = summarizeMatch(transaction, judgment(reason, { params: { count: 2, pool: 20, evaluations: 50_000, excess: 1_000 } }), lookup, ja);
    expect(summary.cause.length).toBeGreaterThan(0);
    expect(summary.next.length).toBeGreaterThan(0);
    expect(summary.buttons[0]?.action.kind).toBe(firstAction);
    expect(summarizeMatch(transaction, judgment(reason), lookup, en).cause.length).toBeGreaterThan(0);
  });

  it('正常: 名義を覚える理由は「確定して名義を覚える」を既定にし、別名の衝突は両方の取引先へのボタンを出す', () => {
    expect(summarizeMatch(transaction, judgment('amount-only'), lookup, ja).buttons[0]).toEqual({ label: '確定して名義を覚える', action: { kind: 'confirm', learnAlias: true }, primary: true });
    const conflict = summarizeMatch({ payerName: '', amount: 1 }, { stage: 'unmatched', reason: 'alias-conflict', candidates: [], params: { customerIds: 'c1,c2' } }, lookup, ja);
    expect(conflict.cause).toContain('（名義なし）');
    expect(conflict.cause).toContain('テスト工業、別会社');
    expect(conflict.buttons.map((button) => button.action)).toEqual([{ kind: 'open-customer', customerId: 'c1', section: 'customer-aliases' }, { kind: 'open-customer', customerId: 'c2', section: 'customer-aliases' }]);
    expect(summarizeMatch(transaction, { stage: 'unmatched', reason: 'no-open-invoice', candidates: [], params: { customerIds: 'c1' } }, lookup, ja).cause).toContain('テスト工業 の請求はすべて入金済み');
    expect(summarizeMatch(transaction, { stage: 'unmatched', reason: 'multiple-candidates', candidates: [] }, lookup, en).buttons).toEqual([{ label: 'Edit allocation', action: { kind: 'edit-allocation' } }]);
    expect(summarizeMatch(transaction, { stage: 'unmatched', reason: 'overpayment', candidates: [] }, lookup, en).buttons[0]!.action.kind).toBe('open-journal');
  });
});

describe('取込の警告', () => {
  it('正常: 4 種の警告を params つきで文言にする', () => {
    expect(csvWarningMessage({ code: 'garbled-rows', params: { rows: '3, 5' } }, ja)).toContain('3, 5 行目');
    expect(csvWarningMessage({ code: 'no-balance-column', params: {} }, ja)).toContain('残高列が無い');
    expect(csvWarningMessage({ code: 'detected-profile', params: { profile: '汎用' } }, en)).toBe('Detected profile: 汎用');
    expect(csvWarningMessage({ code: 'skipped-rows', params: { count: 1, total: 4 } }, ja)).toBe('4 行のうち 1 行を読めませんでした。');
  });
});

describe('請求書フォーム', () => {
  it('正常: フォーム ↔ DTO の往復（空の欄は送らない。0% 以外の区分は落とす。期間は両端があるときだけ）', () => {
    const form = { ...newInvoiceForm('2026-09-30', 'exclusive'), customerId: 'c1', dueDate: '2026-10-31', periodFrom: '2026-09-01', periodTo: '2026-09-30', note: 'メモ',
      lines: [{ ...emptyLine(), description: '部品', quantity: '1.5', unit: '個', unitPrice: '1,000', amount: '' }, { ...emptyLine('0'), description: '立替', amount: '500', zeroRateKind: 'non-taxable' as const }, { ...emptyLine('10'), description: 'x', amount: 'abc', zeroRateKind: 'export' as const }] };
    const dto = formToInvoice(form);
    expect(dto).toEqual({
      customerId: 'c1', issueDate: '2026-09-30', transactionDate: '2026-09-30', transactionPeriod: { from: '2026-09-01', to: '2026-09-30' }, dueDate: '2026-10-31', pricing: 'exclusive', note: 'メモ',
      lines: [{ description: '部品', quantity: 1.5, unit: '個', unitPrice: 1000, taxRate: 10 }, { description: '立替', amount: 500, taxRate: 0, zeroRateKind: 'non-taxable' }, { description: 'x', taxRate: 10 }],
    });
    const back = invoiceToForm({ ...dto, declared: { grandTotal: 1 }, customerNameHint: '未登録' });
    expect(back).toMatchObject({ customerId: 'c1', periodFrom: '2026-09-01', declared: { grandTotal: 1 }, customerNameHint: '未登録', lines: [{ quantity: '1.5', unitPrice: '1000', amount: '', taxRate: '10' }, { amount: '500', taxRate: '0', zeroRateKind: 'non-taxable' }, { taxRate: '10' }] });
    expect(invoiceToForm({ pricing: 'inclusive', lines: [] })).toMatchObject({ customerId: '', lines: [emptyLine()], note: '' });
    expect(invoiceToForm({ pricing: 'inclusive', lines: [{ description: 'x' }] }).lines[0]!.taxRate).toBe('');
    expect(formToInvoice({ ...newInvoiceForm('', 'inclusive'), transactionDate: ' ', lines: [] })).toEqual({ pricing: 'inclusive', lines: [] });
  });

  it('正常 / 異常: JSON 貼付は形を確かめる', () => {
    expect(parsePastedInvoice('{"pricing":"exclusive","lines":[{"description":"x"}],"customerNameHint":"A"}')).toEqual({ ok: true, invoice: { pricing: 'exclusive', lines: [{ description: 'x' }], customerNameHint: 'A' } });
    expect(parsePastedInvoice('not json')).toEqual({ ok: false, reason: 'json' });
    expect(parsePastedInvoice('[]')).toEqual({ ok: false, reason: 'shape' });
    expect(parsePastedInvoice('{"pricing":"gross","lines":[]}')).toEqual({ ok: false, reason: 'shape' });
    expect(parsePastedInvoice('{"pricing":"exclusive","lines":[{"amount":1}]}')).toEqual({ ok: false, reason: 'shape' });
  });

  it('正常: 期日の既定・配分の差・判定時点の残高・出所タグ・未入金の判定', () => {
    expect(defaultDueDate('2026-09-30', { paymentTermDays: 31 })).toBe('2026-10-31');
    expect(defaultDueDate('2026-09-30', {})).toBe('');
    expect(defaultDueDate('', { paymentTermDays: 1 })).toBe('');
    expect(allocationBalance(54_560, [{ amount: 33_000 }, { amount: 22_000 }], 440)).toBe(0);
    expect(allocationBalance(1_000, [{ amount: 900 }], 0)).toBe(-100);
    const single: MatchCandidateDto = { invoiceIds: ['a'], allocations: [{ invoiceId: 'a', amount: 30_000 }], candidateTotal: 50_000, difference: 0, feeAmount: 0, customerId: 'c', nameMatch: 'none', nameScore: 0, rank: 1 };
    expect(expectedOutstandingOf(single)).toEqual({ a: 50_000 });
    expect(expectedOutstandingOf({ ...single, invoiceIds: ['a', 'b'], allocations: [{ invoiceId: 'a', amount: 1 }, { invoiceId: 'b', amount: 2 }] })).toEqual({ a: 1, b: 2 });
    expect(journalOrigin(['receivables', 'receivables:matching:m:1'])).toEqual({ kind: 'matching', id: 'm:1' });
    expect(journalOrigin(['other'])).toBeUndefined();
    expect(journalOrigin(undefined)).toBeUndefined();
    expect([isOpenInvoice({ status: 'issued' }), isOpenInvoice({ status: 'partially_paid' }), isOpenInvoice({ status: 'paid' })]).toEqual([true, true, false]);
  });

  it('正常: 別名の入力中の目安（サーバーの正規化と同じ結果になる代表例）', () => {
    expect(previewPayerName('ﾌﾘｺﾐ ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ'.slice(5))).toBe('ヤマダシヨウジ');
    expect(previewPayerName('やまだ たろう')).toBe('ヤマダタロウ');
    expect(previewPayerName('株式会社サンプル（本店）')).toBe('サンプル本店');
    expect(previewPayerName('ﾔﾏﾀﾞ(ｶ')).toBe('ヤマダ');
    expect(previewPayerName('abc-def')).toBe('ABCーDEF');
  });

  it('正常: ファイルの生バイトを base64 にする', async () => {
    expect(await fileToBase64(new Blob([new Uint8Array([0xef, 0xbb, 0xbf, 0x41])]))).toBe(Buffer.from([0xef, 0xbb, 0xbf, 0x41]).toString('base64'));
  });
});
