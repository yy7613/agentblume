/**
 * 実用化の設定と記録の型（運賃マスタ・規程のヒアリング・設定の種類・追加読取の応答・明細の区間）。
 */
import { describe, expect, it } from 'vitest';
import { parseExpenseDetailRead, validateDetailRecord, validateExtractionFlags } from './detail-read';
import { createExpenseFareTable, emptyExpenseFareTable, validateFareRoute } from './fare-table';
import { createExpensePolicyHearing, type ExpensePolicyHearing } from './policy-hearing';
import { validateReceiptFacts, validateStations } from './receipt-facts';
import { createExpenseSettings, defaultExpenseSettings, EXPENSE_SETTINGS_KINDS, isExpenseSettingsKind } from './settings';

const AT = '2026-09-15T00:00:00.000Z';
const tenant = { tenantId: 't', workspaceId: 'w' };
const read = { registrationNumberText: 'T1234-5678', payeeNameText: null, transactionDateText: '9/10', issueDateText: null, attendees: { countText: '4名', names: ['山田'] }, purposeClues: [], route: { from: '新宿', to: null, via: [], fareType: 'ic' }, notes: [] };

describe('運賃マスタ', () => {
  const fareRoute = (id: string, extra: Record<string, unknown> = {}) => ({ id, stations: ['新宿', '霞ケ関'], fareType: 'ic', fare: 199, bidirectional: true, ...extra });

  it('正常: 経路と駅名の別名。有効期間が重ならなければ同じ区間を複数持てる', () => {
    const table = createExpenseFareTable({
      routes: [fareRoute('r1', { validTo: '2026-03-31', note: ' ' }), fareRoute('r2', { validFrom: '2026-04-01', fare: 210 }), fareRoute('r3', { fareType: 'ticket', validFrom: '', validTo: null })] as never,
      stationAliases: [{ name: '霞ケ関', aliases: ['霞が関', '霞が関'] }],
      updatedAt: AT,
    });
    expect(table.routes.map((entry) => entry.id)).toEqual(['r1', 'r2', 'r3']);
    expect(table.routes[0]).not.toHaveProperty('note');
    expect(table.stationAliases[0]?.aliases).toEqual(['霞が関']);
    expect(emptyExpenseFareTable()).toMatchObject({ routes: [], stationAliases: [] });
  });

  it('異常: 同じ駅の並び × 券種の有効期間の重なり・運賃の範囲・id', () => {
    expect(() => createExpenseFareTable({ routes: [fareRoute('r1'), fareRoute('r2', { stations: ['新宿', ' 霞ケ関'] })] as never, updatedAt: AT })).toThrow(/overlapping validity/u);
    expect(() => createExpenseFareTable({ routes: [fareRoute('r1'), fareRoute('r1', { fareType: 'ticket' })] as never, updatedAt: AT })).toThrow(/duplicate route id/u);
    expect(() => validateFareRoute(fareRoute('r1', { fare: 0 }), 'r')).toThrow(/fare must be/u);
    expect(() => validateFareRoute(fareRoute('R 1'), 'r')).toThrow(/id must match/u);
    expect(() => validateFareRoute(fareRoute('r1', { fareType: 'bus' }), 'r')).toThrow(/fareType/u);
    expect(() => validateFareRoute(fareRoute('r1', { bidirectional: 1 }), 'r')).toThrow(/bidirectional/u);
    expect(() => validateFareRoute(fareRoute('r1', { validFrom: '2026-05-01', validTo: '2026-04-01' }), 'r')).toThrow(/validFrom must not be after/u);
    expect(() => validateFareRoute(fareRoute('r1', { validTo: '2026/04/01' }), 'r')).toThrow(/YYYY-MM-DD/u);
    expect(() => validateFareRoute(fareRoute('r1', { note: 'x'.repeat(201) }), 'r')).toThrow(/note/u);
    expect(() => validateFareRoute(null, 'r')).toThrow(/must be an object/u);
    expect(() => createExpenseFareTable({ stationAliases: [{ name: '霞ケ関', aliases: [] }], updatedAt: AT })).toThrow(/aliases must be/u);
    expect(() => createExpenseFareTable({ stationAliases: [{ name: '', aliases: ['a'] }], updatedAt: AT })).toThrow(/name must be/u);
    expect(() => createExpenseFareTable({ stationAliases: [null] as never, updatedAt: AT })).toThrow(/must be an object/u);
    expect(() => createExpenseFareTable(null as never)).toThrow(/props are required/u);
  });
});

describe('規程のヒアリング', () => {
  const hearing = (overrides: Partial<ExpensePolicyHearing> = {}): ExpensePolicyHearing => createExpensePolicyHearing({
    tenant, id: 'h1', mode: 'document', source: { documentText: '第1条 交際費は 1 人 5,000 円まで', fileName: 'rule.md', sections: [{ heading: '第1条', start: 0, end: 20 }] },
    status: 'proposed', turns: [],
    proposal: { candidate: { categories: [], claimRules: {}, severityOverrides: {} }, rationales: [{ path: 'category:meal', quote: '1 人 5,000 円', quoteFound: true }], dropped: [{ path: 'approval', reason: '特定個人' }], warnings: ['根拠なし'] },
    basePolicyUpdatedAt: AT, model: { provider: 'lm-studio', model: 'gemma' }, promptVersion: 'expense-policy-hearing/v1', createdAt: AT, updatedAt: AT, ...overrides,
  });

  it('正常: 文書モードの原文・節・案・根拠・捨てた案、質問モードの問いと答え', () => {
    expect(hearing().proposal?.rationales[0]).toEqual({ path: 'category:meal', quote: '1 人 5,000 円', quoteFound: true });
    const questions = hearing({
      mode: 'questions', source: {}, status: 'accepted', acceptedChangeIds: ['x'],
      turns: [{ questions: [{ id: 'q1', text: '基準は？', kind: 'single', options: ['税込', '税抜'], topic: 'entertainment' }], answers: [{ questionId: 'q1', value: ['税込'] }], askedAt: AT, answeredAt: AT }],
    });
    expect(questions.turns[0]?.answers).toEqual([{ questionId: 'q1', value: ['税込'] }]);
  });

  it('異常: 状態に要る案・受け入れた変更・文書モードの原文・往復と問いの数', () => {
    expect(() => hearing({ proposal: undefined })).toThrow(/must have a proposal/u);
    expect(() => hearing({ status: 'accepted' })).toThrow(/acceptedChangeIds/u);
    expect(() => hearing({ source: {} })).toThrow(/needs source.documentText/u);
    expect(() => hearing({ source: { documentText: 'x'.repeat(50_001) } })).toThrow(/50000/u);
    const turn = { questions: [{ id: 'q', text: 't', kind: 'text' as const, topic: 't' }], askedAt: AT };
    expect(() => hearing({ turns: Array.from({ length: 7 }, () => turn) })).toThrow(/at most 6/u);
    expect(() => hearing({ turns: [{ ...turn, questions: [] }] })).toThrow(/1 to 3 questions/u);
    expect(() => hearing({ turns: [{ ...turn, questions: [{ ...turn.questions[0]!, kind: 'date' as never }] }] })).toThrow(/kind must be one of/u);
    expect(() => hearing({ turns: [{ ...turn, answers: [{ questionId: 'q', value: { x: 1 } as never }] }] })).toThrow(/value must be/u);
    expect(() => hearing({ proposal: { candidate: { categories: 'x' } as never, rationales: [], dropped: [], warnings: [] } })).toThrow(/candidate.categories must be an array/u);
    expect(() => hearing({ proposal: { candidate: {}, rationales: [{ path: 'p', quoteFound: 'yes' }] as never, dropped: [], warnings: [] } })).toThrow(/quoteFound/u);
    expect(() => hearing({ source: { documentText: 'x', sections: [{ heading: 'h', start: 5, end: 1 }] } })).toThrow(/sections\[0\]/u);
    expect(() => hearing({ model: { provider: 1 } as never })).toThrow(/model must be/u);
    expect(() => hearing({ mode: 'chat' as never })).toThrow(/mode must be/u);
    expect(() => hearing({ status: 'done' as never })).toThrow(/status must be/u);
    expect(() => createExpensePolicyHearing(null as never)).toThrow(/props are required/u);
  });
});

describe('設定の種類', () => {
  it('正常: 4 種類の既定値と組み立て', () => {
    expect(EXPENSE_SETTINGS_KINDS).toEqual(['organization', 'payout', 'cards', 'fares']);
    for (const kind of EXPENSE_SETTINGS_KINDS) expect(createExpenseSettings(kind, defaultExpenseSettings(kind))).toEqual(defaultExpenseSettings(kind));
    expect(isExpenseSettingsKind('cards')).toBe(true);
    expect(isExpenseSettingsKind('policy')).toBe(false);
  });
});

describe('追加読取の応答と明細の印', () => {
  it('正常: 応答の形だけを見て複製し、壊れた形は undefined（detail-read-failed に倒す）', () => {
    expect(parseExpenseDetailRead(read)).toEqual(read);
    expect(parseExpenseDetailRead({ ...read, route: { ...read.route, fareType: 'bus' } })).toBeUndefined();
    expect(parseExpenseDetailRead({ ...read, attendees: null })).toBeUndefined();
    expect(parseExpenseDetailRead([])).toBeUndefined();
  });

  it('正常 / 異常: 印は重複を除き空なら書かない、記録は応答スキーマと食い違いの欄を検証する', () => {
    expect(validateExtractionFlags([], 'f')).toBeUndefined();
    expect(validateExtractionFlags(['payee-read', 'payee-read'], 'f')).toEqual(['payee-read']);
    expect(() => validateExtractionFlags(['x'], 'f')).toThrow(/must be an array of/u);
    const record = { promptVersion: 'expense-detail/v1', model: { provider: 'p', model: 'm' }, readAt: AT, raw: read, disagreements: [{ field: 'registrationNumber', journalValue: 'T1234567890123', detailValue: null }] };
    expect(validateDetailRecord(record, 'd')).toEqual(record);
    expect(validateDetailRecord(undefined, 'd')).toBeUndefined();
    expect(() => validateDetailRecord({ ...record, raw: {} }, 'd')).toThrow(/response schema/u);
    expect(() => validateDetailRecord({ ...record, disagreements: [{ field: 'amount', journalValue: null, detailValue: null }] }, 'd')).toThrow(/disagreements\[0\]/u);
    expect(() => validateDetailRecord({ ...record, disagreements: 'x' }, 'd')).toThrow(/disagreements must be an array/u);
    expect(() => validateDetailRecord({ ...record, promptVersion: '' }, 'd')).toThrow(/promptVersion/u);
    expect(() => validateDetailRecord({ ...record, model: { provider: 'p' } }, 'd')).toThrow(/model must be/u);
    expect(() => validateDetailRecord([], 'd')).toThrow(/must be an object/u);
  });
});

describe('明細の区間（facts.route）', () => {
  it('正常: 駅名の前後空白を除き、回数の既定は 1、券種は省略可', () => {
    expect(validateReceiptFacts({ route: { stations: [' 新宿 ', '霞ケ関'] } }).route).toEqual({ stations: ['新宿', '霞ケ関'], trips: 1 });
    expect(validateReceiptFacts({ route: { stations: ['新宿', '四ツ谷', '霞ケ関'], trips: 2, fareType: 'ticket' } }).route).toEqual({ stations: ['新宿', '四ツ谷', '霞ケ関'], trips: 2, fareType: 'ticket' });
    expect(validateReceiptFacts({ route: null })).toEqual({});
  });

  it('境界: 駅は 2〜30・各 40 字、回数は 1〜40', () => {
    expect(() => validateStations(['新宿'], 's')).toThrow(/2 to 30 stations/u);
    expect(() => validateStations(Array.from({ length: 31 }, (_, index) => `駅${index}`), 's')).toThrow(/2 to 30 stations/u);
    expect(() => validateStations(['新宿', 'x'.repeat(41)], 's')).toThrow(/1 to 40 characters/u);
    expect(() => validateReceiptFacts({ route: { stations: ['a', 'b'], trips: 41 } })).toThrow(/trips/u);
    expect(() => validateReceiptFacts({ route: { stations: ['a', 'b'], fareType: 'bus' } })).toThrow(/fareType/u);
    expect(() => validateReceiptFacts({ route: [] })).toThrow(/route must be/u);
  });
});
