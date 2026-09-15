import { describe, expect, it } from 'vitest';
import { NodeRegistry } from '../registry';
import { ConfigError } from '../errors';
import { RECEIVABLES_INVOICE_DRAFT_SCHEMA, receivablesInvoiceDraftNode } from './receivables-invoice-draft';
import { RECEIVABLES_MATCH_CANDIDATES_SCHEMA, receivablesMatchCandidatesNode } from './receivables-match-candidates';
import { registerReceivablesNodes } from './receivables-nodes';
import { RECEIVABLES_OUTSTANDING_SCHEMA, receivablesOutstandingNode } from './receivables-outstanding';

describe('入金消込のソースノード', () => {
  it.each([
    [receivablesOutstandingNode, RECEIVABLES_OUTSTANDING_SCHEMA, { limit: 1000 }, { limit: 1001 }],
    [receivablesMatchCandidatesNode, RECEIVABLES_MATCH_CANDIDATES_SCHEMA, { limit: 200, maxCandidates: 5 }, { maxCandidates: 6 }],
    [receivablesInvoiceDraftNode, RECEIVABLES_INVOICE_DRAFT_SCHEMA, { limit: 4 }, { limit: 0 }],
  ] as const)('$type: 固定スキーマ・未解決なら空表・設定の上限ちょうどは通し、超えたら ConfigError', (node, schema, valid, invalid) => {
    expect(node.kind).toBe('source');
    expect(node.inputArity).toBe(0);
    expect(node.validateConfig(valid)).toEqual(valid);
    expect(node.validateConfig({})).toEqual({});
    expect(() => node.validateConfig(invalid)).toThrow(ConfigError);
    expect(node.inferSchema([], {})).toEqual({ schema, state: 'confirmed', issues: [] });
    expect(node.execute([], {})).toEqual({ schema, rows: [] });
  });

  it('正常: 登録関数が 3 つのノード型を登録する（型は receivables- で始まる）', () => {
    const registry = new NodeRegistry();
    registerReceivablesNodes(registry);
    for (const type of ['receivables-outstanding', 'receivables-match-candidates', 'receivables-invoice-draft']) expect(registry.get(type).type).toBe(type);
  });
});
