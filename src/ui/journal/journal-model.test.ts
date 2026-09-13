import { describe, expect, it } from 'vitest';
import type { JournalChartOfAccountsDto, JournalCsvPresetDto, JournalDocumentDto, JournalDocumentSummaryDto, JournalJudgmentDto, JournalRuleDto } from '../api/types';
import {
  EMPTY_FACTS_LINE, EMPTY_FACTS_TOTAL, accountsByCategory, amountSpecChoice, amountSpecFromChoice, draftFromFacts, emptyFactsDraft, factsFromDraft, chartValidation, conditionValueFromInput, conditionValueToInput, csvDownloadName, decodeCsvText, detectCsvPreset,
  editableRule, entryBalance, moveAccount, newAccount, newRuleFromDocument, newTaxCategory, normalizeHeader, openJournalTarget, parseCsvRows, previewRows, ruleSpecificity,
  ruleValidation, sortRules, splitList, summarizeConditions, summarizeJudgment, summarizeScope, triggerDownload, validateFactsJson,
} from './journal-model';

const text = (_en: string, ja: string) => ja;

const presets: readonly JournalCsvPresetDto[] = [
  { id: 'generic', name: '汎用', description: '', headerSignature: ['日付', '摘要', '出金', '入金', '残高'], kind: 'generic' },
  { id: 'rakuten', name: '楽天銀行', description: '', headerSignature: ['取引日', '入出金(円)', '取引後残高(円)', '入出金内容'], kind: 'bank_statement' },
  { id: 'rakuten-card', name: '楽天カード', description: '', headerSignature: ['利用日', '利用店名・商品名', '利用者', '支払方法', '利用金額', '支払手数料', '支払総額'], kind: 'card_statement' },
  { id: 'empty', name: '署名なし', description: '', headerSignature: [], kind: 'generic' },
];

const chart: JournalChartOfAccountsDto = {
  accounts: [
    { id: 'cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'bank', name: '普通預金', category: 'asset', aliases: [], enabled: true, sortOrder: 2 },
    { id: 'meeting', name: '会議費', category: 'expense', aliases: [], enabled: true, sortOrder: 3 },
    { id: 'old', name: '旧科目', category: 'expense', aliases: [], enabled: false, sortOrder: 4 },
  ],
  dimensions: [{ id: 'department', name: '部門', values: [{ id: 'sales', name: '営業', enabled: true }] }],
  taxCategories: [
    { code: 'JP-IN-10-S', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true },
    { code: 'JP-OUT-10-S', name: '課税売上 10%', side: 'out', rate: 10, enabled: true },
    { code: 'JP-NA', name: '対象外', side: 'none', enabled: false },
  ],
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function makeRule(overrides: Partial<JournalRuleDto> = {}): JournalRuleDto {
  return {
    id: 'r1', name: 'カフェ', enabled: true, mode: 'auto', priority: 10, scope: { direction: 'out' },
    conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
    outcome: { lines: [{ side: 'debit', accountId: 'meeting', taxCode: 'JP-IN-10-S', amount: 'total' }, { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'total' }] },
    askIf: [], requiredFacts: [], provenance: { origin: 'manual', exampleDocumentIds: [] }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}

describe('normalizeHeader / detectCsvPreset', () => {
  it('正常: 署名の列が全部あるプリセットを選ぶ', () => {
    expect(detectCsvPreset(['日付', '摘要', '出金', '入金', '残高'], presets)?.id).toBe('generic');
    expect(detectCsvPreset(['取引日', '入出金(円)', '取引後残高(円)', '入出金内容'], presets)?.id).toBe('rakuten');
  });

  it('境界: BOM・全角括弧・前後空白（NFKC）を吸収して一致させる', () => {
    expect(normalizeHeader('﻿"取引日"')).toBe('取引日');
    expect(normalizeHeader('入出金（円）')).toBe('入出金(円)');
    expect(detectCsvPreset(['﻿取引日 ', '入出金（円）', '取引後残高（円）', '入出金内容'], presets)?.id).toBe('rakuten');
  });

  it('境界: 複数一致なら署名の長い（具体的な）ほうを選び、余分な列は無視する', () => {
    const wide = [...presets, { id: 'generic-wide', name: '汎用+メモ', description: '', headerSignature: ['日付', '摘要', '出金', '入金', '残高', 'メモ'], kind: 'generic' as const }];
    expect(detectCsvPreset(['日付', '摘要', '出金', '入金', '残高', 'メモ', '備考'], wide)?.id).toBe('generic-wide');
  });

  it('異常: どれにも当たらなければ undefined。署名が空のプリセットは何にも一致しない', () => {
    expect(detectCsvPreset(['a', 'b'], presets)).toBeUndefined();
    expect(detectCsvPreset([], presets)).toBeUndefined();
  });
});

describe('decodeCsvText', () => {
  it('正常: UTF-8 として読めればそのまま返す', () => {
    const bytes = new TextEncoder().encode('日付,摘要\n2026-01-01,テスト');
    expect(decodeCsvText(bytes)).toEqual({ content: '日付,摘要\n2026-01-01,テスト', encoding: 'utf-8' });
  });

  it('正常: UTF-8 で置換文字が出れば Shift_JIS デコーダで読み直す（契約: ファクトリ注入）', () => {
    const calls: string[] = [];
    const factory = (label: string) => ({ decode: () => { calls.push(label); return label === 'utf-8' ? 'x�y' : '日付,摘要'; } });
    expect(decodeCsvText(new Uint8Array([0x93, 0xfa]), factory)).toEqual({ content: '日付,摘要', encoding: 'shift_jis' });
    expect(calls).toEqual(['utf-8', 'shift_jis']);
  });

  it('例外: Shift_JIS デコーダが無い環境では UTF-8 の結果を返す', () => {
    const factory = (label: string) => ({ decode: () => { if (label !== 'utf-8') throw new RangeError('unsupported'); return 'a�'; } });
    expect(decodeCsvText(new Uint8Array([0xff]), factory)).toEqual({ content: 'a�', encoding: 'utf-8' });
  });

  it('正常: 実際の Shift_JIS バイト列を読める（環境が対応していれば）', () => {
    // 「日付」の Shift_JIS: 93 FA 95 74
    const bytes = new Uint8Array([0x93, 0xfa, 0x95, 0x74]);
    const decoded = decodeCsvText(bytes);
    if (decoded.encoding === 'shift_jis') expect(decoded.content).toBe('日付');
    else expect(decoded.content).toContain('�');
  });
});

describe('parseCsvRows / previewRows', () => {
  it('正常: 引用符内のカンマ・改行・"" エスケープを扱い、CRLF と空行を吸収する', () => {
    const rows = parseCsvRows('a,b,c\r\n1,"x, y","say ""hi"""\r\n\r\n2,"multi\nline",z\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'multi\nline', 'z']]);
  });

  it('境界: limit で止まる（ヘッダーは含めない）。BOM は落とす', () => {
    const preview = previewRows('﻿日付,摘要\n1,a\n2,b\n3,c\n4,d\n5,e\n6,f\n7,g', 5);
    expect(preview.headers).toEqual(['日付', '摘要']);
    expect(preview.rows).toHaveLength(5);
    expect(preview.totalRows).toBe(7);
    expect(parseCsvRows('h\n1\n2\n3', 1)).toHaveLength(2);
  });

  it('境界: 空文字列は空のプレビュー', () => {
    expect(previewRows('')).toEqual({ headers: [], rows: [], totalRows: 0 });
  });
});

describe('ruleSpecificity / sortRules', () => {
  it('正常: 条件数 + op 点 + scope 点', () => {
    // 条件 2 (equals 2 + contains 1) + scope: kinds, direction = 2 → 7
    expect(ruleSpecificity({ conditions: [{ field: 'issuerName', op: 'equals', value: 'a' }, { field: 'descriptionNorm', op: 'contains', value: 'b' }], scope: { documentKinds: ['invoice'], direction: 'out' } })).toBe(7);
    expect(ruleSpecificity({ conditions: [{ field: 'x', op: 'startsWith', value: 'a' }], scope: { accountHints: ['楽天'] } })).toBe(3.5);
    expect(ruleSpecificity({ conditions: [{ field: 'x', op: 'exists' }], scope: {} })).toBe(1);
  });

  it('境界: 空の scope 配列は点にならない', () => {
    expect(ruleSpecificity({ conditions: [], scope: { documentKinds: [], accountHints: [] } })).toBe(0);
  });

  it('正常: 一覧は priority 降順 → 特異度 降順 → createdAt 昇順（同点の順序）', () => {
    const a = makeRule({ id: 'a', priority: 5, createdAt: '2026-01-02T00:00:00.000Z' });
    const b = makeRule({ id: 'b', priority: 5, createdAt: '2026-01-01T00:00:00.000Z' });
    const c = makeRule({ id: 'c', priority: 5, conditions: [{ field: 'issuerName', op: 'equals', value: 'x' }] });
    const d = makeRule({ id: 'd', priority: 9 });
    expect(sortRules([a, b, c, d]).map((rule) => rule.id)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('正常: scope と条件の要約', () => {
    expect(summarizeScope({}, text)).toBe('共通');
    expect(summarizeScope({ documentKinds: ['invoice'], direction: 'out', accountHints: ['楽天'] }, text)).toBe('適格請求書 · 支出 · 楽天');
    expect(summarizeConditions([{ field: 'grandTotal', op: 'between', value: [1, 2] }, { field: 'extra.x', op: 'exists' }], text)).toBe('grandTotal の範囲内 1, 2 AND extra.x がある');
    expect(summarizeConditions([], text)).toContain('条件なし');
  });
});

describe('newRuleFromDocument', () => {
  const summary: JournalDocumentSummaryDto = { id: 'd1', kind: 'bank_statement', status: 'undecided', sourceType: 'csv-row', direction: 'out', description: 'スターバックス 渋谷店', grandTotal: 1200, createdAt: '', updatedAt: '' };

  it('正常: counterpartyHint があればそれを条件に、scope は方向と種別', () => {
    const document: JournalDocumentDto = { id: 'd2', kind: 'invoice', source: { type: 'structured' }, facts: { direction: 'out', counterpartyHint: 'ABC商事', descriptionNorm: 'ABC商事 請求', issuerName: 'ABC商事株式会社', accountHint: '楽天銀行' }, extraction: { method: 'structured', warnings: [] }, status: 'undecided', createdAt: '', updatedAt: '' };
    const rule = newRuleFromDocument(document, chart);
    expect(rule.name).toBe('ABC商事');
    expect(rule.conditions).toEqual([{ field: 'descriptionNorm', op: 'contains', value: 'ABC商事' }]);
    expect(rule.scope).toEqual({ documentKinds: ['invoice'], direction: 'out', accountHints: ['楽天銀行'] });
    expect(rule.outcome.lines.map((line) => line.side)).toEqual(['debit', 'credit']);
    // 科目は空（利用者がマスタから選ぶ）。税区分は支出なので仕入側の有効な先頭。
    expect(rule.outcome.lines.every((line) => line.accountId === '')).toBe(true);
    expect(rule.outcome.lines[0]?.taxCode).toBe('JP-IN-10-S');
    expect(rule.outcome.lines[0]?.partnerFrom).toBe('counterpartyHint');
    expect(rule.provenance?.exampleDocumentIds).toEqual(['d2']);
  });

  it('境界: 一覧の要約（counterpartyHint 無し）は摘要の最初の語を条件にする', () => {
    const rule = newRuleFromDocument(summary, chart);
    expect(rule.conditions).toEqual([{ field: 'descriptionNorm', op: 'contains', value: 'スターバックス' }]);
    expect(rule.scope).toEqual({ documentKinds: ['bank_statement'], direction: 'out' });
  });

  it('境界: 摘要も相手先も無ければ issuerName equals、それも無ければ条件なし。unknown 種別は scope に入れない', () => {
    const withIssuer = newRuleFromDocument({ ...summary, description: undefined, issuerName: '  発行者  ', kind: 'unknown' }, chart);
    expect(withIssuer.conditions).toEqual([{ field: 'issuerName', op: 'equals', value: '発行者' }]);
    expect(withIssuer.name).toBe('発行者');
    expect(withIssuer.scope.documentKinds).toBeUndefined();
    const bare = newRuleFromDocument({ ...summary, description: undefined, direction: undefined }, chart);
    expect(bare.conditions).toEqual([]);
    expect(bare.name).toBe('');
    // 方向が無ければ仕入側の税区分を既定にする。
    expect(bare.outcome.lines[0]?.taxCode).toBe('JP-IN-10-S');
  });

  it('正常: 収入なら売上側の税区分を既定にする', () => {
    expect(newRuleFromDocument({ ...summary, direction: 'in' }, chart).outcome.lines[0]?.taxCode).toBe('JP-OUT-10-S');
  });

  it('正常: editableRule は createdAt / updatedAt を落とす', () => {
    const editable = editableRule(makeRule());
    expect('createdAt' in editable).toBe(false);
    expect(editable.id).toBe('r1');
  });
});

describe('ruleValidation', () => {
  it('正常: 整ったルールは指摘なし', () => {
    expect(ruleValidation(editableRule(makeRule()), chart)).toEqual([]);
  });

  it('異常: 名前なし・科目なし・無効科目・税区分なし・借方だけ・正規表現不正を指摘する', () => {
    const issues = ruleValidation({ ...editableRule(makeRule()), name: ' ', conditions: [{ field: 'x', op: 'regex', value: '(' }, { field: '', op: 'contains', value: '' }], outcome: { lines: [{ side: 'debit', accountId: '', taxCode: '', amount: 'total' }, { side: 'debit', accountId: 'old', taxCode: 'JP-NA', amount: { fixed: -1 } }] } }, chart);
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('name');
    expect(paths).toContain('conditions.0.value');
    expect(paths).toContain('conditions.1.field');
    expect(paths).toContain('conditions.1.value');
    expect(paths).toContain('outcome.lines.0.accountId');
    expect(paths).toContain('outcome.lines.0.taxCode');
    expect(paths).toContain('outcome.lines.1.accountId');
    expect(paths).toContain('outcome.lines.1.taxCode');
    expect(paths).toContain('outcome.lines.1.amount');
    expect(paths).toContain('outcome.lines');
  });

  it('境界: exists 系の条件は値が要らない。行なし・按分率範囲外・askIf の空欄を指摘する', () => {
    const base = editableRule(makeRule());
    expect(ruleValidation({ ...base, conditions: [{ field: 'extra.x', op: 'exists' }] }, chart)).toEqual([]);
    const issues = ruleValidation({ ...base, outcome: { lines: [] }, askIf: [{ conditions: [], questionId: '', prompt: '' }], priority: 1.5 }, chart);
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['outcome.lines', 'askIf.0.questionId', 'askIf.0.prompt', 'priority']));
    expect(ruleValidation({ ...base, outcome: { lines: [{ side: 'debit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: { ratio: 2 } }, { side: 'credit', accountId: 'cash', taxCode: 'JP-IN-10-S', amount: 'remainder' }] } }, chart).map((issue) => issue.path)).toEqual(['outcome.lines.0.amount']);
  });

  it('異常: between は 2 数そろっていないと指摘する（片側だけ・逆順・数値でない）', () => {
    const base = editableRule(makeRule());
    const pathsOf = (value: unknown) => ruleValidation({ ...base, conditions: [{ field: 'grandTotal', op: 'between', value: value as never }] }, chart).map((issue) => issue.path);
    expect(pathsOf([5000, 0])).toContain('conditions.0.value');
    expect(pathsOf([5000])).toContain('conditions.0.value');
    expect(pathsOf(['a', 'b'])).toContain('conditions.0.value');
  });

  it('正常: between は下限 ≤ 上限の 2 数なら通る', () => {
    const base = editableRule(makeRule());
    expect(ruleValidation({ ...base, conditions: [{ field: 'grandTotal', op: 'between', value: [0, 5000] }] }, chart)).toEqual([]);
  });
});

describe('conditionValue / amountSpec', () => {
  it('正常: between は 2 数、in はリスト、gte は数値、contains は文字列', () => {
    expect(conditionValueFromInput('between', '100, 200')).toEqual([100, 200]);
    expect(conditionValueFromInput('in', 'a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(conditionValueFromInput('gte', '100000')).toBe(100000);
    expect(conditionValueFromInput('gte', '2026-01-01')).toBe('2026-01-01');
    expect(conditionValueFromInput('contains', ' カフェ ')).toBe('カフェ');
    expect(conditionValueFromInput('exists', 'ignored')).toBeUndefined();
  });

  it('境界: between の欠けた側は 0。表示は配列をカンマ区切り、null は空', () => {
    expect(conditionValueFromInput('between', '5')).toEqual([5, 0]);
    expect(conditionValueToInput('between', [1, 2])).toBe('1, 2');
    expect(conditionValueToInput('equals', null)).toBe('');
    expect(conditionValueToInput('equals', { a: 1 })).toBe('{"a":1}');
  });

  it('正常: 金額指定の往復', () => {
    expect(amountSpecChoice('taxable:8')).toEqual({ choice: 'taxable:8', value: '' });
    expect(amountSpecChoice({ fixed: 500 })).toEqual({ choice: 'fixed', value: '500' });
    expect(amountSpecChoice({ ratio: 0.3 })).toEqual({ choice: 'ratio', value: '0.3' });
    expect(amountSpecFromChoice('fixed', '500')).toEqual({ fixed: 500 });
    expect(amountSpecFromChoice('ratio', 'x')).toEqual({ ratio: 0 });
    expect(amountSpecFromChoice('remainder', '')).toBe('remainder');
  });
});

describe('summarizeJudgment', () => {
  const names = new Map([['r1', 'カフェ'], ['r2', '会議']]);
  const at = '2026-09-01T00:00:00.000Z';
  const undecided = (reasons: Extract<JournalJudgmentDto, { stage: 'undecided' }>['reasons']): JournalJudgmentDto => ({ stage: 'undecided', reasons, candidates: [], judgedAt: at });

  it('境界: 未判定は「判定してください」', () => {
    const summary = summarizeJudgment(undefined, text);
    expect(summary.stage).toBe('none');
    expect(summary.cards[0]?.actions).toEqual([]);
  });

  it('正常: decided は仕訳とルールへのボタン', () => {
    const summary = summarizeJudgment({ stage: 'decided', ruleId: 'r1', entryId: 'e1', specificity: 3, candidates: [], judgedAt: at }, text, names);
    expect(summary.stage).toBe('decided');
    expect(summary.cards[0]?.cause).toContain('カフェ');
    expect(summary.cards[0]?.actions.map((action) => action.target)).toEqual([{ kind: 'open-entry', entryId: 'e1' }, { kind: 'open-rule', ruleId: 'r1' }]);
  });

  it('正常: skipped は見積書/納品書の説明と項目編集', () => {
    const summary = summarizeJudgment({ stage: 'skipped', reason: 'document-kind', judgedAt: at }, text);
    expect(summary.cards[0]?.cause).toContain('見積書・納品書');
    expect(summary.cards[0]?.actions[0]?.target).toEqual({ kind: 'edit-facts' });
  });

  it('正常: no-rule → ルールを作る + ヒアリング', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'no-rule' }]), text).cards;
    expect(card?.actions.map((action) => action.target.kind)).toEqual(['new-rule', 'hearing']);
  });

  it('正常: multiple-rules → 各ルールを開く（名前が無ければ id）', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'multiple-rules', ruleIds: ['r1', 'r9'] }]), text, names).cards;
    expect(card?.cause).toContain('カフェ、r9');
    expect(card?.actions.map((action) => action.target)).toEqual([{ kind: 'open-rule', ruleId: 'r1' }, { kind: 'open-rule', ruleId: 'r9' }]);
  });

  it('正常: missing-fact → 項目を編集 + ルールを開く', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'missing-fact', ruleId: 'r2', facts: ['extra.headcount', 'grandTotal'] }]), text, names).cards;
    expect(card?.cause).toContain('extra.headcount、grandTotal');
    expect(card?.actions.map((action) => action.target)).toEqual([{ kind: 'edit-facts' }, { kind: 'open-rule', ruleId: 'r2' }]);
  });

  it('正常: ask-if → 回答して再判定（質問文つき）', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'ask-if', ruleId: 'r1', questionId: 'purpose', prompt: '誰との飲食ですか' }]), text, names).cards;
    expect(card?.cause).toContain('誰との飲食ですか');
    expect(card?.actions[0]?.target).toEqual({ kind: 'answer', questionId: 'purpose', prompt: '誰との飲食ですか' });
  });

  it('正常: rule-suggest-mode → ルールを開く + ヒアリング', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'rule-suggest-mode', ruleIds: ['r2'] }]), text, names).cards;
    expect(card?.actions.map((action) => action.target)).toEqual([{ kind: 'open-rule', ruleId: 'r2' }, { kind: 'hearing' }]);
  });

  it('正常: unknown-account → 科目マスタ + ルール', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'unknown-account', ruleId: 'r1', accountIds: ['gone'] }]), text, names).cards;
    expect(card?.cause).toContain('gone');
    expect(card?.actions.map((action) => action.target)).toEqual([{ kind: 'open-chart', accountIds: ['gone'] }, { kind: 'open-rule', ruleId: 'r1' }]);
  });

  it('正常: unbalanced → ルールを開く。複数理由は理由ごとに 1 カード', () => {
    const summary = summarizeJudgment(undecided([{ code: 'unbalanced', ruleId: 'r1' }, { code: 'no-rule' }]), text, names);
    expect(summary.cards).toHaveLength(2);
    expect(summary.cards[0]?.actions.map((action) => action.target)).toEqual([{ kind: 'open-rule', ruleId: 'r1' }]);
    expect(summary.cards[0]?.nextStep).toContain('残額');
  });

  it('例外: 未知の code は握りつぶさず code を見せてルール作成へ倒す', () => {
    const [card] = summarizeJudgment(undecided([{ code: 'brand-new' } as never]), text).cards;
    expect(card?.code).toBe('brand-new');
    expect(card?.cause).toContain('brand-new');
    expect(card?.actions[0]?.target).toEqual({ kind: 'new-rule' });
  });
});

describe('validateFactsJson', () => {
  it('正常: 正しい facts を返し、登録番号のハイフンを除いて正規化する', () => {
    const result = validateFactsJson(JSON.stringify({ direction: 'out', grandTotal: 1100, transactionDate: '2026-04-01', registrationNumber: 't1234-5678-90123', lines: [{ description: 'コーヒー', amount: 1100, taxRate: 10 }], totalsByRate: [{ rate: 10, taxableAmount: 1000, taxAmount: 100, amountIncludesTax: false }], extra: { purpose: 'meeting' } }));
    expect(result.errors).toBeUndefined();
    expect(result.facts?.registrationNumber).toBe('T1234567890123');
    expect(result.facts?.grandTotal).toBe(1100);
  });

  it('異常: 壊れた JSON・配列・未知キー・型違いをすべて列挙する', () => {
    expect(validateFactsJson('{')?.errors?.[0]).toMatch(/^JSON:/);
    expect(validateFactsJson('[]').errors).toEqual(['JSON: expected an object']);
    const errors = validateFactsJson(JSON.stringify({ foo: 1, direction: 'sideways', grandTotal: 12.5, transactionDate: '2026/04/01', registrationNumber: 'T12', paymentMethod: 'check', lines: [{ amount: 'x' }, 3], totalsByRate: [{ rate: 5, taxableAmount: 'a' }], extra: [] })).errors ?? [];
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('foo: unknown field'), 'direction: expected "in" or "out"', 'grandTotal: expected an integer (yen, tax included)', 'transactionDate: expected YYYY-MM-DD',
      'registrationNumber: expected T + 13 digits', 'lines[0].description: expected a string', 'lines[0].amount: expected an integer', 'lines[1]: expected an object',
      'totalsByRate[0].rate: expected 10, 8, or 0', 'totalsByRate[0].taxableAmount: expected an integer', 'totalsByRate[0].amountIncludesTax: expected true or false', 'extra: expected an object',
    ]));
    expect(errors.some((error) => error.startsWith('paymentMethod'))).toBe(true);
  });

  it('境界: 空オブジェクトは有効（すべて任意）', () => {
    expect(validateFactsJson('{}')).toEqual({ facts: {} });
  });
});

describe('entryBalance / csvDownloadName / triggerDownload', () => {
  it('正常: 貸借一致', () => {
    expect(entryBalance([{ side: 'debit', amount: 1000 }, { side: 'credit', amount: 600 }, { side: 'credit', amount: 400 }])).toEqual({ debit: 1000, credit: 1000, balanced: true });
  });

  it('異常: 不一致と、境界: 行なしは不一致扱い', () => {
    expect(entryBalance([{ side: 'debit', amount: 1000 }, { side: 'credit', amount: 999 }]).balanced).toBe(false);
    expect(entryBalance([])).toEqual({ debit: 0, credit: 0, balanced: false });
  });

  it('正常: サーバーのファイル名を使い、危険な文字を落とし、.csv を補う', () => {
    expect(csvDownloadName({ fileName: 'journal-2026-09.csv', format: 'generic' })).toBe('journal-2026-09.csv');
    expect(csvDownloadName({ fileName: '../a:b', format: 'generic' })).toBe('..ab.csv');
    expect(csvDownloadName({ format: 'yayoi' }, new Date('2026-09-13T10:00:00.000Z'))).toBe('journal-yayoi-2026-09-13.csv');
  });

  it('例外: URL.createObjectURL が無い環境ではダウンロードせず false（textarea フォールバック）', () => {
    const original = URL.createObjectURL;
    // @ts-expect-error テスト用に未定義にする
    URL.createObjectURL = undefined;
    try { expect(triggerDownload('a.csv', 'x')).toBe(false); }
    finally { URL.createObjectURL = original; }
  });
});

describe('chartValidation', () => {
  it('正常: 整ったマスタは指摘なし', () => {
    expect(chartValidation(chart)).toEqual([]);
  });

  it('異常: 科目 id / code の重複、空の名前、無い既定税区分を指摘する', () => {
    const issues = chartValidation({ ...chart, accounts: [...chart.accounts, { id: 'cash', code: '100', name: '', category: 'asset', aliases: [], enabled: true, sortOrder: 5, defaultTaxCode: 'NOPE' }, { id: ' ', code: '100', name: 'x', category: 'asset', aliases: [], enabled: true, sortOrder: 6 }] });
    const paths = issues.map((issue) => issue.path);
    expect(paths).toEqual(expect.arrayContaining(['accounts.4.id', 'accounts.4.name', 'accounts.4.defaultTaxCode', 'accounts.5.id', 'accounts.5.code']));
    expect(issues.find((issue) => issue.path === 'accounts.4.id')?.message[1]).toContain('1 行目');
  });

  it('異常: 税区分コードの重複・範囲外、補助軸 id と値 id の重複を指摘する', () => {
    const issues = chartValidation({
      ...chart,
      taxCategories: [...chart.taxCategories, { code: 'JP-NA', name: '', side: 'none', rate: 120, deductionRate: 2, enabled: true }],
      dimensions: [...chart.dimensions, { id: 'department', name: '', values: [{ id: 'a', name: 'A', enabled: true }, { id: 'a', name: '', enabled: true }] }],
    });
    expect(issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(['taxCategories.3.code', 'taxCategories.3.name', 'taxCategories.3.rate', 'taxCategories.3.deductionRate', 'dimensions.1.id', 'dimensions.1.name', 'dimensions.1.values.1.id', 'dimensions.1.values.1.name']));
  });
});

describe('accountsByCategory / newAccount / newTaxCategory / moveAccount / splitList', () => {
  it('正常: 有効な科目だけを category ごとに sortOrder 順で出し、空の category は出さない', () => {
    const groups = accountsByCategory(chart);
    expect(groups.map((group) => group.category)).toEqual(['asset', 'expense']);
    expect(groups[1]?.accounts.map((account) => account.id)).toEqual(['meeting']);
  });

  it('正常: 新規科目は衝突しない id と末尾の sortOrder。新規税区分も同様', () => {
    const account = newAccount([...chart.accounts, { id: 'acct-5', name: 'x', category: 'other', aliases: [], enabled: true, sortOrder: 9 }]);
    expect(account.id).toBe('acct-6');
    expect(account.sortOrder).toBe(10);
    expect(newAccount([]).id).toBe('acct-1');
    expect(newTaxCategory(chart.taxCategories).code).toBe('TAX-4');
  });

  it('正常: 並び替えは隣と入れ替えて 1..n に振り直す。端では変えない', () => {
    expect(moveAccount(chart.accounts, 'bank', 'up').map((account) => `${account.id}:${account.sortOrder}`)).toEqual(['bank:1', 'cash:2', 'meeting:3', 'old:4']);
    expect(moveAccount(chart.accounts, 'cash', 'up')).toBe(chart.accounts);
    expect(moveAccount(chart.accounts, 'old', 'down')).toBe(chart.accounts);
    expect(moveAccount(chart.accounts, 'nope', 'down')).toBe(chart.accounts);
  });

  it('正常: カンマ / 読点区切りを配列にし、空要素は捨てる', () => {
    expect(splitList(' a, b、、c ')).toEqual(['a', 'b', 'c']);
    expect(splitList('')).toEqual([]);
  });
});

describe('openJournalTarget', () => {
  it('正常: section ごとに開くタブを決める', () => {
    expect(openJournalTarget({ internalId: 'd1', section: 'document' })).toEqual({ tab: 'judge', section: 'document', id: 'd1' });
    expect(openJournalTarget({ internalId: 'r1', section: 'rule' })).toEqual({ tab: 'rules', section: 'rule', id: 'r1' });
    expect(openJournalTarget({ internalId: 'cash', section: 'account' })).toEqual({ tab: 'chart', section: 'account', id: 'cash' });
    expect(openJournalTarget({ internalId: 'e1', section: 'entry' })).toEqual({ tab: 'export', section: 'entry', id: 'e1' });
  });

  it('境界: 未知の section（hearing など Phase 2）や section 無しは undefined', () => {
    expect(openJournalTarget({ internalId: 'h1', section: 'hearing' })).toBeUndefined();
    expect(openJournalTarget({ internalId: 'x' })).toBeUndefined();
  });
});

describe('factsFromDraft / draftFromFacts', () => {
  it('正常: 入力欄を facts に変換し、空欄はキーごと落とす。登録番号は正規化する', () => {
    const { facts, errors } = factsFromDraft({ ...emptyFactsDraft(), direction: 'out', grandTotal: '1,100', transactionDate: '2026-04-01', registrationNumber: 't1234-5678-90123', lines: [{ description: 'コーヒー', quantity: '2', unitPrice: '550', amount: '1100', taxRate: '8' }], totals: [{ rate: '8', taxableAmount: '1019', taxAmount: '81', amountIncludesTax: false }], extra: '{"purpose":"meeting"}' });
    expect(errors).toEqual({});
    expect(facts).toEqual({ direction: 'out', grandTotal: 1100, transactionDate: '2026-04-01', registrationNumber: 'T1234567890123', lines: [{ description: 'コーヒー', amount: 1100, quantity: 2, unitPrice: 550, taxRate: 8, reducedRateMark: true }], totalsByRate: [{ rate: 8, taxableAmount: 1019, taxAmount: 81, amountIncludesTax: false }], extra: { purpose: 'meeting' } });
    expect('issuerName' in facts).toBe(false);
  });

  it('異常: 金額が整数でない・日付形式・登録番号・明細の必須・extra の JSON を欄ごとに指摘する', () => {
    const { errors } = factsFromDraft({ ...emptyFactsDraft(), grandTotal: '12.5', transactionDate: '2026/04/01', registrationNumber: 'T12', lines: [{ ...EMPTY_FACTS_LINE, quantity: 'x' }], totals: [{ ...EMPTY_FACTS_TOTAL, taxableAmount: '' }], extra: '[1]' });
    expect(Object.keys(errors).sort()).toEqual(['extra', 'grandTotal', 'lines.0.amount', 'lines.0.description', 'lines.0.quantity', 'registrationNumber', 'totals.0.taxableAmount', 'transactionDate']);
    expect(factsFromDraft({ ...emptyFactsDraft(), extra: '{' }).errors['extra']?.[1]).toContain('JSON');
  });

  it('境界: 空のフォームは空の facts。往復（draftFromFacts → factsFromDraft）で同じ facts に戻る', () => {
    expect(factsFromDraft(emptyFactsDraft())).toEqual({ facts: {}, errors: {} });
    const facts = { direction: 'in' as const, issuerName: 'A', grandTotal: 500, paymentMethod: 'cash' as const, lines: [{ description: 'x', amount: 500, taxRate: 10 as const, reducedRateMark: false }], totalsByRate: [{ rate: 10 as const, taxableAmount: 455, amountIncludesTax: false }], extra: { a: 1 } };
    expect(factsFromDraft(draftFromFacts(facts)).facts).toEqual(facts);
    expect(draftFromFacts({}).lines).toEqual([]);
  });
});
