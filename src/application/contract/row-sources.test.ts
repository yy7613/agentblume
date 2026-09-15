import { describe, expect, it, vi } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { ToolGraph } from '../../domain/etl/graph';
import { CONTRACT_CLAUSES_SCHEMA } from '../../domain/etl/nodes/contract-clauses-source';
import { CONTRACT_DEADLINES_SCHEMA } from '../../domain/etl/nodes/contract-deadlines-source';
import { CONTRACT_REVIEW_DRAFT_SCHEMA } from '../../domain/etl/nodes/contract-review-draft';
import { DataSourceValidationError } from '../data-source/manage-data-sources';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import {
  CONTRACT_MISSING_ATTACHMENTS, contractRowSources, type ContractClauseReadPort, type ContractDeadlineReadPort, type ContractReviewDraftReadPort, type ContractRowSourcePorts,
} from './row-sources';

/**
 * 契約の行ソース 3 種を `ResolveDataSourceGraphUseCase` 経由で解決する（書き換えの規律は共通側、宣言はここ）。
 */
const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const resolverWith = (ports: ContractRowSourcePorts = {}) => new ResolveDataSourceGraphUseCase(new InMemoryDataSourceRepository(), undefined, undefined, contractRowSources(ports));
const graphOf = (type: string, config: Record<string, unknown> = {}): ToolGraph => ({ nodes: [{ id: 'source', type, config }], edges: [] });
type PortMock = { rows: ReturnType<typeof vi.fn> };

describe('契約の行ソース: 登録', () => {
  it('ポートの有無に関わらず 3 種を固定スキーマつきで登録する（未配線を理由付きで拒否するため）', () => {
    expect(contractRowSources({}).map((source) => [source.nodeType, source.requirement, source.schema, source.rows])).toEqual([
      ['contract-review-draft', 'attachments-or-documents', CONTRACT_REVIEW_DRAFT_SCHEMA, undefined],
      ['contract-deadlines', 'none', CONTRACT_DEADLINES_SCHEMA, undefined],
      ['contract-clauses', 'none', CONTRACT_CLAUSES_SCHEMA, undefined],
    ]);
    expect(contractRowSources({})[0]?.missingAttachmentsMessage).toBe(CONTRACT_MISSING_ATTACHMENTS);
  });
});

describe('契約の行ソース: contract-review-draft', () => {
  const graph = graphOf('contract-review-draft');
  const document = { name: 'contract.pdf', text: '第1条 本文', pageCount: 2 };
  const image = { name: 'page1.png', dataUrl: 'data:image/png;base64,AAA' };
  const rows = [{ file_name: 'contract.pdf', row_type: 'document' }];
  const withPort = (port?: PortMock) => resolverWith(port === undefined ? {} : { reviewDraft: port as unknown as ContractReviewDraftReadPort });

  it('正常: テキスト添付と画像をポートへ渡し、固定スキーマ付きの json-source へ書き換える（元のグラフは変えない）', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    const resolved = await withPort(port).execute(scope, graph, { attachments: [image], documents: [document] });
    expect(resolved.nodes[0]).toEqual({ id: 'source', type: 'json-source', config: { rows, schema: CONTRACT_REVIEW_DRAFT_SCHEMA } });
    expect(port.rows).toHaveBeenCalledWith(scope, { documents: [document], images: [image] }, {});
    expect(graph.nodes[0]?.type).toBe('contract-review-draft');
  });

  it('正常: テキストだけ・画像だけでも読む。設定（playbookId・llmCriteria・limit）はポートへそのまま渡す', async () => {
    const port = { rows: vi.fn().mockResolvedValue([]) };
    const resolved = await withPort(port).execute(scope, graph, { documents: [document] });
    expect(resolved.nodes[0]?.config).toEqual({ rows: [], schema: CONTRACT_REVIEW_DRAFT_SCHEMA });
    expect(port.rows).toHaveBeenLastCalledWith(scope, { documents: [document], images: [] }, {});
    await withPort(port).execute(scope, graphOf('contract-review-draft', { playbookId: 'pb-1', llmCriteria: false, limit: 2 }), { attachments: [image] });
    expect(port.rows).toHaveBeenLastCalledWith(scope, { documents: [], images: [image] }, { playbookId: 'pb-1', llmCriteria: false, limit: 2 });
  });

  it('境界: 実行文脈が無い呼び出し（保存・スキーマ点検）では書き換えず、ポートも呼ばない', async () => {
    const port = { rows: vi.fn() };
    await expect(withPort(port).execute(scope, graph)).resolves.toEqual(graph);
    await expect(withPort().execute(scope, graph)).resolves.toEqual(graph);
    expect(port.rows).not.toHaveBeenCalled();
  });

  it('異常: 実行中に添付が 0 件（画像もテキストも無い）なら、何を添付すればよいかを書いて落とす', async () => {
    const port = { rows: vi.fn() };
    for (const context of [{}, { attachments: [], documents: [] }]) {
      const error = await withPort(port).execute(scope, graph, context).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DataSourceValidationError);
      expect((error as Error).message).toBe('no contract is attached to this message; attach the contract PDF or paste its text and ask again');
    }
    expect(port.rows).not.toHaveBeenCalled();
  });

  it('異常: ポートが配線されていなければ実行させない（空表を「条項なし」と読ませない）', async () => {
    await expect(withPort().execute(scope, graph, { documents: [document] })).rejects.toThrow('contract review draft is not available');
  });

  it('例外: 設定が壊れていれば、ポートを呼ぶ前に DataSourceValidationError', async () => {
    const port = { rows: vi.fn() };
    for (const config of [{ playbookId: '' }, { playbookId: 42 }, { llmCriteria: 'yes' }, { limit: 3 }, { limit: 0 }, { limit: 1.5 }, { limit: '1' }]) {
      await expect(withPort(port).execute(scope, graphOf('contract-review-draft', config), { documents: [document] }), JSON.stringify(config)).rejects.toThrow('contract review draft source has invalid settings');
    }
    expect(port.rows).not.toHaveBeenCalled();
  });
});

describe('契約の行ソース: contract-deadlines', () => {
  const rows = [{ contract_id: 'sc-1', kind: 'expiry' }];
  const withPort = (port?: ContractDeadlineReadPort) => resolverWith(port === undefined ? {} : { deadlines: port });

  it('正常: 文脈に依らず（保存時の点検でも）ポートの行へ書き換え、設定を渡す。0 件でもスキーマを添える', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    expect((await withPort(port as unknown as ContractDeadlineReadPort).execute(scope, graphOf('contract-deadlines'))).nodes[0]).toEqual({ id: 'source', type: 'json-source', config: { rows, schema: CONTRACT_DEADLINES_SCHEMA } });
    expect(port.rows).toHaveBeenLastCalledWith(scope, {});
    await withPort(port as unknown as ContractDeadlineReadPort).execute(scope, graphOf('contract-deadlines', { includeOverdue: true, horizonDays: 3650, limit: 500 }), { attachments: [] });
    expect(port.rows).toHaveBeenLastCalledWith(scope, { includeOverdue: true, horizonDays: 3650, limit: 500 });
    const empty = await withPort({ rows: async () => [] }).execute(scope, graphOf('contract-deadlines'));
    expect(empty.nodes[0]?.config).toEqual({ rows: [], schema: CONTRACT_DEADLINES_SCHEMA });
  });

  it('異常: 未配線は落とし、壊れた設定はポートを呼ばずに拒否する', async () => {
    await expect(withPort().execute(scope, graphOf('contract-deadlines'))).rejects.toThrow('contract deadlines are not available');
    const port = { rows: vi.fn() };
    for (const config of [{ includeOverdue: 'yes' }, { horizonDays: 0 }, { horizonDays: 36_501 }, { horizonDays: 1.5 }, { limit: 10_001 }, { limit: 0 }]) {
      await expect(withPort(port as unknown as ContractDeadlineReadPort).execute(scope, graphOf('contract-deadlines', config)), JSON.stringify(config)).rejects.toThrow('contract deadlines source has invalid settings');
    }
    expect(port.rows).not.toHaveBeenCalled();
  });
});

describe('契約の行ソース: contract-clauses', () => {
  const rows = [{ contract_id: 'sc-1', topic_id: 'term', tags: ',missing,' }];
  const withPort = (port?: ContractClauseReadPort) => resolverWith(port === undefined ? {} : { clauses: port });

  it('正常: ポートの行へ書き換え、status と limit を渡す', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    expect((await withPort(port as unknown as ContractClauseReadPort).execute(scope, graphOf('contract-clauses', { status: 'expired', limit: 10 }))).nodes[0])
      .toEqual({ id: 'source', type: 'json-source', config: { rows, schema: CONTRACT_CLAUSES_SCHEMA } });
    expect(port.rows).toHaveBeenLastCalledWith(scope, { status: 'expired', limit: 10 });
    await withPort(port as unknown as ContractClauseReadPort).execute(scope, graphOf('contract-clauses'));
    expect(port.rows).toHaveBeenLastCalledWith(scope, {});
  });

  it('異常: 未配線は落とし、壊れた設定はポートを呼ばずに拒否する', async () => {
    await expect(withPort().execute(scope, graphOf('contract-clauses'))).rejects.toThrow('contract clauses are not available');
    const port = { rows: vi.fn() };
    for (const config of [{ status: 'signed' }, { status: 1 }, { limit: 0 }, { limit: 10_001 }, { limit: 2.5 }]) {
      await expect(withPort(port as unknown as ContractClauseReadPort).execute(scope, graphOf('contract-clauses', config)), JSON.stringify(config)).rejects.toThrow(DataSourceValidationError);
    }
    expect(port.rows).not.toHaveBeenCalled();
  });
});
