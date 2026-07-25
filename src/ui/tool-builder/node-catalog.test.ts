import { describe, expect, it } from 'vitest';
import { catalogItem, inputHandleId, NODE_CATALOG, NODE_TYPES, toInputOf } from './node-catalog';

const V15_TYPES = ['join', 'union', 'sort', 'distinct', 'fill-null', 'replace'] as const;

describe('node catalog', () => {
  it('全typeがcatalogから引けて表示文言を持つ', () => {
    expect(NODE_CATALOG).toHaveLength(NODE_TYPES.length);
    for (const type of NODE_TYPES) {
      const item = catalogItem(type);
      expect(item.type).toBe(type);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.labelJa.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.descriptionJa.length).toBeGreaterThan(0);
    }
  });

  it('v15の6ノードはtransformで契約どおりのdefaultConfigを持つ', () => {
    for (const type of V15_TYPES) {
      expect(catalogItem(type).kind).toBe('transform');
    }
    expect(catalogItem('join').defaultConfig).toEqual({ mode: 'inner', keys: [], rightSuffix: '_right' });
    expect(catalogItem('union').defaultConfig).toEqual({ strict: false });
    expect(catalogItem('sort').defaultConfig).toEqual({ keys: [] });
    expect(catalogItem('distinct').defaultConfig).toEqual({ columns: [] });
    expect(catalogItem('fill-null').defaultConfig).toEqual({ rules: [] });
    expect(catalogItem('replace').defaultConfig).toEqual({ rules: [] });
  });

  it('group-byは分析カテゴリ、limitは変換カテゴリで、妥当な初期configを持つ', () => {
    expect(catalogItem('group-by').kind).toBe('analyze');
    expect(catalogItem('group-by').defaultConfig).toEqual({ groupBy: [], aggregates: [{ op: 'count', as: 'count' }] });
    expect(catalogItem('limit').kind).toBe('transform');
    expect(catalogItem('limit').defaultConfig).toEqual({ count: 100, offset: 0 });
    // 単一入力なのでキャンバス側（canConnect）の入力ポート判定は既定の1本になる。
    expect(catalogItem('group-by').inputArity).toBe(1);
    expect(catalogItem('limit').inputArity).toBe(1);
  });

  it('filterの既定configは旧形式（単一条件フラット）のままで後方互換を保つ', () => {
    expect(catalogItem('filter').defaultConfig).toEqual({ column: '', op: 'eq', value: '' });
  });

  it('inputArityはsource=0/通常transform=1/join・union=2', () => {
    for (const item of NODE_CATALOG) {
      if (item.kind === 'source') expect(item.inputArity).toBe(0);
      else if (item.type === 'join' || item.type === 'union') expect(item.inputArity).toBe(2);
      else expect(item.inputArity).toBe(1);
    }
  });

  it('入力ハンドルidとtoInputを相互変換する', () => {
    expect(inputHandleId(0)).toBe('in-0');
    expect(inputHandleId(1)).toBe('in-1');
    expect(toInputOf('in-0')).toBe(0);
    expect(toInputOf('in-1')).toBe(1);
    expect(toInputOf(null)).toBeUndefined();
    expect(toInputOf(undefined)).toBeUndefined();
    expect(toInputOf('other')).toBeUndefined();
  });
});
