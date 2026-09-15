import { describe, expect, it } from 'vitest';
import { GraphError } from '../errors';
import { NodeRegistry } from '../registry';
import { contractClausesSourceNode } from './contract-clauses-source';
import { contractDeadlinesSourceNode } from './contract-deadlines-source';
import { registerContractNodes } from './contract-nodes';
import { contractReviewDraftSourceNode } from './contract-review-draft';

describe('contract-nodes: registerContractNodes', () => {
  it('正常: 3 ノードを登録し、type で同じインスタンスを引ける', () => {
    const registry = new NodeRegistry();
    registerContractNodes(registry);
    expect(registry.types()).toEqual(['contract-review-draft', 'contract-deadlines', 'contract-clauses']);
    expect(registry.get('contract-review-draft')).toBe(contractReviewDraftSourceNode);
    expect(registry.get('contract-deadlines')).toBe(contractDeadlinesSourceNode);
    expect(registry.get('contract-clauses')).toBe(contractClausesSourceNode);
  });

  it('例外: 同じレジストリへ二重に登録すると GraphError（type の衝突を黙って上書きしない）', () => {
    const registry = new NodeRegistry();
    registerContractNodes(registry);
    expect(() => registerContractNodes(registry)).toThrowError(GraphError);
  });
});
