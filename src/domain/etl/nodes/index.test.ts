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
// 診断は「登録簿の口から引けること」が確認の目的なので、実体ではなく ./index から取り込む。
import {
  EXPRESSION_DIAGNOSTIC_CATEGORIES,
  EXPRESSION_ERROR_CODES,
  PERIOD_GRANULARITIES,
  createDefaultRegistry,
  diagnosticCategory,
  parsePeriodLabel,
  previewExpression,
  validateExpression,
} from './index';

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
  it('正常: 式の診断は登録簿経由で引ける（応用層・UI はこの口から使う）', () => {
    // 再公開の書き忘れは型検査では捕まらない（使う側がまだ無いため）。
    // 次の増分（LLM への設定補助）はここから読むので、口が開いていることを固定する。
    expect(typeof validateExpression).toBe('function');
    expect(typeof previewExpression).toBe('function');
    expect(typeof diagnosticCategory).toBe('function');
    expect(EXPRESSION_DIAGNOSTIC_CATEGORIES).toContain('column');
    expect(EXPRESSION_ERROR_CODES.length).toBeGreaterThan(0);

    // 実際に通して、分類と読み替えが登録簿経由でも同じに動くことまで見る。
    const schema = { columns: [{ name: 'price', type: 'string' as const, nullable: true }] };
    expect(validateExpression('[pric] * 2', schema).diagnostics[0]?.category).toBe('column');
    expect(previewExpression('[price] * 2', schema, [{ price: '応相談' }]).diagnosis.notNumericColumns).toEqual(['price']);
  });

  it('正常: parse-period も transform / 入力 1 として、関数電卓の直後に登録されている', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('parse-period')).toBe(true);
    const node = registry.get('parse-period');
    expect(node.kind).toBe('transform');
    expect(node.inputArity).toBe(1);

    const types = registry.types();
    expect(types.indexOf('parse-period')).toBe(types.indexOf('calculate') + 1);
    expect(types.filter((type) => type === 'parse-period')).toHaveLength(1);
  });

  it('正常: 期間ラベルの解釈は登録簿経由で引ける（Factory のデータプロファイラはこの口から使う）', () => {
    // 再公開の書き忘れは型検査では捕まらない（使う側がまだ無いため）。名前と引数を固定する。
    expect(typeof parsePeriodLabel).toBe('function');
    expect(PERIOD_GRANULARITIES).toContain('fiscal-year');
    expect(parsePeriodLabel('2024年度', 4).start?.toISOString()).toBe('2024-04-01T00:00:00.000Z');
    expect(parsePeriodLabel('2024年1-3月期', 4).granularity).toBe('quarter');
  });

  it('[回帰固定] 異常: 綴り違いの種別は has が false を返す（黙って別のノードを拾わない）', () => {
    const registry = createDefaultRegistry();
    expect(registry.has('calculator')).toBe(false);
    expect(registry.has('Calculate')).toBe(false);
  });

  it('[回帰固定] 例外: 登録されていない種別を get すると投げる（保存済みグラフの種別違いを黙って通さない）', () => {
    expect(() => createDefaultRegistry().get('calculator')).toThrow();
  });
});
