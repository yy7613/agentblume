import { describe, expect, it } from 'vitest';
import { reasonGuide, UI_REASON_CODES } from './contract-reasons';

const en = (english: string) => english;
const ja = (_english: string, japanese: string) => japanese;

/** サーバーの `domain/contract/reasons.ts` の列挙（UI は domain を import できないので写しを比べる）。 */
const SERVER_CODES = [
  'clause-missing', 'quote-not-found', 'conflicting-clauses', 'extraction-failed', 'value-unparsed', 'field-missing', 'role-not-set', 'unknown-topic',
  'criterion-failed', 'llm-criterion-failed', 'llm-unclear', 'llm-evidence-missing', 'llm-unavailable', 'payment-over-limit', 'payment-terms-indeterminate',
  'payment-basis-acceptance', 'prohibited-payment-method', 'counterparty-profile-missing', 'deadline-mismatch', 'notice-deadline-passed',
  'stamp-duty-candidate', 'stamp-duty-amount-unknown', 'review-stale',
];

describe('理由コードの 3 点セット', () => {
  it('正常: サーバーの全 code を網羅する', () => {
    expect([...UI_REASON_CODES]).toEqual(SERVER_CODES);
  });

  it.each(UI_REASON_CODES)('正常: %s は原因・次にやること・その場所を開くボタンを日英で揃える', (code) => {
    for (const text of [en, ja]) {
      const guide = reasonGuide(code, { field: 'cap.amount', maxDays: 92, limit: 60, worstCase: '7/1 → 9/30', method: 'promissory_note', name: '第7号文書', amount: 4000, question: 'q', reasoning: 'r', message: 'm', rationale: 'rr', actual: 1, op: 'lte', expected: 0, nature: 'ukeoi', date: '2026-12-31' }, text, { criterionId: 'c1', topicId: 't1' });
      expect(guide.cause).not.toBe('');
      expect(guide.next).not.toBe('');
      expect(guide.actions.length).toBeGreaterThan(0);
      expect(guide.cause).not.toBe(code);
    }
  });

  it('正常: 行き先は理由ごとに決まった場所（設計書 §4.5 の表）', () => {
    expect(reasonGuide('role-not-set', undefined, en).actions).toEqual([{ kind: 'step', step: 'import', label: 'Set our role' }]);
    expect(reasonGuide('payment-over-limit', { maxDays: 92, limit: 60 }, ja).actions).toEqual([{ kind: 'copy-recommended', label: '修正文案をコピー' }, { kind: 'step', step: 'playbook', label: '法令設定を開く', nodeId: 'legal' }]);
    expect(reasonGuide('unknown-topic', undefined, en, { criterionId: 'c9' }).actions[0]).toMatchObject({ step: 'playbook', nodeId: 'c9' });
    expect(reasonGuide('extraction-failed', undefined, en).actions.map((action) => action.kind)).toEqual(['reread', 'settings']);
    expect(reasonGuide('clause-missing', undefined, en, { topicId: 'term' }).actions).toEqual([{ kind: 'step', step: 'clauses', label: 'Point to it in the clauses step', nodeId: 'term' }, { kind: 'rescan-all', label: 'Read all articles' }]);
    expect(reasonGuide('stamp-duty-candidate', { name: 'x' }, en).actions.map((action) => action.kind === 'step' ? action.step : action.kind)).toEqual(['sign', 'playbook']);
    expect(reasonGuide('review-stale', undefined, en).actions[0]?.kind).toBe('rerun-review');
    expect(reasonGuide('notice-deadline-passed', undefined, en).actions[0]).toMatchObject({ step: 'ledger' });
  });

  it('境界: 詳細が無くても文言が崩れない（? で埋める）。未知の code はレビューへ案内する', () => {
    expect(reasonGuide('field-missing', undefined, en).cause).toContain('(?)');
    const unknown = reasonGuide('something-new', undefined, ja);
    expect(unknown).toMatchObject({ severity: 'unresolved', cause: 'something-new' });
    expect(unknown.actions[0]).toMatchObject({ step: 'review' });
  });

  it('正常: 重大度はサーバーの表と同じ', () => {
    expect(reasonGuide('criterion-failed', undefined, en).severity).toBe('onFail');
    expect(reasonGuide('deadline-mismatch', undefined, en).severity).toBe('warning');
    expect(reasonGuide('stamp-duty-amount-unknown', undefined, en).severity).toBe('info');
    expect(reasonGuide('llm-unavailable', undefined, en).severity).toBe('unresolved');
  });
});
