/**
 * 従業員の口座が振込データに使えるかの点検（docs/21 §20.5.2 / §20.6.3 / §20.17-7）。
 * 全銀の半角カナ・30 バイト境界（濁点は 1 バイト）・禁止文字・書式の変換・口座の桁・直近の口座変更。
 */
import { describe, expect, it } from 'vitest';
import type { SealedSecret } from '../../model-settings/sealed-secret';
import type { BankAccount } from '../bank-account';
import { employeePayoutReadiness, type PayoutReadinessEmployee, type PayoutReadinessFormat } from './payout-readiness';

const NOW = new Date('2026-09-15T00:00:00.000Z');
const sealed = (hint: string): SealedSecret => ({ v: 1, alg: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: 'ZA==', hint }) as SealedSecret;
const bank = (overrides: Partial<BankAccount> = {}): BankAccount => ({
  bankCode: '9999', branchCode: '999', accountType: 'ordinary', accountNumber: sealed('0001'), holderKana: 'テスト タロウ', changedAt: '2026-01-01T00:00:00.000Z', changedBy: 'keiri', ...overrides,
});
const employee = (overrides: Partial<PayoutReadinessEmployee> = {}): PayoutReadinessEmployee => ({ id: 'emp-taro', name: 'テスト太郎', code: '1001', bankAccount: bank(), history: [], ...overrides });
const format = (overrides: Partial<PayoutReadinessFormat> = {}): PayoutReadinessFormat => ({ charset: 'strict', includeBankNames: false, customerCode1: 'none', ...overrides });
const codes = (readiness: ReturnType<typeof employeePayoutReadiness>) => ({ problems: readiness.problems.map((entry) => entry.code), warnings: readiness.warnings.map((entry) => entry.code) });

describe('employeePayoutReadiness', () => {
  it('正常: 口座が揃っていれば何も出さず、変換後の名義とバイト数を返す', () => {
    expect(employeePayoutReadiness(employee(), format(), NOW)).toEqual({ problems: [], warnings: [], holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', holderKanaBytes: 7 });
  });

  it('異常: 口座が無ければ止め、従業員の口座欄への導線（fixTarget・field・employeeId）と平易な文言を付ける', () => {
    const readiness = employeePayoutReadiness(employee({ bankAccount: undefined }), format(), NOW);
    expect(readiness).toEqual({
      problems: [{
        code: 'payout-bank-account-missing', employeeId: 'emp-taro', field: 'bankAccount', fixTarget: 'employee-bank-account',
        message: 'テスト太郎 さんの振込口座が登録されていません。従業員マスタで口座を登録してください', params: { employee: 'テスト太郎' },
      }],
      warnings: [],
    });
  });

  it('境界: 名義カナは変換後 30 バイトまで通り、31 バイトは切り詰めずに止める（濁点は 1 バイトとして数える）', () => {
    const thirty = employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'ガ'.repeat(15) }) }), format(), NOW);
    expect(thirty).toMatchObject({ problems: [], holderKanaBytes: 30 });
    const thirtyOne = employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: `${'ガ'.repeat(15)}ア` }) }), format(), NOW);
    expect(codes(thirtyOne)).toEqual({ problems: ['payout-holder-kana-too-long'], warnings: [] });
    expect(thirtyOne.problems[0]).toMatchObject({ field: 'bankAccount.holderKana', params: { employee: 'テスト太郎', bytes: 31 }, fixTarget: 'employee-bank-account' });
    expect(thirtyOne.problems[0]?.message).toContain('変換後 31 バイトで、上限 30 バイトを超えています');
  });

  it('異常: 中点・漢字は変換せずに止め、文字と位置（1 始まり）を示す。禁止文字は長さより先に言う', () => {
    expect(employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'テスト・タロウ' }) }), format(), NOW).problems[0]).toMatchObject({ code: 'payout-holder-kana-invalid', params: { chars: '・', positions: '4' } });
    const kanji = employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: `山田${'ア'.repeat(40)}` }) }), format(), NOW);
    expect(codes(kanji).problems).toEqual(['payout-holder-kana-invalid']);
    expect(kanji.problems[0]?.params).toMatchObject({ chars: '山田', positions: '1, 2' });
  });

  it('正常: 小書き・英小文字の書式の変換は確認必須の警告（変換前後を見せる）。全角 → 半角だけなら警告しない', () => {
    const small = employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'テスト キョウコ' }) }), format(), NOW);
    expect(codes(small)).toEqual({ problems: [], warnings: ['payout-holder-kana-converted'] });
    expect(small.warnings[0]?.params).toEqual({ employee: 'テスト太郎', from: 'テスト キョウコ', to: 'ﾃｽﾄ ｷﾖｳｺ' });
    expect(codes(employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'abc' }) }), format(), NOW)).warnings).toEqual(['payout-holder-kana-converted']);
  });

  it('境界: 「ヲ」は strict では並字に変換して警告、extended ではそのまま通す', () => {
    expect(codes(employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'ヲ' }) }), format(), NOW)).warnings).toEqual(['payout-holder-kana-converted']);
    expect(codes(employeePayoutReadiness(employee({ bankAccount: bank({ holderKana: 'ヲ' }) }), format({ charset: 'extended' }), NOW))).toEqual({ problems: [], warnings: [] });
  });

  it('異常: 銀行名を入れる設定なのに銀行名・支店名のカナが無ければ止める（無い方の欄を示す）', () => {
    expect(employeePayoutReadiness(employee(), format({ includeBankNames: true }), NOW).problems[0]).toMatchObject({ code: 'payout-bank-name-missing', field: 'bankAccount.bankNameKana' });
    expect(employeePayoutReadiness(employee({ bankAccount: bank({ bankNameKana: 'サンプル' }) }), format({ includeBankNames: true }), NOW).problems[0]).toMatchObject({ field: 'bankAccount.branchNameKana' });
    expect(employeePayoutReadiness(employee({ bankAccount: bank({ bankNameKana: 'サンプル', branchNameKana: 'ホンテン' }) }), format({ includeBankNames: true }), NOW).problems).toEqual([]);
  });

  it('異常: 口座の桁が全銀協形式に合わなければ欄ごとに止め、社員番号を顧客コードにする設定では 10 桁以内の数字を求める', () => {
    const broken = employeePayoutReadiness(employee({ bankAccount: bank({ bankCode: '99', branchCode: '9', accountNumber: sealed('ab') }) }), format(), NOW);
    expect(broken.problems.map((entry) => entry.field)).toEqual(['bankAccount.bankCode', 'bankAccount.branchCode', 'bankAccount.accountNumber']);
    expect(broken.problems[0]?.message).toContain('テスト太郎 さんの口座の銀行コードが全銀協形式に合いません');
    const customer = (code: string | undefined) => employeePayoutReadiness(employee({ code }), format({ customerCode1: 'employee-code' }), NOW).problems;
    expect(customer(undefined)[0]).toMatchObject({ code: 'payout-bank-account-invalid', field: 'code', params: { detail: '社員番号がありません' } });
    expect(customer('E001')[0]?.params).toMatchObject({ detail: '社員番号「E001」は 10 桁以内の数字ではありません' });
    expect(customer('12345678901')).toHaveLength(1);
    expect(customer('1234567890')).toEqual([]);
  });

  it('境界: 直近 30 日（ちょうど 30 日前を含む）の口座変更は確認必須の警告、それより前は出さない', () => {
    const changed = (at: string) => employeePayoutReadiness(employee({ history: [{ type: 'bank-account-changed', by: 'editor@example.com', at }] }), format(), NOW);
    expect(changed('2026-08-16T00:00:00.000Z').warnings).toEqual([expect.objectContaining({ code: 'payout-bank-account-recently-changed', field: 'history', params: { employee: 'テスト太郎', changedAt: '2026-08-16T00:00:00.000Z', changedBy: 'editor@example.com' } })]);
    expect(changed('2026-08-15T23:59:59.999Z').warnings).toEqual([]);
  });
});
