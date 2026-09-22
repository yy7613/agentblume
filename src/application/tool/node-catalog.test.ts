import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../../domain/etl/registry';
import { createDefaultRegistry } from '../../domain/etl/nodes';
import { registerContractNodes } from '../../domain/etl/nodes/contract-nodes';
import { registerExpenseNodes } from '../../domain/etl/nodes/expense-nodes';
import { registerJournalNodes } from '../../domain/etl/nodes/journal-nodes';
import { registerReceivablesNodes } from '../../domain/etl/nodes/receivables-nodes';
import { DATA_SOURCE_NODE_TYPES, DESIGN_NODE_CATALOG, DESIGN_NODE_TYPES, nodeCatalogText } from './node-catalog';

/**
 * 業務テンプレート専用ノードの種別（`register<業務>Nodes` が登録するもの）。
 * カタログは汎用ノードだけを載せるので、突き合わせではこの集合を引く。
 */
function businessNodeTypes(): Set<string> {
  const registry = new NodeRegistry();
  registerJournalNodes(registry);
  registerExpenseNodes(registry);
  registerReceivablesNodes(registry);
  registerContractNodes(registry);
  return new Set(registry.types());
}

/**
 * レジストリに載らない source 種別。`database-source` / `web-search-source` は
 * `ResolveDataSourceGraphUseCase` が実行直前に `json-source` へ展開するため、EtlNode としては
 * 登録されていない。パレットには並ぶので、カタログには載せる。
 */
const RESOLVED_SOURCE_TYPES: readonly string[] = ['database-source', 'web-search-source'];

describe('設計アシスタントのノードカタログ', () => {
  const business = businessNodeTypes();
  const registryTypes = createDefaultRegistry().types().filter((type) => !business.has(type));

  it('正常: パレットの 29 種すべてが載っている（種別は昇順で重複なし）', () => {
    expect(DESIGN_NODE_TYPES).toHaveLength(29);
    expect(new Set(DESIGN_NODE_TYPES).size).toBe(DESIGN_NODE_TYPES.length);
    expect([...DESIGN_NODE_TYPES]).toEqual([...DESIGN_NODE_TYPES].sort());
  });

  it('正常: 載っている種別はすべて登録済み（実行直前に展開される source 2 種を除く）', () => {
    const missing = DESIGN_NODE_TYPES.filter((type) => !registryTypes.includes(type) && !RESOLVED_SOURCE_TYPES.includes(type));
    expect(missing).toEqual([]);
  });

  it('正常: 登録済みの汎用ノードはすべて載っている（ノードを足したらカタログも足す）', () => {
    const uncovered = registryTypes.filter((type) => !DESIGN_NODE_TYPES.includes(type));
    expect(uncovered).toEqual([]);
  });

  it('異常: 業務専用ノードは 1 つも載せない（設計チャットは汎用ノードだけを扱う）', () => {
    expect(business.size).toBeGreaterThan(0);
    expect(DESIGN_NODE_TYPES.filter((type) => business.has(type))).toEqual([]);
  });

  it('正常: どの種別も config の契約を 1〜3 行の英文で持つ', () => {
    for (const entry of DESIGN_NODE_CATALOG) {
      const lines = entry.contract.split('\n');
      expect(lines.length, entry.type).toBeGreaterThanOrEqual(1);
      expect(lines.length, entry.type).toBeLessThanOrEqual(3);
      for (const line of lines) expect(line.trim(), entry.type).not.toBe('');
    }
  });

  it('正常: 語彙は domain の正準リストから組む（filter の演算子・group-by の集約・期間の粒度）', () => {
    const filter = DESIGN_NODE_CATALOG.find((entry) => entry.type === 'filter')?.contract ?? '';
    // `in` / `notIn` を持つビルドでは複数値の書き方まで示す（プロンプトだけが古くならないように）。
    expect(filter).toContain("'in', 'notIn'");
    expect(filter).toContain('valueBinding');
    expect(filter).toContain('opBinding');
    expect(DESIGN_NODE_CATALOG.find((entry) => entry.type === 'group-by')?.contract).toContain("'count-distinct'");
    expect(DESIGN_NODE_CATALOG.find((entry) => entry.type === 'parse-period')?.contract).toContain("'fiscal-year'");
    // 関数電卓の文法は「角括弧で列参照」が肝（裸の名前は定数として読まれる）。
    expect(DESIGN_NODE_CATALOG.find((entry) => entry.type === 'calculate')?.contract).toContain('[unit price] * [quantity]');
    // 2 入力ノードは toInput を必ず言う。
    expect(DESIGN_NODE_CATALOG.find((entry) => entry.type === 'join')?.contract).toContain('"toInput": 0');
    expect(DESIGN_NODE_CATALOG.find((entry) => entry.type === 'union')?.contract).toContain('"toInput": 0');
  });

  it('正常: データソース id を持つ source 種別はカタログに載っており、そう書いてある', () => {
    for (const type of DATA_SOURCE_NODE_TYPES) {
      const entry = DESIGN_NODE_CATALOG.find((candidate) => candidate.type === type);
      expect(entry, type).toBeDefined();
      expect(entry?.contract, type).toContain('dataSourceId');
    }
  });

  it('正常: プロンプト本文は種別ごとに 1 ブロックで、種別名が行頭に出る', () => {
    const text = nodeCatalogText();
    for (const entry of DESIGN_NODE_CATALOG) expect(text).toContain(`- ${entry.type}: `);
    expect(text.split('\n- ')).toHaveLength(DESIGN_NODE_CATALOG.length);
  });
});
