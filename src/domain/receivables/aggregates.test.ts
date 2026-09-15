/**
 * 入金明細・消込・プロファイル・設定・番号書式・指紋の不変条件（小さい集約をまとめて検査する）。
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BANK_CSV_PROFILES, columnMappingProblems, createBankCsvProfile, findHeaderRow, isBuiltinProfileId,
  profileMatchesHeaders, toJournalColumnMapping,
} from './bank-csv-profile';
import {
  createBankTransaction, ignoreTransaction, markTransactionMatched, markTransactionUnmatched, unignoreTransaction,
  validateStoredMatchJudgment, withMatchJudgment, type CreateBankTransactionProps,
} from './bank-transaction';
import { ReceivablesDomainError, ReceivablesStateError } from './errors';
import { fingerprintBase, fingerprintSources, forcedFingerprintSource } from './fingerprint';
import { allocationSumMatches, cancelMatching, createMatching, withMatchingJournal } from './matching-aggregate';
import { assertNumberingFormat, formatInvoiceNumber, numberingFormatProblem, numberingSeriesKey } from './numbering';
import { createReceivablesSettings, defaultReceivablesSettings, journalLinkReferences } from './settings';
import { JOURNAL_CSV_PRESETS, normalizeHeader } from '../journal/csv-presets';

const AT = '2026-09-30T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };

describe('BankTransaction', () => {
  const base: CreateBankTransactionProps = {
    tenant, id: 'tx', accountKey: 'main', date: '2026-09-30', amount: 1000, description: 'ﾌﾘｺﾐ ﾃｽﾄ', payerName: 'テスト', payerNameNorm: 'テスト',
    source: { row: { 摘要: 'ﾌﾘｺﾐ ﾃｽﾄ' }, rowNumber: 2 }, fingerprint: 'fp', createdAt: AT, updatedAt: AT,
  };
  const judgment = { stage: 'candidate' as const, reason: 'amount-only' as const, candidates: [], judgedAt: AT };

  it('正常: 判定 → 確定 → 取消 → 対象外 → 戻す の遷移', () => {
    const judged = withMatchJudgment(createBankTransaction(base), judgment, AT);
    expect(judged.judgment).toEqual(judgment);
    const matched = markTransactionMatched(judged, 'm1', AT);
    expect(matched).toMatchObject({ status: 'matched', matchingId: 'm1' });
    const back = markTransactionUnmatched(matched, AT);
    expect(back.status).toBe('unmatched');
    expect(back).not.toHaveProperty('judgment');
    const ignored = ignoreTransaction(back, ' 利息 ', AT);
    expect(ignored).toMatchObject({ status: 'ignored', ignoredNote: '利息' });
    expect(unignoreTransaction(ignored, AT)).not.toHaveProperty('ignoredNote');
    expect(ignoreTransaction(back, undefined, AT)).not.toHaveProperty('ignoredNote');
  });

  it('異常: 状態の前提違反は理由つき。形の誤りは ReceivablesDomainError', () => {
    const tx = createBankTransaction(base);
    expect(() => unignoreTransaction(tx, AT)).toThrow(ReceivablesStateError);
    expect(() => markTransactionUnmatched(tx, AT)).toThrow(ReceivablesStateError);
    try { withMatchJudgment(markTransactionMatched(tx, 'm', AT), judgment, AT); expect.unreachable(); }
    catch (error) { expect(error).toMatchObject({ reason: 'transaction-not-unmatched' }); }
    expect(() => createBankTransaction({ ...base, amount: 0 })).toThrow(/positive integer/);
    expect(() => createBankTransaction({ ...base, date: '2026/09/30' })).toThrow(/YYYY-MM-DD/);
    expect(() => createBankTransaction({ ...base, status: 'matched' })).toThrow(/matchingId/);
    expect(() => createBankTransaction({ ...base, matchingId: 'm' })).toThrow(/only a matched/);
    expect(() => createBankTransaction({ ...base, source: { row: {}, rowNumber: 0 } })).toThrow(/rowNumber/);
    expect(() => createBankTransaction({ ...base, balance: 1.5 })).toThrow(/balance/);
    expect(() => validateStoredMatchJudgment({ ...judgment, reason: 'magic' as never })).toThrow(/unknown/);
    expect(() => validateStoredMatchJudgment({ ...judgment, stage: 'maybe' as never })).toThrow(/stage/);
    expect(() => validateStoredMatchJudgment({ ...judgment, candidates: [{ invoiceIds: 'x' } as never] })).toThrow(/invalid candidate/);
    expect(() => validateStoredMatchJudgment({ ...judgment, contendedBy: [1 as never] })).toThrow(/contendedBy/);
  });
});

describe('Matching', () => {
  const base = { tenant, id: 'm', transactionId: 'tx', transactionAmount: 54_560, allocations: [{ invoiceId: 'a', amount: 33_000 }, { invoiceId: 'b', amount: 22_000 }], feeAmount: 440, decidedBy: 'judgment' as const, confirmedAt: AT, createdAt: AT, updatedAt: AT };

  it('正常: 配分の合計 = 入金額 + 手数料。取消と仕訳の記録', () => {
    const matching = createMatching(base);
    expect(matching).toMatchObject({ status: 'confirmed', journal: {} });
    expect(allocationSumMatches(base.allocations, 54_560, 440)).toBe(true);
    expect(withMatchingJournal(matching, { entryId: 'e', outcome: 'created' }, AT).journal).toEqual({ entryId: 'e', outcome: 'created' });
    const cancelled = cancelMatching(matching, AT);
    expect(cancelled).toMatchObject({ status: 'cancelled', cancelledAt: AT });
    expect(() => cancelMatching(cancelled, AT)).toThrow(ReceivablesStateError);
  });

  it('異常: 合計の不一致・配分の重複・件数 0 / 6・負の手数料は拒否する', () => {
    expect(() => createMatching({ ...base, feeAmount: 0 })).toThrow(/sum to the transaction amount/);
    expect(() => createMatching({ ...base, allocations: [{ invoiceId: 'a', amount: 27_280 }, { invoiceId: 'a', amount: 27_280 }], feeAmount: 0 })).toThrow(/duplicated/);
    expect(() => createMatching({ ...base, allocations: [] })).toThrow(/1 to 5/);
    expect(() => createMatching({ ...base, allocations: Array.from({ length: 6 }, (_, index) => ({ invoiceId: `i${index}`, amount: 1 })) })).toThrow(/1 to 5/);
    expect(() => createMatching({ ...base, feeAmount: -1 })).toThrow(/non-negative/);
    expect(() => createMatching({ ...base, decidedBy: 'robot' as never })).toThrow(/decidedBy/);
    expect(() => createMatching({ ...base, journal: { outcome: 'lost' as never } })).toThrow(/outcome/);
    expect(() => createMatching({ ...base, allocations: [{ invoiceId: 'a', amount: 0 }], transactionAmount: 1, feeAmount: 0 })).toThrow(ReceivablesDomainError);
  });
});

describe('BankCsvProfile', () => {
  it('正常: 組込みは仕訳の銀行プリセットの写し（カードは除く）で、署名は正規化済み', () => {
    const bankPresets = JOURNAL_CSV_PRESETS.filter((preset) => preset.kind !== 'card_statement');
    expect(BUILTIN_BANK_CSV_PROFILES.map((profile) => profile.presetId)).toEqual(bankPresets.map((preset) => preset.id));
    expect(BUILTIN_BANK_CSV_PROFILES.map((profile) => profile.headerSignature)).toEqual(bankPresets.map((preset) => preset.headerSignature.map(normalizeHeader)));
    expect(isBuiltinProfileId(BUILTIN_BANK_CSV_PROFILES[0]!.id)).toBe(true);
  });

  it('正常: 利用者のプロファイルは署名をマッピングの列から作り、名義の列を摘要として仕訳へ渡す', () => {
    const profile = createBankCsvProfile({ tenant, id: 'p', name: ' 地銀 ', mapping: { date: '取引日', deposit: 'お預入金額', payerName: '振込依頼人名', balance: '' }, createdAt: AT, updatedAt: AT });
    expect(profile).toMatchObject({ origin: 'user', name: '地銀', headerRow: 'auto', headerSignature: ['取引日', 'お預入金額', '振込依頼人名'] });
    expect(profile.mapping).toEqual({ date: '取引日', deposit: 'お預入金額', payerName: '振込依頼人名' });
    expect(toJournalColumnMapping(profile.mapping!)).toEqual({ date: '取引日', description: '振込依頼人名', deposit: 'お預入金額' });
    expect(toJournalColumnMapping({ date: 'd', description: 'x', amount: 'a', withdrawal: 'w', detail: 'z', balance: 'b' })).toEqual({ date: 'd', description: 'x', amount: 'a', withdrawal: 'w', detail: 'z', balance: 'b' });
    expect(profileMatchesHeaders(profile, ['取引日', ' お預入金額', '振込依頼人名', '残高'])).toBe(true);
    expect(profileMatchesHeaders(profile, ['取引日'])).toBe(false);
    expect(profileMatchesHeaders({ headerSignature: [] }, ['x'])).toBe(false);
  });

  it('異常: 必須列の不足・組込み id・署名に無い列・ヘッダ行の範囲は拒否する', () => {
    expect(columnMappingProblems(undefined)).toEqual(['date', 'deposit-or-amount']);
    expect(columnMappingProblems({ date: '日付', amount: '金額' })).toEqual([]);
    const props = { tenant, id: 'p', name: 'x', mapping: { date: '日付', deposit: '入金' }, createdAt: AT, updatedAt: AT };
    expect(() => createBankCsvProfile({ ...props, mapping: { date: '日付' } })).toThrow(/deposit-or-amount/);
    expect(() => createBankCsvProfile({ ...props, id: 'builtin:generic' })).toThrow(/builtin/);
    expect(() => createBankCsvProfile({ ...props, headerSignature: ['日付'] })).toThrow(/include the mapped columns/);
    expect(() => createBankCsvProfile({ ...props, headerRow: 0 })).toThrow(/headerRow/);
    expect(createBankCsvProfile({ ...props, headerRow: 4 }).headerRow).toBe(4);
  });

  it('境界: ヘッダ行の自動検出は前置き 0 / 3 / 19 行まで、20 行を越えると見つけない', () => {
    const header = ['取引日', '摘要', '入金額'];
    const preamble = (count: number) => [...Array.from({ length: count }, (_, index) => [`口座情報${index}`, 'x']), header, ['2026/09/30', 'ﾃｽﾄ', '100']];
    expect(findHeaderRow(preamble(0))).toBe(1);
    expect(findHeaderRow(preamble(3))).toBe(4);
    expect(findHeaderRow(preamble(19))).toBe(20);
    expect(findHeaderRow(preamble(20))).toBeUndefined();
    expect(findHeaderRow([['名前', 'メモ']])).toBeUndefined();
  });
});

describe('ReceivablesSettings', () => {
  it('正常: 初期値はそのまま検証を通り、仕訳の参照は設定項目名つきで並ぶ', () => {
    const settings = createReceivablesSettings(defaultReceivablesSettings());
    expect(settings.matching).toEqual({ feeTolerance: { min: 1, max: 880 }, maxCombinationSize: 3, partialNameMinLength: 4 });
    const references = journalLinkReferences(settings);
    expect(references.accounts.map((entry) => entry.id)).toEqual(['revenue.sales', 'asset.receivables', 'asset.ordinary_deposit', 'expense.fees']);
    expect(references.taxCodes.at(-1)).toEqual({ id: 'JP-NA', settingPath: 'journal.nonTaxableTaxCode' });
  });

  it('境界: 合算件数は 2..5。範囲外は丸めずに拒否する', () => {
    const base = defaultReceivablesSettings();
    const withSize = (size: number) => ({ ...base, matching: { ...base.matching, maxCombinationSize: size } });
    expect(createReceivablesSettings(withSize(2)).matching.maxCombinationSize).toBe(2);
    expect(createReceivablesSettings(withSize(5)).matching.maxCombinationSize).toBe(5);
    expect(() => createReceivablesSettings(withSize(6))).toThrow('matching.maxCombinationSize must be between 2 and 5');
    expect(() => createReceivablesSettings(withSize(1))).toThrow(/between 2 and 5/);
  });

  it('異常: 手数料の min > max・丸めモード・番号書式・科目の空・振込先の欠落は拒否する', () => {
    const base = defaultReceivablesSettings();
    expect(() => createReceivablesSettings({ ...base, matching: { ...base.matching, feeTolerance: { min: 900, max: 880 } } })).toThrow(/min must be less/);
    expect(() => createReceivablesSettings({ ...base, rounding: { ...base.rounding, mode: 'bankers' as never } })).toThrow(/rounding.mode/);
    expect(() => createReceivablesSettings({ ...base, rounding: { ...base.rounding, defaultPricing: 'gross' as never } })).toThrow(/defaultPricing/);
    expect(() => createReceivablesSettings({ ...base, numbering: { format: 'INV-{YYYY}' } })).toThrow(/exactly one/);
    expect(() => createReceivablesSettings({ ...base, journal: { ...base.journal, accounts: { ...base.journal.accounts, fee: ' ' } } })).toThrow(/journal.accounts.fee/);
    expect(() => createReceivablesSettings({ ...base, journal: { ...base.journal, salesEntryDate: 'never' as never } })).toThrow(/salesEntryDate/);
    expect(() => createReceivablesSettings({ ...base, issuer: { ...base.issuer, transferAccounts: [{ bankName: '', branchName: '', accountType: '', accountNumber: '1', holderKana: '' }] } })).toThrow(/bankName/);
    expect(() => createReceivablesSettings({ ...base, issuer: { ...base.issuer, registered: 'yes' as never } })).toThrow(/registered/);
    expect(() => createReceivablesSettings({ ...base, updatedAt: 'now' })).toThrow(/updatedAt/);
  });

  it('正常: 発行者の任意項目は trim し、空は持たない。振込先は複製する', () => {
    const base = defaultReceivablesSettings();
    const settings = createReceivablesSettings({ ...base, issuer: { name: ' サンプル ', registered: true, registrationNumber: ' T1 ', address: ' ', tel: '03', transferAccounts: [{ bankName: 'サンプル銀行', branchName: '本店', accountType: '普通', accountNumber: '1234567', holderKana: 'サンプル' }] } });
    expect(settings.issuer).toEqual({ name: 'サンプル', registered: true, registrationNumber: 'T1', tel: '03', transferAccounts: [{ bankName: 'サンプル銀行', branchName: '本店', accountType: '普通', accountNumber: '1234567', holderKana: 'サンプル' }] });
  });
});

describe('番号書式', () => {
  it('正常: 年月を発行日で展開した系列キーと、桁埋めした連番', () => {
    expect(numberingSeriesKey('INV-{YYYY}-{SEQ4}', '2026-09-30')).toBe('INV-2026-{SEQ4}');
    expect(numberingSeriesKey('{YY}{MM}-{SEQ3}', '2026-09-30')).toBe('2609-{SEQ3}');
    expect(formatInvoiceNumber('INV-2026-{SEQ4}', 7)).toBe('INV-2026-0007');
    // 桁を超えたら切り詰めない（重複させない）。
    expect(formatInvoiceNumber('X-{SEQ3}', 1234)).toBe('X-1234');
  });

  it('異常: 未知の差し込み・連番なし・連番 2 つ・空・長すぎは拒否。連番は 1 以上', () => {
    expect(numberingFormatProblem('INV-{DD}-{SEQ4}')).toMatch(/unknown placeholders: \{DD\}/);
    expect(numberingFormatProblem('INV-{SEQ2}')).toMatch(/unknown/);
    expect(numberingFormatProblem('{SEQ3}-{SEQ4}')).toMatch(/exactly one/);
    expect(numberingFormatProblem(' ')).toMatch(/non-empty/);
    expect(numberingFormatProblem(`${'x'.repeat(60)}{SEQ3}`)).toMatch(/at most 60/);
    expect(() => assertNumberingFormat('none')).toThrow(ReceivablesDomainError);
    expect(() => formatInvoiceNumber('X-{SEQ3}', 0)).toThrow(/positive integer/);
  });
});

describe('指紋', () => {
  it('正常: 同じファイル内で同じ行は出現順で区別し、別ファイルの同じ行は同じ元になる', () => {
    const row = { accountKey: 'main', date: '2026-09-30', amount: 1000, payerNameNorm: 'テスト' };
    expect(fingerprintBase({ ...row, balance: 5000 })).toBe('main|2026-09-30|1000|テスト|5000');
    expect(fingerprintSources([row, row, { ...row, amount: 2000 }])).toEqual(['main|2026-09-30|1000|テスト||0', 'main|2026-09-30|1000|テスト||1', 'main|2026-09-30|2000|テスト||0']);
    expect(fingerprintSources([row])).toEqual(fingerprintSources([row, row]).slice(0, 1));
    expect(forcedFingerprintSource('a|0', 2)).toBe('a|0|forced:2');
  });
});
