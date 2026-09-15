import { describe, expect, it, vi } from 'vitest';
import { InMemoryDataSourceRepository } from '../../adapters/storage/in-memory-data-source-repository';
import type { ToolGraph } from '../../domain/etl/graph';
import { JOURNAL_ATTACHMENT_SCHEMA } from '../../domain/etl/nodes/journal-attachment';
import { JOURNAL_DRAFT_ENTRY_SCHEMA } from '../../domain/etl/nodes/journal-draft-entry';
import { JOURNAL_ENTRIES_SCHEMA } from '../../domain/etl/nodes/journal-entries-source';
import { ResolveDataSourceGraphUseCase } from '../data-source/resolve-data-source-graph';
import { journalRowSources, type JournalAttachmentReadPort, type JournalDraftEntryReadPort, type JournalEntryReadPort, type JournalRowSourcePorts } from './row-sources';

/**
 * 仕訳ノードの解決（以前は resolve-data-source-graph.test.ts にあったケースを、登録点へ移したもの。期待値は同じ）。
 */
const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function resolverWith(ports: JournalRowSourcePorts = {}): ResolveDataSourceGraphUseCase {
  return new ResolveDataSourceGraphUseCase(new InMemoryDataSourceRepository(), undefined, undefined, journalRowSources(ports));
}

describe('仕訳の行ソース: journal-draft-entry', () => {
  const graph: ToolGraph = { nodes: [{ id: 'draft', type: 'journal-draft-entry', config: {} }], edges: [] };
  const attachment = { name: 'receipt.png', dataUrl: 'data:image/png;base64,AAA' };
  const rows = [{ file_name: 'receipt.png', decided: true }];

  // vi.fn() の型は呼び出し署名を持たないので、ポートとしては明示的に見なす（呼び出し検証は mock のまま行う）。
  const draftEntries = (port?: { rows: ReturnType<typeof vi.fn> }) => resolverWith(port === undefined ? {} : { draftEntries: port as unknown as JournalDraftEntryReadPort });

  it('正常: 添付をポートへ渡し、固定スキーマ付きの json-source へ書き換える', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    const resolved = await draftEntries(port).execute(scope, graph, { attachments: [attachment] });
    expect(resolved.nodes[0]).toEqual({ id: 'draft', type: 'json-source', config: { rows, schema: JOURNAL_DRAFT_ENTRY_SCHEMA } });
    expect(port.rows).toHaveBeenCalledWith(scope, [attachment], undefined);
  });

  it('境界: limit はポートへそのまま渡す', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    await draftEntries(port).execute(scope, { nodes: [{ id: 'd', type: 'journal-draft-entry', config: { limit: 1 } }], edges: [] }, { attachments: [attachment] });
    expect(port.rows).toHaveBeenCalledWith(scope, [attachment], { limit: 1 });
  });

  it('境界: 実行文脈が無い呼び出し（保存・スキーマ点検）では書き換えず、そのまま返す', async () => {
    const port = { rows: vi.fn() };
    await expect(draftEntries(port).execute(scope, graph)).resolves.toEqual(graph);
    expect(port.rows).not.toHaveBeenCalled();
  });

  it('異常: ポート未配線・添付なしは、それぞれの理由で落とす', async () => {
    await expect(draftEntries().execute(scope, graph, { attachments: [attachment] })).rejects.toThrow('journal draft entry is not available');
    await expect(draftEntries({ rows: vi.fn() }).execute(scope, graph, { attachments: [] })).rejects.toThrow('no document is attached');
  });

  it('例外: limit が整数でない設定は読み取りを投げる前に落とす', async () => {
    const port = { rows: vi.fn() };
    await expect(draftEntries(port).execute(scope, { nodes: [{ id: 'd', type: 'journal-draft-entry', config: { limit: 1.5 } }], edges: [] }, { attachments: [attachment] }))
      .rejects.toThrow('journal draft entry source has invalid settings');
    expect(port.rows).not.toHaveBeenCalled();
  });
});

describe('仕訳の行ソース: journal-attachment', () => {
  const graph: ToolGraph = { nodes: [{ id: 'attachment', type: 'journal-attachment', config: {} }], edges: [] };
  const attachment = { name: 'receipt.png', dataUrl: 'data:image/png;base64,AAA' };
  const rows = [{ file_name: 'receipt.png', kind: 'receipt' }];
  const withPort = (port: { rows: ReturnType<typeof vi.fn> }) => resolverWith({ attachments: port as unknown as JournalAttachmentReadPort });

  it('正常: 実行文脈の添付をポートへ渡し、固定スキーマ付きの json-source へ書き換える', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    const resolved = await withPort(port).execute(scope, graph, { attachments: [attachment] });
    // 0 件でも列が消えないよう、スキーマを明示して渡す。
    expect(resolved.nodes[0]).toEqual({ id: 'attachment', type: 'json-source', config: { rows, schema: JOURNAL_ATTACHMENT_SCHEMA } });
    expect(port.rows).toHaveBeenCalledWith(scope, [attachment], undefined);
    // 元のグラフは書き換えない（保存済み定義は不変）。
    expect(graph.nodes[0]?.type).toBe('journal-attachment');
  });

  it('境界: limit はポートへそのまま渡す', async () => {
    const port = { rows: vi.fn().mockResolvedValue(rows) };
    await withPort(port).execute(scope, { nodes: [{ id: 'a', type: 'journal-attachment', config: { limit: 1 } }], edges: [] }, { attachments: [attachment, attachment] });
    expect(port.rows).toHaveBeenCalledWith(scope, [attachment, attachment], { limit: 1 });
  });

  it('異常: ポートが配線されていなければ実行させない（空表を返すと「何も書いていない」と読める）', async () => {
    await expect(resolverWith().execute(scope, graph, { attachments: [attachment] })).rejects.toThrow('journal attachment reading is not available');
  });

  it('異常: 実行中に添付が無ければ、利用者が直せる形の理由で落とす', async () => {
    const port = { rows: vi.fn() };
    await expect(withPort(port).execute(scope, graph, { attachments: [] })).rejects.toThrow('no document is attached to this message; attach the receipt or invoice image and ask again');
    expect(port.rows).not.toHaveBeenCalled();
  });

  it('境界: 実行文脈が無い呼び出し（保存・スキーマ点検）では書き換えず、そのまま返す', async () => {
    // ここで落とすと、このノードを使う組込みツールの登録が起動時に失敗する。
    const port = { rows: vi.fn() };
    await expect(withPort(port).execute(scope, graph)).resolves.toEqual(graph);
    expect(port.rows).not.toHaveBeenCalled();
  });

  it('例外: limit が整数でない設定は読み取りを投げる前に落とす', async () => {
    const port = { rows: vi.fn() };
    await expect(withPort(port).execute(scope, { nodes: [{ id: 'a', type: 'journal-attachment', config: { limit: 1.5 } }], edges: [] }, { attachments: [attachment] }))
      .rejects.toThrow('journal attachment source has invalid settings');
    expect(port.rows).not.toHaveBeenCalled();
  });
});

describe('仕訳の行ソース: journal-entries', () => {
  it('仕訳sourceは実行直前にportの行へ差し替え、固定スキーマ付きのjson-sourceとして渡す', async () => {
    const calls: unknown[] = [];
    const rows = [{ entry_id: 'e1', line_no: 1, date: '2026-09-10', debit_account: '消耗品費', debit_tax_code: 'JP-IN-10-S', debit_amount: 1100, credit_account: '現金', credit_tax_code: 'JP-NA', credit_amount: 1100, description: 'テスト', invoice_status: 'qualified', status: 'confirmed', document_id: null, rule_id: null }];
    const port: JournalEntryReadPort = { rows: async (givenScope, options) => { calls.push({ givenScope, options }); return rows; } };
    const graph: ToolGraph = { nodes: [{ id: 'journal', type: 'journal-entries', config: { status: 'confirmed', from: '2026-09-01', to: '2026-09-30', limit: 50 } }], edges: [] };

    await expect(resolverWith({ entries: port }).execute(scope, graph)).resolves.toEqual({ nodes: [{ id: 'journal', type: 'json-source', config: { rows, schema: JOURNAL_ENTRIES_SCHEMA } }], edges: [] });
    // 絞り込みはそのままポートへ渡り、元のグラフは書き換えない。
    expect(calls).toEqual([{ givenScope: scope, options: { status: 'confirmed', from: '2026-09-01', to: '2026-09-30', limit: 50 } }]);
    expect(graph.nodes[0]?.type).toBe('journal-entries');
  });

  it('仕訳sourceは0件でも列が消えないよう固定スキーマを添える（下流のfilterが列を見失わない）', async () => {
    const resolved = await resolverWith({ entries: { rows: async () => [] } }).execute(scope, { nodes: [{ id: 'journal', type: 'journal-entries', config: {} }], edges: [] });
    expect(resolved.nodes[0]?.config).toEqual({ rows: [], schema: JOURNAL_ENTRIES_SCHEMA });
  });

  it('仕訳portが未配線ならfail closed（空表を「仕訳0件」と読ませない）', async () => {
    await expect(resolverWith().execute(scope, { nodes: [{ id: 'journal', type: 'journal-entries', config: {} }], edges: [] }))
      .rejects.toThrow('journal entries are not available');
  });

  it('仕訳sourceの設定が壊れていればportを呼ばずに拒否する', async () => {
    let called = 0;
    const port: JournalEntryReadPort = { rows: async () => { called += 1; return []; } };
    for (const config of [{ status: 'posted' }, { from: 20260101 }, { to: {} }, { limit: 1.5 }]) {
      await expect(resolverWith({ entries: port }).execute(scope, { nodes: [{ id: 'journal', type: 'journal-entries', config }], edges: [] }))
        .rejects.toThrow('journal entries source has invalid settings');
    }
    expect(called).toBe(0);
  });
});
