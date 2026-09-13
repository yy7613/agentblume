import { describe, expect, it } from 'vitest';
import { AMBIGUITY_CATALOG, findAmbiguityCase } from './ambiguity-catalog';
import { findAccountByName, findTaxCategory } from './chart-of-accounts';
import { DEFAULT_CHART_OF_ACCOUNTS } from './default-chart';

describe('「迷うケース」カタログの不変条件', () => {
  it('正常: docs/20 §4 の 12 件が揃っている', () => {
    expect(AMBIGUITY_CATALOG.length).toBeGreaterThanOrEqual(12);
    for (const id of ['meal_purpose', 'ec_item_type', 'fixed_asset_check', 'transport_kind', 'prepaid_period', 'withholding_check', 'invoice_registration', 'tax_exempt_kind', 'household_ratio', 'bank_transfer_in', 'account_transfer', 'reduced_rate_check']) {
      expect(findAmbiguityCase(id), id).toBeDefined();
    }
  });

  it('正常: id は一意（Stage 2 のプロンプトと askIf の questionId が指す先）', () => {
    const ids = AMBIGUITY_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('正常: どの項目も title / trigger / question / note が空でない（そのままプロンプトに載る）', () => {
    for (const entry of AMBIGUITY_CATALOG) {
      expect(entry.title.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.trigger.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.question.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.note.trim().length, entry.id).toBeGreaterThan(0);
    }
  });

  it('正常: すべての項目が 2 つ以上の選択肢を持ち、value は項目内で一意', () => {
    for (const entry of AMBIGUITY_CATALOG) {
      expect(entry.options.length, entry.id).toBeGreaterThanOrEqual(2);
      const values = entry.options.map((option) => option.value);
      expect(new Set(values).size, `${entry.id} の選択肢 value`).toBe(values.length);
      for (const option of entry.options) {
        expect(option.value.trim().length, entry.id).toBeGreaterThan(0);
        expect(option.label.trim().length, entry.id).toBeGreaterThan(0);
      }
    }
  });

  it('正常: factPath は `extra.<key>` の形（回答は facts.extra へ書き戻され、ルール条件に使える）', () => {
    for (const entry of AMBIGUITY_CATALOG) {
      expect(entry.factPath, entry.id).toMatch(/^extra\.[A-Za-z][A-Za-z0-9_]*$/u);
    }
  });

  it('正常: factPath は項目ごとに一意（別の質問の回答を上書きしない）', () => {
    const paths = AMBIGUITY_CATALOG.map((entry) => entry.factPath);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('正常: 選択肢が示唆する税区分は標準セットに実在する', () => {
    for (const entry of AMBIGUITY_CATALOG) {
      for (const option of entry.options) {
        const taxCode = option.sets?.taxCode;
        if (taxCode === undefined) continue;
        expect(findTaxCategory(DEFAULT_CHART_OF_ACCOUNTS, taxCode), `${entry.id}/${option.value}: ${taxCode}`).toBeDefined();
      }
    }
  });

  it('正常: 選択肢が示唆する科目名は標準セットの名前か別名で引ける（提案が必ず既存科目に着地する）', () => {
    for (const entry of AMBIGUITY_CATALOG) {
      for (const option of entry.options) {
        const accountHint = option.sets?.accountHint;
        if (accountHint === undefined) continue;
        expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, accountHint), `${entry.id}/${option.value}: ${accountHint}`).toBeDefined();
      }
    }
  });
});

describe('findAmbiguityCase', () => {
  it('正常: id で引ける', () => {
    const entry = findAmbiguityCase('meal_purpose');
    expect(entry?.title).toBe('飲食の目的');
    expect(entry?.factPath).toBe('extra.purpose');
    expect(entry?.options.map((option) => option.value)).toContain('entertainment');
  });

  it('境界: 未知の id・空文字は undefined', () => {
    expect(findAmbiguityCase('nope')).toBeUndefined();
    expect(findAmbiguityCase('')).toBeUndefined();
  });
});

describe('「迷うケース」カタログ（異常系・例外系）', () => {
  it('異常: 知らない id を引くと undefined を返す', () => {
    expect(findAmbiguityCase('no-such-case')).toBeUndefined();
    expect(findAmbiguityCase('MEAL_PURPOSE')).toBeUndefined();
  });

  it('例外: 空文字や記号を渡しても throw しない', () => {
    expect(() => findAmbiguityCase('')).not.toThrow();
    expect(() => findAmbiguityCase('__proto__')).not.toThrow();
    expect(findAmbiguityCase('__proto__')).toBeUndefined();
  });

  it('例外: 選択肢が科目名を指す場合、既定の科目マスタに実在する（名称変更に気づける）', () => {
    for (const item of AMBIGUITY_CATALOG) {
      for (const option of item.options) {
        const accountName = option.sets?.accountHint;
        if (accountName === undefined) continue;
        expect(findAccountByName(DEFAULT_CHART_OF_ACCOUNTS, accountName), `${item.id}: ${accountName}`).toBeDefined();
      }
      for (const option of item.options) {
        const taxCode = option.sets?.taxCode;
        if (taxCode === undefined) continue;
        expect(findTaxCategory(DEFAULT_CHART_OF_ACCOUNTS, taxCode), `${item.id}: ${taxCode}`).toBeDefined();
      }
    }
  });
});
