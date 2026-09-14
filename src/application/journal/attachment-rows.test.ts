import { describe, expect, it, vi } from 'vitest';
import { JOURNAL_ATTACHMENT_SCHEMA } from '../../domain/etl/nodes/journal-attachment';
import type { DocumentFacts } from '../../domain/journal/document';
import type { ExtractJournalDocumentUseCase } from './extract-document';
import { JournalAttachmentRowsProvider, journalAttachmentRow } from './attachment-rows';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };
const TODAY = '2026-09-14';

const facts: DocumentFacts = {
  direction: 'out',
  issuerName: 'サンプルカフェ',
  registrationNumber: 'T1234567890123',
  issueDate: '2026-09-01',
  transactionDate: '2026-09-01',
  grandTotal: 2180,
  totalsByRate: [
    { rate: 10, taxableAmount: 1100, taxAmount: 100, amountIncludesTax: true },
    { rate: 8, taxableAmount: 1080, taxAmount: 80, amountIncludesTax: true },
  ],
  description: 'コーヒーと菓子',
};

function stubExtract(result: unknown, calls: unknown[] = []): ExtractJournalDocumentUseCase {
  return { execute: vi.fn().mockImplementation((input: unknown) => { calls.push(input); return Promise.resolve(result); }) } as unknown as ExtractJournalDocumentUseCase;
}

describe('journalAttachmentRow', () => {
  it('正常: 事実を固定列へ平坦化し、税率別は 10% / 8% の 4 列へ展開する', () => {
    const row = journalAttachmentRow('receipt.png', 'receipt', facts, { confidence: 0.9, warnings: [] }, TODAY);
    expect(row['file_name']).toBe('receipt.png');
    expect(row['kind']).toBe('receipt');
    expect(row['issuer_name']).toBe('サンプルカフェ');
    expect(row['grand_total']).toBe(2180);
    expect(row['tax_10_taxable']).toBe(1100);
    expect(row['tax_10_tax']).toBe(100);
    expect(row['tax_8_taxable']).toBe(1080);
    expect(row['tax_8_tax']).toBe(80);
    expect(row['confidence']).toBe(0.9);
  });

  it('正常: 列は固定スキーマと過不足なく一致する', () => {
    const row = journalAttachmentRow('a.png', 'receipt', facts, { warnings: [] }, TODAY);
    expect(Object.keys(row).sort()).toEqual(JOURNAL_ATTACHMENT_SCHEMA.columns.map((column) => column.name).sort());
  });

  it('正常: 登録番号があれば適格、無ければ取引日の経過措置で決める', () => {
    expect(journalAttachmentRow('a.png', 'receipt', facts, { warnings: [] }, TODAY)['invoice_status']).toBe('qualified');
    const { registrationNumber: _omit, ...withoutNumber } = facts;
    expect(journalAttachmentRow('a.png', 'receipt', withoutNumber, { warnings: [] }, TODAY)['invoice_status']).toBe('transitional');
  });

  it('境界: 読めなかった項目は null、警告が無ければ空文字になる', () => {
    const row = journalAttachmentRow('blurry.png', 'unknown', {}, { warnings: [] }, TODAY);
    expect(row['issuer_name']).toBeNull();
    expect(row['grand_total']).toBeNull();
    expect(row['tax_10_taxable']).toBeNull();
    expect(row['confidence']).toBeNull();
    // 空文字にするのは、null だと「警告が読めなかった」と紛れるため。
    expect(row['warnings']).toBe('');
  });

  it('境界: 税額の無い税率別内訳は対象額だけ入り、税額は null になる', () => {
    const row = journalAttachmentRow('a.png', 'receipt', { totalsByRate: [{ rate: 8, taxableAmount: 540, amountIncludesTax: true }] }, { warnings: [] }, TODAY);
    expect(row['tax_8_taxable']).toBe(540);
    expect(row['tax_8_tax']).toBeNull();
    expect(row['tax_10_taxable']).toBeNull();
  });

  it('例外: 平坦な列に収まらない細部は facts_json に残す', () => {
    const withLines: DocumentFacts = { ...facts, lines: [{ description: 'コーヒー', amount: 550, taxRate: 10 }] };
    const row = journalAttachmentRow('a.png', 'receipt', withLines, { warnings: ['税率別合計が合いません'] }, TODAY);
    expect(row['warnings']).toBe('税率別合計が合いません');
    expect(JSON.parse(String(row['facts_json'])).lines).toHaveLength(1);
  });
});

describe('JournalAttachmentRowsProvider', () => {
  it('正常: 添付 1 枚ずつ読み取り、1 行ずつ返す', async () => {
    const calls: unknown[] = [];
    const provider = new JournalAttachmentRowsProvider(stubExtract({ kind: 'receipt', facts, extraction: { warnings: [] } }, calls), () => new Date(`${TODAY}T00:00:00.000Z`));
    const rows = await provider.rows(scope, [
      { name: 'a.png', dataUrl: 'data:image/png;base64,AAA' },
      { name: 'b.png', dataUrl: 'data:image/png;base64,BBB' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.['file_name']).toBe('a.png');
    // 別々の帳票なので 1 回にまとめない（まとめると読み取りが混ざる）。
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ images: ['data:image/png;base64,AAA'], fileName: 'a.png' });
  });

  it('境界: limit を超える添付は読まない（読み取りは高価なので投げる前に切る）', async () => {
    const calls: unknown[] = [];
    const provider = new JournalAttachmentRowsProvider(stubExtract({ kind: 'receipt', facts, extraction: { warnings: [] } }, calls));
    const rows = await provider.rows(scope, [
      { name: 'a.png', dataUrl: 'data:image/png;base64,AAA' },
      { name: 'b.png', dataUrl: 'data:image/png;base64,BBB' },
    ], { limit: 1 });
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('境界: 添付が無ければ読み取りを呼ばず、空の行を返す', async () => {
    const calls: unknown[] = [];
    const provider = new JournalAttachmentRowsProvider(stubExtract({ kind: 'receipt', facts, extraction: { warnings: [] } }, calls));
    expect(await provider.rows(scope, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('例外: 1 枚でも読み取りに失敗したら投げる（読めた分だけ黙って返さない）', async () => {
    const extract = { execute: vi.fn().mockRejectedValue(new Error('vision model is not available')) } as unknown as ExtractJournalDocumentUseCase;
    const provider = new JournalAttachmentRowsProvider(extract);
    await expect(provider.rows(scope, [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAA' }]))
      .rejects.toThrow('vision model is not available');
  });
});
