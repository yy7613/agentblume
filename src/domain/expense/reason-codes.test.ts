import { describe, expect, it } from 'vitest';
import {
  INPUT_REASON_CODES, isReasonCode, MONEY_REASON_CODES, MVP_REASON_CODES, PEOPLE_REASON_CODES, REASON_CATALOG, REASON_CODES, reasonOrder, SEVERITY_OVERRIDES, severityFor,
} from './reason-codes';

describe('REASON_CODES / REASON_CATALOG', () => {
  it('正常: 43 件で一意（MVP の 27 件 + 実用化の 16 件）', () => {
    expect(REASON_CODES).toHaveLength(43);
    expect(new Set(REASON_CODES).size).toBe(43);
    expect(MVP_REASON_CODES).toHaveLength(27);
  });

  it('正常: 全コードにカタログがあり、カタログに余計なコードが無い', () => {
    expect(Object.keys(REASON_CATALOG).sort()).toEqual([...REASON_CODES].sort());
  });

  it('正常: adjustable は選べる値だけで、既定の重さは review か return', () => {
    for (const code of REASON_CODES) {
      const entry = REASON_CATALOG[code];
      expect(['review', 'return']).toContain(entry.defaultSeverity);
      for (const value of entry.adjustable) expect(SEVERITY_OVERRIDES).toContain(value);
      expect(entry.fixTargets.length).toBeGreaterThan(0);
    }
  });

  it('正常: MVP の 27 コードの相対順（評価順）は、実用化のコードを挿入しても変わらない', () => {
    // 画面・ツールは理由をこの順に並べるので、既存の並びが変わると表示と差し戻し文言の順が変わる（§20.4.5）。
    expect(REASON_CODES.filter((code) => (MVP_REASON_CODES as readonly string[]).includes(code))).toEqual([...MVP_REASON_CODES]);
  });

  it('正常: 3 系統のコード集合は互いに素で、和が実用化の 16 件そのもので、MVP のコードと交わらない', () => {
    const people = new Set<string>(PEOPLE_REASON_CODES);
    const money = new Set<string>(MONEY_REASON_CODES);
    const input = new Set<string>(INPUT_REASON_CODES);
    for (const code of people) { expect(money.has(code), code).toBe(false); expect(input.has(code), code).toBe(false); }
    for (const code of money) expect(input.has(code), code).toBe(false);
    const union = [...people, ...money, ...input];
    expect(union).toHaveLength(16);
    const added = REASON_CODES.filter((code) => !(MVP_REASON_CODES as readonly string[]).includes(code));
    expect([...union].sort()).toEqual([...added].sort());
    for (const code of union) expect((MVP_REASON_CODES as readonly string[]).includes(code), code).toBe(false);
  });

  it('正常: 申請の前提（§20.4.1）の 6 件は申請の理由、他の実用化のコードは明細の理由', () => {
    const claimCodes = ['claimant-unlinked', 'claimant-employee-disabled', 'advance-employee-mismatch', 'advance-not-paid', 'advance-already-settled', 'approval-route-unresolved'];
    const added = [...PEOPLE_REASON_CODES, ...MONEY_REASON_CODES, ...INPUT_REASON_CODES];
    for (const code of added) expect(REASON_CATALOG[code].target, code).toBe(claimCodes.includes(code) ? 'claim' : 'item');
    expect(added.filter((code) => REASON_CATALOG[code].target === 'claim').sort()).toEqual([...claimCodes].sort());
  });
});

describe('reasonOrder', () => {
  it('正常: REASON_CODES の位置を返し、申請の前提は claim-empty より先・カードは申請の集計より先', () => {
    expect(reasonOrder('policy-unreviewed')).toBe(0);
    expect(reasonOrder('claimant-unlinked')).toBeLessThan(reasonOrder('claim-empty'));
    expect(reasonOrder('approval-route-unresolved')).toBeLessThan(reasonOrder('category-missing'));
    expect(reasonOrder('route-missing')).toBeGreaterThan(reasonOrder('registration-number-missing'));
    expect(reasonOrder('card-charge-claimed')).toBeLessThan(reasonOrder('per-claim-limit-exceeded'));
    expect(reasonOrder('per-claim-limit-exceeded')).toBe(42);
  });

  it('境界: 未知のコード（承認の擬似コードなど）は末尾（件数と同じ位置）', () => {
    expect(reasonOrder('judgment-stale')).toBe(43);
    expect(reasonOrder('')).toBe(43);
  });
});

describe('isReasonCode', () => {
  it('正常: 既知のコードは true（実用化のコードも含む）', () => {
    expect(isReasonCode('receipt-missing')).toBe(true);
    expect(isReasonCode('fare-exceeds-table')).toBe(true);
  });

  it('異常: 未知の文字列・文字列以外は false', () => {
    expect(isReasonCode('judgment-stale')).toBe(false);
    expect(isReasonCode('approval-not-current-approver')).toBe(false);
    expect(isReasonCode(1)).toBe(false);
    expect(isReasonCode(undefined)).toBe(false);
  });
});

describe('severityFor', () => {
  it('正常: 上書きが無ければ既定の重さ', () => {
    expect(severityFor('purpose-missing', {})).toBe('review');
    expect(severityFor('commuter-pass-overlap', {})).toBe('return');
  });

  it('正常: 選べる値の上書きは反映され、off は undefined', () => {
    expect(severityFor('purpose-missing', { 'purpose-missing': 'return' })).toBe('return');
    expect(severityFor('purpose-missing', { 'purpose-missing': 'off' })).toBeUndefined();
    expect(severityFor('claimant-unlinked', { 'claimant-unlinked': 'off' })).toBeUndefined();
  });

  it('異常: 変更不可のコードは上書きを無視する', () => {
    // 検索要件（日付・金額）の欠落は会社の判断で緩められない
    expect(severityFor('amount-missing', { 'amount-missing': 'off' })).toBe('return');
    expect(severityFor('claim-empty', { 'claim-empty': 'review' })).toBe('return');
    // 他人の仮払・承認者が決まらないのは運用で緩めると支払や承認が壊れる
    expect(severityFor('advance-employee-mismatch', { 'advance-employee-mismatch': 'review' })).toBe('return');
    expect(severityFor('approval-route-unresolved', { 'approval-route-unresolved': 'off' })).toBe('review');
  });

  it('異常: adjustable に無い値（off を選べないコードに off）は既定に戻る', () => {
    expect(severityFor('receipt-missing', { 'receipt-missing': 'off' })).toBe('return');
    expect(severityFor('commuter-pass-overlap', { 'commuter-pass-overlap': 'off' })).toBe('return');
  });
});
