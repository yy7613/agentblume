import { describe, expect, it } from 'vitest';
import type { ClauseDto, PlaybookDto } from '../api/contract-types';
import {
  articleAt, clauseFromSelection, contractStatusLabel, CONTRACT_STEPS, daysLeftLabel, deadlineKindLabel, deadlineState, deadlineStateLabel,
  documentStatusLabel, emptyValue, evidenceRanges, FIELD_PATHS, formatConditionValue, formatYen, highlightSegments, isContractStep, legalNotice,
  nextCriterionId, opTakesValue, parseConditionValue, parseContractTarget, playbookToSave, previewParties, previewRecommendedText, roleLabel,
  setValueField, stepBlocker, textToTiers, tiersToText, unknownPlaceholders, valueFields, valueSummary, VALUE_KINDS, verdictLabel,
} from './contract-model';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

describe('手順とディープリンク', () => {
  it('正常: 既知の section だけを手順として開く', () => {
    expect(CONTRACT_STEPS.every(isContractStep)).toBe(true);
    expect(parseContractTarget({ internalId: 'doc-1', section: 'clauses', nodeId: 'term' })).toEqual({ step: 'clauses', id: 'doc-1', nodeId: 'term' });
    expect(parseContractTarget({ internalId: '', section: 'import' })).toEqual({ step: 'import' });
    expect(parseContractTarget({ internalId: 'x', section: 'unknown' })).toBeUndefined();
    expect(parseContractTarget({ internalId: 'x' })).toBeUndefined();
  });

  it('境界: 文書が無ければ条項以降は開けない。未確定ならレビュー・締結は開けない', () => {
    expect(stepBlocker('playbook', undefined, en)).toBeUndefined();
    expect(stepBlocker('ledger', undefined, en)).toBeUndefined();
    expect(stepBlocker('clauses', undefined, en)).toContain('Import a contract first');
    expect(stepBlocker('clauses', { status: 'imported' }, en)).toBeUndefined();
    expect(stepBlocker('review', { status: 'extracted' }, ja)).toContain('条項を確認して確定');
    expect(stepBlocker('sign', { status: 'confirmed' }, en)).toBeUndefined();
  });
});

describe('表示ラベル', () => {
  it('正常: 判定・状態・種類・立場・残り日数の文言を日英で返す', () => {
    expect(verdictLabel('negotiate', ja)).toBe('要交渉');
    expect(verdictLabel('unresolved', en)).toBe('Needs a decision');
    expect(documentStatusLabel('signed', ja)).toBe('締結登録済み');
    expect(deadlineKindLabel('renewal_notice', ja)).toBe('更新拒絶の通知期限');
    expect(deadlineStateLabel('due-soon', en)).toBe('Due soon');
    expect(contractStatusLabel('terminated', ja)).toBe('終了');
    expect(roleLabel('vendor', en)).toContain('Vendor');
    expect(daysLeftLabel(-3, ja)).toBe('3 日超過');
    expect(daysLeftLabel(0, en)).toBe('Due today');
    expect(daysLeftLabel(5, ja)).toBe('あと 5 日');
    expect(legalNotice(ja)).toContain('法的な判断ではありません');
    expect(formatYen(4000, ja)).toBe('4,000 円');
    expect(formatYen(0, en)).toContain('non-taxable');
    expect(formatYen(null, ja)).toBe('不明');
  });

  it('境界: 期限の表示状態は当日 due-soon、翌日から overdue', () => {
    expect(deadlineState(-1, 60)).toBe('overdue');
    expect(deadlineState(0, 60)).toBe('due-soon');
    expect(deadlineState(60, 60)).toBe('due-soon');
    expect(deadlineState(61, 60)).toBe('upcoming');
  });
});

describe('本文のハイライト', () => {
  const clauses: ClauseDto[] = [
    { topicId: 'term', present: true, evidence: [{ quote: 'bc', start: 1, end: 3, verified: true }, { quote: 'x', verified: false }], source: 'llm', warnings: [] },
    { topicId: 'cap', present: true, evidence: [{ quote: 'cd', start: 2, end: 4, verified: true }], source: 'llm', warnings: [] },
  ];

  it('正常: 位置の分かる根拠だけを区間にし、トピックで絞れる', () => {
    expect(evidenceRanges(clauses)).toEqual([{ start: 1, end: 3, topicId: 'term' }, { start: 2, end: 4, topicId: 'cap' }]);
    expect(evidenceRanges(clauses, 'cap')).toEqual([{ start: 2, end: 4, topicId: 'cap' }]);
  });

  it('境界: 重なりは先の区間を優先して割り、範囲外・空の区間は捨てる', () => {
    expect(highlightSegments('abcdef', [...evidenceRanges(clauses), { start: 4, end: 99, topicId: 'bad' }, { start: 5, end: 5, topicId: 'empty' }])).toEqual([
      { start: 0, end: 1, text: 'a', highlighted: false },
      { start: 1, end: 3, text: 'bc', highlighted: true, topicId: 'term' },
      { start: 3, end: 4, text: 'd', highlighted: true, topicId: 'cap' },
      { start: 4, end: 6, text: 'ef', highlighted: false },
    ]);
    expect(highlightSegments('ab', [{ start: 0, end: 1, topicId: 'a' }, { start: 0, end: 1, topicId: 'b' }])).toHaveLength(2);
  });

  it('正常: 選択範囲を根拠にした手入力の条項を作り、照合と競合の警告だけを外す', () => {
    const document = { body: '前文\n第1条 甲は乙に委託する。', articles: [{ ref: '前文', start: 0, end: 3, page: 1 }, { ref: '第1条', start: 3, end: 17, page: 1 }] };
    expect(articleAt(document.articles, 5)?.ref).toBe('第1条');
    const existing: ClauseDto = { topicId: 'x', present: false, articleRef: '第9条', evidence: [], value: { kind: 'text', summary: 's' }, source: 'llm', warnings: [{ code: 'quote-not-found', message: 'q', origin: 'extraction' }, { code: 'value-unparsed', message: 'v', origin: 'extraction' }] };
    const clause = clauseFromSelection(existing, 'x', document, 12, 7);
    expect(clause).toMatchObject({ present: true, articleRef: '第1条', source: 'manual', evidence: [{ quote: '甲は乙に委', start: 7, end: 12, verified: true }], value: { summary: 's' } });
    expect(clause?.warnings.map((warning) => warning.code)).toEqual(['value-unparsed']);
    expect(clauseFromSelection(undefined, 'x', document, 3, 4)).toMatchObject({ articleRef: '第1条' });
    expect(clauseFromSelection(undefined, 'x', { body: '  ', articles: [] }, 0, 2)).toBeUndefined();
    expect(clauseFromSelection(existing, 'x', { body: 'abc', articles: [] }, 0, 2)).toMatchObject({ articleRef: '第9条' });
  });
});

describe('値のフォーム', () => {
  it('正常: すべての値の型にフォーム項目と空の値がある', () => {
    for (const kind of VALUE_KINDS) {
      expect(valueFields(kind, en).length).toBeGreaterThan(0);
      expect(emptyValue(kind).kind).toBe(kind);
    }
    expect(Object.keys(FIELD_PATHS)).toEqual([...VALUE_KINDS]);
  });

  it('境界: 入力の種類ごとに値へ写し、空は項目ごと消す', () => {
    const fields = valueFields('payment_terms', en);
    const closing = fields.find((field) => field.key === 'closingDay')!;
    const offset = fields.find((field) => field.key === 'payMonthOffset')!;
    const method = fields.find((field) => field.key === 'method')!;
    let value = emptyValue('payment_terms');
    value = setValueField(value, closing, 'month_end');
    value = setValueField(value, offset, '2');
    value = setValueField(value, method, 'bank_transfer');
    expect(value).toEqual({ kind: 'payment_terms', basis: 'delivery', closingDay: 'month_end', payMonthOffset: 2, method: 'bank_transfer' });
    expect(setValueField(value, closing, '20')).toMatchObject({ closingDay: 20 });
    expect(setValueField(value, offset, 'abc')).not.toHaveProperty('payMonthOffset');
    expect(setValueField(value, method, '')).not.toHaveProperty('method');
    const renews = valueFields('auto_renewal', en).find((field) => field.key === 'renews')!;
    expect(setValueField(emptyValue('auto_renewal'), renews, false)).toMatchObject({ renews: false });
    expect(valueSummary(value, en)).toContain('closingDay: month_end');
    expect(valueSummary(undefined, ja)).toBe('値はまだありません');
    expect(valueSummary({ kind: 'jurisdiction' }, en)).toBe('No value yet');
  });
});

describe('審査基準の編集', () => {
  it('正常: 置換子の検査とプレビュー（サーバーと同じ規則）', () => {
    expect(unknownPlaceholders('{us}は{counterparty}に{foo}{}')).toEqual(['foo', '']);
    expect(previewRecommendedText('{us}は{paymentMaxDays}日以内に{counterparty}へ（{articleRef}）')).toBe('当社は60日以内に相手方へ（該当条項）');
    expect(previewRecommendedText('{us}', { us: '自社' })).toBe('自社');
  });

  it('境界: 条件の値の入力を演算子に合わせて読む', () => {
    expect(opTakesValue('exists')).toBe(false);
    expect(parseConditionValue('isTrue', 'x')).toBeUndefined();
    expect(parseConditionValue('in', 'prior_consent, prohibited, 3, true')).toEqual(['prior_consent', 'prohibited', 3, true]);
    expect(parseConditionValue('lte', '90')).toBe(90);
    expect(parseConditionValue('contains', '東京')).toBe('東京');
    expect(parseConditionValue('equals', 'false')).toBe(false);
    expect(parseConditionValue('equals', 'us')).toBe('us');
    expect(formatConditionValue(['a', 1])).toBe('a, 1');
    expect(formatConditionValue(undefined)).toBe('');
    expect(formatConditionValue(12)).toBe('12');
  });

  it('正常: 印紙税の階層を行テキストと往復する', () => {
    const tiers = [{ upTo: 9999, amount: 0 }, { upTo: null, amount: 600000 }];
    expect(tiersToText(tiers)).toBe('9999,0\n-,600000');
    expect(textToTiers('9999,0\n\n-,600000\n5')).toEqual([...tiers, { upTo: 5, amount: 0 }]);
    expect(tiersToText(undefined)).toBe('');
  });

  it('正常: 保存用の形（未保存のテンプレートは id を送らない）と基準 id の採番', () => {
    const playbook = { id: 'p1', name: 'n', createdAt: 'c', updatedAt: 'u', criteria: [] } as unknown as PlaybookDto;
    expect(playbookToSave(playbook, false)).toEqual({ id: 'p1', name: 'n', criteria: [] });
    expect(playbookToSave(playbook, true)).toEqual({ name: 'n', criteria: [] });
    expect(nextCriterionId([{ id: 'term-2' } as never], 'term')).toBe('term-3');
    expect(nextCriterionId([{ id: 'term-1' } as never], 'term')).toBe('term-2');
  });

  it('正常: 前文の甲乙を拾う（無ければ空）', () => {
    expect(previewParties('株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は')).toEqual({ A: '株式会社サンプル商事', B: '架空テック合同会社' });
    expect(previewParties('当事者の記載なし')).toEqual({});
    expect(previewParties('株式会社サンプル商事（架空）（以下「甲」という。）')).toEqual({ A: '株式会社サンプル商事' });
  });
});
