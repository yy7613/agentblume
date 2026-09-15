import { describe, expect, it } from 'vitest';
import type { ExpenseDetailRead } from '../detail-read';
import { mergeExpenseDetail, parseAttendeeCount, type DetailMergeDraft } from './detail-merge';

function read(overrides: Partial<ExpenseDetailRead> = {}): ExpenseDetailRead {
  return {
    registrationNumberText: null, payeeNameText: null, transactionDateText: null, issueDateText: null,
    attendees: { countText: null, names: [] }, purposeClues: [], route: { from: null, to: null, via: [], fareType: null }, notes: [],
    ...overrides,
  };
}

function draft(facts: DetailMergeDraft['facts'] = {}, extraction: DetailMergeDraft['extraction'] = { documentKind: 'receipt' }): DetailMergeDraft {
  return { facts, extraction };
}

const noRoute = { routeWanted: false };

describe('mergeExpenseDetail: 登録番号', () => {
  it('正常: 仕訳が落とした番号を追加読取が 13 桁で読んでも埋めず、生の文字列を写して印を付ける', () => {
    const result = mergeExpenseDetail(draft(), read({ registrationNumberText: 'T-1234-5678-90123' }), noRoute);
    expect(result.facts.registrationNumber).toBeUndefined();
    expect(result.rejectedRegistrationNumber).toBe('T-1234-5678-90123');
    expect(result.flags).toEqual(['registration-number-rejected']);
    expect(result.warnings[0]).toContain('自動では入れていません');
  });

  it('異常: 追加読取の番号が 12 桁なら桁数を注意に出す（埋めない）', () => {
    const result = mergeExpenseDetail(draft(), read({ registrationNumberText: 'T123456789012' }), noRoute);
    expect(result.warnings[0]).toContain('数字 12 桁');
    expect(result.facts).toEqual({});
  });

  it('正常: 2 つの値が違えば食い違い（読みの揺れ = ハイフンは同じとみなす）', () => {
    const differ = mergeExpenseDetail(draft({ registrationNumber: 'T1234567890123' }), read({ registrationNumberText: 'T1234567890124' }), noRoute);
    expect(differ.disagreements).toEqual([{ field: 'registrationNumber', journalValue: 'T1234567890123', detailValue: 'T1234567890124' }]);
    expect(differ.flags).toContain('reads-disagree');
    const same = mergeExpenseDetail(draft({ registrationNumber: 'T1234567890123' }), read({ registrationNumberText: 't-1234567890123' }), noRoute);
    expect(same.disagreements).toEqual([]);
    expect(same.flags).toEqual([]);
  });

  it('境界: 下書きに既に生の文字列があれば上書きせず、それと比べる', () => {
    const result = mergeExpenseDetail(draft({}, { documentKind: 'receipt', rejectedRegistrationNumber: 'T12345' }), read({ registrationNumberText: 'T1234567890123' }), noRoute);
    expect(result.rejectedRegistrationNumber).toBeUndefined();
    expect(result.disagreements).toEqual([{ field: 'registrationNumber', journalValue: 'T12345', detailValue: 'T1234567890123' }]);
  });
});

describe('mergeExpenseDetail: 取引日・発行日', () => {
  it('正常: 仕訳の取引日 = 発行日 で追加読取に利用日の印字が無ければ、発行日で代用した値の印', () => {
    const result = mergeExpenseDetail(draft({ transactionDate: '2026-09-10', issueDate: '2026-09-10' }), read({ issueDateText: '2026/9/10' }), noRoute);
    expect(result.flags).toEqual(['transaction-date-substituted']);
    expect(result.disagreements).toEqual([]);
  });

  it('境界: 利用日の印字があり同じ日付なら代用の印も食い違いも出さない', () => {
    const result = mergeExpenseDetail(draft({ transactionDate: '2026-09-10', issueDate: '2026-09-10' }), read({ transactionDateText: '2026/9/10' }), noRoute);
    expect(result.flags).toEqual([]);
  });

  it('異常: 日付が違えば食い違い（印字と解釈した日付を並べる）。取引日を埋めない', () => {
    const result = mergeExpenseDetail(draft({ transactionDate: '2026-09-10', issueDate: '2026-09-12' }), read({ transactionDateText: '令和8年9月11日', issueDateText: '2026-09-12' }), noRoute);
    expect(result.disagreements).toEqual([{ field: 'transactionDate', journalValue: '2026-09-10', detailValue: '令和8年9月11日（2026-09-11）' }]);
    expect(result.facts.transactionDate).toBe('2026-09-10');
  });

  it('例外: 日付として解釈できない印字は注意。仕訳に値が無ければ埋めずに注意', () => {
    expect(mergeExpenseDetail(draft(), read({ transactionDateText: 'きのう' }), noRoute).warnings).toEqual(['追加の読取の取引日「きのう」を日付として解釈できませんでした']);
    const missing = mergeExpenseDetail(draft(), read({ issueDateText: '2026-09-01' }), noRoute);
    expect(missing.facts.issueDate).toBeUndefined();
    expect(missing.warnings).toEqual(['追加の読取では発行日が「2026-09-01」でした。自動では入れていません']);
  });
});

describe('mergeExpenseDetail: 支払先', () => {
  it('正常: 精算書で支払先が空なら追加読取の店名を候補として入れ、印を付ける', () => {
    const result = mergeExpenseDetail(draft({}, { documentKind: 'expense_report' }), read({ payeeNameText: ' サンプルマート ' }), noRoute);
    expect(result.facts.payeeName).toBe('サンプルマート');
    expect(result.flags).toEqual(['payee-from-report', 'payee-read']);
  });

  it('境界: 精算書でも店名が読めなければ印は payee-from-report だけ。レシートの空欄は埋めない', () => {
    expect(mergeExpenseDetail(draft({}, { documentKind: 'slip_cash_out' }), read(), noRoute).flags).toEqual(['payee-from-report']);
    const receipt = mergeExpenseDetail(draft({ payeeName: ' ' }), read({ payeeNameText: 'サンプルマート' }), noRoute);
    expect(receipt.facts.payeeName).toBe(' ');
    expect(receipt.flags).toEqual([]);
  });

  it('異常: 店名のキーが違えば食い違い。一方が他方を含む（支店名の有無）は食い違いにしない', () => {
    expect(mergeExpenseDetail(draft({ payeeName: 'サンプル交通' }), read({ payeeNameText: '別の店' }), noRoute).disagreements).toEqual([{ field: 'payeeName', journalValue: 'サンプル交通', detailValue: '別の店' }]);
    expect(mergeExpenseDetail(draft({ payeeName: 'サンプルマート 霞が関店' }), read({ payeeNameText: 'サンプルマート' }), noRoute).disagreements).toEqual([]);
  });
});

describe('mergeExpenseDetail: 参加人数・区間・目的', () => {
  it('正常: 人数と氏名が空なら埋めて印を付ける（全角数字も読む）', () => {
    const result = mergeExpenseDetail(draft(), read({ attendees: { countText: '４名', names: [' サンプル一郎 ', '', 'テスト太郎'] } }), noRoute);
    expect(result.facts.attendees).toEqual({ count: 4, names: ['サンプル一郎', 'テスト太郎'] });
    expect(result.flags).toEqual(['attendees-read']);
  });

  it('境界: 既に人数があれば変えない。氏名だけ空なら氏名だけ埋める', () => {
    const result = mergeExpenseDetail(draft({ attendees: { count: 3 } }), read({ attendees: { countText: '4名', names: ['A'] } }), noRoute);
    expect(result.facts.attendees).toEqual({ count: 3, names: ['A'] });
  });

  it('正常: 費目に区間の設定があって空なら、出発・経由・到着を区間の候補にする', () => {
    const result = mergeExpenseDetail(draft(), read({ route: { from: '中野', to: '霞ケ関', via: ['新宿', ' '], fareType: 'ic' } }), { routeWanted: true });
    expect(result.facts.route).toEqual({ stations: ['中野', '新宿', '霞ケ関'], trips: 1, fareType: 'ic' });
    expect(result.flags).toEqual(['route-read']);
  });

  it('境界: 区間を使わない費目・到着が無い・駅が多すぎる・既に区間がある なら埋めない', () => {
    const route = { from: '中野', to: '霞ケ関', via: [], fareType: null };
    expect(mergeExpenseDetail(draft(), read({ route }), noRoute).facts.route).toBeUndefined();
    expect(mergeExpenseDetail(draft(), read({ route: { ...route, to: null } }), { routeWanted: true }).facts.route).toBeUndefined();
    expect(mergeExpenseDetail(draft(), read({ route: { ...route, via: Array.from({ length: 29 }, (_, index) => `駅${index}`) } }), { routeWanted: true }).facts.route).toBeUndefined();
    expect(mergeExpenseDetail(draft(), read({ route: { ...route, to: 'あ'.repeat(41) } }), { routeWanted: true }).facts.route).toBeUndefined();
    const existing = { stations: ['新宿', '渋谷'], trips: 2 };
    expect(mergeExpenseDetail(draft({ route: existing }), read({ route }), { routeWanted: true }).facts.route).toEqual(existing);
    expect(mergeExpenseDetail(draft(), read({ route }), { routeWanted: true }).facts.route).toEqual({ stations: ['中野', '霞ケ関'], trips: 1 });
  });

  it('正常: 目的の手がかりは埋めずに重複を除いて返す', () => {
    const result = mergeExpenseDetail(draft(), read({ purposeClues: ['お品代', ' お品代 ', '会議用'] }), noRoute);
    expect(result.purposeClues).toEqual(['お品代', '会議用']);
    expect(result.facts.purpose).toBeUndefined();
  });

  it('正常: 人の確認待ちの印は保ち、読取ごとに作り直す印（失敗・食い違い）は外す', () => {
    const result = mergeExpenseDetail(draft({}, { documentKind: 'receipt', flags: ['purpose-read', 'detail-read-failed', 'reads-disagree'] }), read(), noRoute);
    expect(result.flags).toEqual(['purpose-read']);
  });
});

describe('parseAttendeeCount', () => {
  it.each([[null, undefined], ['', undefined], ['名', undefined], ['0名', undefined], ['1名', 1], ['999', 999], ['1000人', undefined]])('境界: %s → %s', (text, expected) => {
    expect(parseAttendeeCount(text)).toBe(expected);
  });
});
