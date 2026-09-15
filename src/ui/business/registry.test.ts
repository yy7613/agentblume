import { describe, expect, it } from 'vitest';
import { SCREENS } from '../screens';
import { BUSINESSES, businessOf, businessRegistryProblems } from './registry';
import { BUSINESS_SCREENS } from './screen-ids';
import type { BusinessDescriptor } from './types';

/** 業務テンプレートの登録表（ADR-0039）の規律。 */
function descriptor(overrides: Partial<BusinessDescriptor> = {}): BusinessDescriptor {
  return {
    id: 'sample', screen: 'Expense', listed: false,
    card: { title: { en: 'Sample', ja: '見本' }, summary: { en: 's', ja: 's' }, order: 99 },
    help: { title: { en: 'Sample', ja: '見本' }, summary: { en: 's', ja: 's' }, steps: [{ en: 's', ja: 's' }] },
    loading: { en: 'Loading…', ja: '読み込み中…' },
    loadPage: async () => () => null,
    ...overrides,
  };
}

describe('業務テンプレートの登録表', () => {
  it('正常: 既定の登録は整合している（id・画面・並び順が一意で、画面ID表と過不足が無い）', () => {
    expect(businessRegistryProblems()).toEqual([]);
    expect(BUSINESSES.map((business) => business.screen)).toEqual([...BUSINESS_SCREENS]);
  });

  it('正常: 業務の画面IDはすべて SCREENS に載っている（#/<画面ID> で開ける）', () => {
    for (const screen of BUSINESS_SCREENS) expect(SCREENS).toContain(screen);
  });

  it('正常: 仕訳は一覧に並び、未実装の業務は並ばない（使えない入口を出さない）', () => {
    expect(businessOf('Journal')?.listed).toBe(true);
  });

  it('正常: 画面から業務を引ける。業務でない画面は undefined', () => {
    expect(businessOf('Journal')?.id).toBe('journal');
    expect(businessOf('Tool')).toBeUndefined();
    expect(businessOf('Expense', [descriptor()])?.id).toBe('sample');
  });

  it('正常: どの業務の画面も読み込めて、ヘルプとカードの文言が空でない', async () => {
    for (const business of BUSINESSES) {
      expect(typeof await business.loadPage(), business.id).toBe('function');
      expect(business.help.steps.length, business.id).toBeGreaterThan(0);
      expect(business.help.title.ja, business.id).not.toBe('');
      expect(business.card.title.ja, business.id).not.toBe('');
      expect(business.loading.ja, business.id).not.toBe('');
    }
  });

  it('異常: id・画面・並び順の重複を文で返す', () => {
    const problems = businessRegistryProblems([descriptor(), descriptor()], ['Expense']);
    expect(problems).toEqual(['duplicate business id: sample', 'duplicate business screen: Expense', 'duplicate card order: 99']);
  });

  it('異常: 画面ID表に載っているのに記述子が無い／記述子があるのに画面ID表に無い', () => {
    expect(businessRegistryProblems([descriptor()], ['Expense', 'Contract'])).toEqual(['screen has no business: Contract']);
    expect(businessRegistryProblems([descriptor({ screen: 'Contract' })], [])).toEqual(['business screen is not listed in BUSINESS_SCREENS: Contract']);
  });

  it('境界: 空の登録と空の画面ID表は整合している', () => {
    expect(businessRegistryProblems([], [])).toEqual([]);
  });
});
