/**
 * 既定の登録簿（`createDefaultRegistry`）に関数電卓ノードが載っていることの固定。
 *
 * ノード単体のテスト（calculate.test.ts）はノードを直接 import するため、`index.ts` で
 * register し忘れても全テストが通ってしまう。登録簿を経由して初めて
 * 「ツールビルダーから使える」ことが確かめられるので、ここで別に固定する。
 *
 * エンジンを通す確認は応用層（`application/etl/calculate.e2e.test.ts`）に置く。
 * 領域層のテストから応用層を読み込むと依存の規律（domain → application 禁止）に反するため。
 */
import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './index';

describe('createDefaultRegistry: 関数電卓ノード', () => {
  it('正常: calculate が transform / 入力 1 として登録されている', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('calculate')).toBe(true);
    const node = registry.get('calculate');
    expect(node.kind).toBe('transform');
    expect(node.inputArity).toBe(1);
  });

  it('正常: cast の直後に並ぶ（部品一覧の並びと揃える）', () => {
    const types = createDefaultRegistry().types();
    expect(types.indexOf('calculate')).toBe(types.indexOf('cast') + 1);
  });

  it('境界: 登録は 1 回だけで、同じ種別が二重に載っていない', () => {
    const types = createDefaultRegistry().types();
    expect(types.filter((type) => type === 'calculate')).toHaveLength(1);
  });

  // 綴り違いを拒む挙動は関数電卓の追加より前から成り立っている。ここで固定するのは、
  // 種別名を足すときに前方一致や大小文字無視のような「親切な」照合を入れてしまう退行を止めるため。
  it('[回帰固定] 異常: 綴り違いの種別は has が false を返す（黙って別のノードを拾わない）', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('calculator')).toBe(false);
    expect(registry.has('Calculate')).toBe(false);
  });

  it('[回帰固定] 例外: 登録されていない種別を get すると投げる（保存済みグラフの種別違いを黙って通さない）', () => {
    expect(() => createDefaultRegistry().get('calculator')).toThrow();
  });
});
