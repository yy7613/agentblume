import { describe, expect, it, vi } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { Schema } from '../../domain/data/types';
import type { ToolGraph } from '../../domain/etl/graph';
import { DataSourceValidationError } from './manage-data-sources';
import { ResolveDataSourceGraphUseCase } from './resolve-data-source-graph';
import { DEFAULT_MISSING_ATTACHMENTS_MESSAGE, rowSourceTable, type RowSourceRequirement, type RowSourceResolver } from './row-sources';

/**
 * 行ソースの登録点（ADR-0039）の規律。業務に依らない架空のノード型 `sample-rows` で確かめる
 * （仕訳の具体的な振る舞いは `application/journal/row-sources.test.ts`）。
 */
const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const schema: Schema = { columns: [{ name: 'id', type: 'number', nullable: false }] };
const attachment = { name: 'a.png', dataUrl: 'data:image/png;base64,AAA' };

function source(requirement: RowSourceRequirement, rows: RowSourceResolver['rows'], extra: Partial<RowSourceResolver> = {}): RowSourceResolver {
  return { nodeType: 'sample-rows', schema, requirement, unavailableMessage: 'sample rows are not available', rows, ...extra };
}

function graphOf(config: Record<string, unknown> = {}): ToolGraph {
  return { nodes: [{ id: 's', type: 'sample-rows', config }, { id: 'o', type: 'select', config: { columns: ['id'] } }], edges: [{ from: 's', to: 'o' }] };
}

function resolverWith(...sources: RowSourceResolver[]): ResolveDataSourceGraphUseCase {
  return new ResolveDataSourceGraphUseCase(new InMemoryDataSourceRepository(), undefined, undefined, sources);
}

describe('行ソースの登録点', () => {
  it('正常: 登録したノードだけを固定スキーマ付きの json-source へ書き換え、config をそのまま渡す', async () => {
    const rows = vi.fn().mockResolvedValue([{ id: 1 }]);
    const graph = graphOf({ limit: 3 });
    const resolved = await resolverWith(source('none', rows)).execute(scope, graph);
    expect(resolved.nodes).toEqual([
      { id: 's', type: 'json-source', config: { rows: [{ id: 1 }], schema } },
      { id: 'o', type: 'select', config: { columns: ['id'] } },
    ]);
    expect(rows).toHaveBeenCalledWith({ scope, config: { limit: 3 }, attachments: [], documents: [], arguments: {} });
    // 保存済み定義は書き換えない。
    expect(graph.nodes[0]?.type).toBe('sample-rows');
  });

  it('境界: 0 件でもスキーマを添える（下流が列を見失わない）', async () => {
    const resolved = await resolverWith(source('none', async () => [])).execute(scope, graphOf());
    expect(resolved.nodes[0]?.config).toEqual({ rows: [], schema });
  });

  it('境界: requirement が none なら実行文脈が無くても行を読む', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('none', rows)).execute(scope, graphOf());
    expect(rows).toHaveBeenCalledTimes(1);
  });

  it.each(['context', 'attachments'] as const)('境界: requirement が %s なら文脈の無い呼び出しでは書き換えず、未配線でも落とさない', async (requirement) => {
    const graph = graphOf();
    await expect(resolverWith(source(requirement, vi.fn())).execute(scope, graph)).resolves.toEqual(graph);
    await expect(resolverWith(source(requirement, undefined)).execute(scope, graph)).resolves.toEqual(graph);
  });

  it('境界: requirement が context なら添付が無くても行を読む', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('context', rows)).execute(scope, graphOf(), {});
    expect(rows).toHaveBeenCalledWith({ scope, config: {}, attachments: [], documents: [], arguments: {} });
  });

  it('正常: 添付は実行文脈からそのまま渡る', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('attachments', rows)).execute(scope, graphOf(), { attachments: [attachment, attachment] });
    expect(rows).toHaveBeenCalledWith({ scope, config: {}, attachments: [attachment, attachment], documents: [], arguments: {} });
  });

  it('異常: 未配線は宣言した理由で落とす（空表を返さない）', async () => {
    await expect(resolverWith(source('none', undefined)).execute(scope, graphOf())).rejects.toThrow(new DataSourceValidationError('sample rows are not available'));
    await expect(resolverWith(source('attachments', undefined)).execute(scope, graphOf(), { attachments: [attachment] })).rejects.toThrow('sample rows are not available');
  });

  it('異常: 添付必須で添付が無ければ、宣言した理由（省略時は既定文）で落とし、ポートを呼ばない', async () => {
    const rows = vi.fn();
    await expect(resolverWith(source('attachments', rows, { missingAttachmentsMessage: 'attach the receipt' })).execute(scope, graphOf(), { attachments: [] })).rejects.toThrow('attach the receipt');
    await expect(resolverWith(source('attachments', rows)).execute(scope, graphOf(), {})).rejects.toThrow(DEFAULT_MISSING_ATTACHMENTS_MESSAGE);
    expect(rows).not.toHaveBeenCalled();
  });

  it('例外: ポートの失敗はそのまま伝える（握り潰して空表にしない）', async () => {
    const failure = new Error('model is down');
    await expect(resolverWith(source('none', async () => { throw failure; })).execute(scope, graphOf())).rejects.toBe(failure);
  });

  it('例外: 同じノード型を 2 度登録したら組み立て時に落とす（どちらが効くかを import 順に委ねない）', () => {
    expect(() => rowSourceTable([source('none', undefined), source('context', undefined)])).toThrow('row source is registered twice: sample-rows');
    expect(() => resolverWith(source('none', undefined), source('none', undefined))).toThrow(DataSourceValidationError);
  });

  // テキスト添付（docs/23 §9.4 C4）。画像の規律（attachments）はそのままにし、画像かテキストのどちらかがあればよい要件を足した。
  const document = { name: 'contract.pdf', text: '第1条（目的）', pageCount: 3 };

  it('正常: テキスト添付は実行文脈からそのまま渡る（画像の一覧とは別）', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('context', rows)).execute(scope, graphOf(), { documents: [document] });
    expect(rows).toHaveBeenCalledWith({ scope, config: {}, attachments: [], documents: [document], arguments: {} });
  });

  it.each([
    ['テキストだけ', { documents: [document] }],
    ['画像だけ', { attachments: [attachment] }],
    ['両方', { attachments: [attachment], documents: [document] }],
  ] as const)('正常: attachments-or-documents は %s でも行を読む', async (_label, context) => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('attachments-or-documents', rows)).execute(scope, graphOf(), context);
    expect(rows).toHaveBeenCalledTimes(1);
  });

  it('異常: attachments-or-documents で画像もテキストも無ければ、宣言した理由で落としポートを呼ばない', async () => {
    const rows = vi.fn();
    await expect(resolverWith(source('attachments-or-documents', rows, { missingAttachmentsMessage: 'attach the contract' })).execute(scope, graphOf(), { attachments: [], documents: [] })).rejects.toThrow('attach the contract');
    await expect(resolverWith(source('attachments-or-documents', rows)).execute(scope, graphOf(), {})).rejects.toThrow(DEFAULT_MISSING_ATTACHMENTS_MESSAGE);
    expect(rows).not.toHaveBeenCalled();
  });

  it('境界: attachments（画像必須）はテキスト添付だけでは満たさない（仕訳の帳票読み取りの振る舞いを変えない）', async () => {
    const rows = vi.fn();
    await expect(resolverWith(source('attachments', rows)).execute(scope, graphOf(), { documents: [document] })).rejects.toThrow(DEFAULT_MISSING_ATTACHMENTS_MESSAGE);
    expect(rows).not.toHaveBeenCalled();
  });

  it('境界: attachments-or-documents も文脈の無い呼び出し（保存・点検）では書き換えない', async () => {
    const graph = graphOf();
    await expect(resolverWith(source('attachments-or-documents', vi.fn())).execute(scope, graph)).resolves.toEqual(graph);
  });

  it('境界: 登録が無ければ業務ノードは素通しになる（汎用ソースの解決は従来どおり）', async () => {
    const graph = graphOf();
    await expect(new ResolveDataSourceGraphUseCase(new InMemoryDataSourceRepository()).execute(scope, graph)).resolves.toEqual(graph);
  });
});

describe('行ソースへのツールの引数（G-2）', () => {
  it('正常: 実行文脈の arguments を行ソースへそのまま渡す（ノードの config とは別）', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    const args = { group_by: 'department', period: { from: '2026-09-01', to: '2026-09-30' } };
    await resolverWith(source('context', rows)).execute(scope, graphOf({ limit: 5 }), { arguments: args });
    expect(rows).toHaveBeenCalledWith({ scope, config: { limit: 5 }, attachments: [], documents: [], arguments: args });
  });

  it('境界: 文脈そのものが無い呼び出し・文脈に arguments が無い呼び出しは空のオブジェクトを渡す', async () => {
    const rows = vi.fn().mockResolvedValue([]);
    await resolverWith(source('none', rows)).execute(scope, graphOf());
    await resolverWith(source('attachments', rows)).execute(scope, graphOf(), { attachments: [attachment] });
    expect(rows.mock.calls.map(([input]) => (input as { arguments: unknown }).arguments)).toEqual([{}, {}]);
  });
});
