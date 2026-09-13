import { describe, expect, it } from 'vitest';
import { clearJudgment, createJournalDocument, DOCUMENT_PAYLOAD_MAX_BYTES, markDocumentExported, toJournalDocumentSummary, withHearing, withJudgment, type CreateJournalDocumentProps } from './document';
import { JournalDomainError } from './errors';

const tenant = { tenantId: 'tenant', workspaceId: 'workspace' };
const at = '2026-09-13T00:00:00.000Z';

function props(overrides: Partial<CreateJournalDocumentProps> = {}): CreateJournalDocumentProps {
  return {
    tenant, id: 'doc-1', kind: 'bank_statement',
    source: { type: 'csv-row', fileName: 'bank.csv', row: { 日付: '2026/9/13' }, preset: 'generic' },
    facts: { direction: 'out', transactionDate: '2026-09-13', grandTotal: 1100, description: 'AMAZON', descriptionNorm: 'AMAZON' },
    createdAt: at, updatedAt: at,
    ...overrides,
  };
}

describe('createJournalDocument', () => {
  it('正常: 既定は status extracted・extraction manual。facts / source は検証して複製される', () => {
    const document = createJournalDocument(props());
    expect(document).toEqual({ tenant, id: 'doc-1', kind: 'bank_statement', source: { type: 'csv-row', fileName: 'bank.csv', row: { 日付: '2026/9/13' }, preset: 'generic' }, facts: { direction: 'out', transactionDate: '2026-09-13', grandTotal: 1100, description: 'AMAZON', descriptionNorm: 'AMAZON' }, extraction: { method: 'manual', warnings: [] }, status: 'extracted', createdAt: at, updatedAt: at });
  });

  it('正常: id 省略は makeId、画像 data URL・明細・税率別集計・extra を受ける', () => {
    const document = createJournalDocument(props({
      id: undefined, kind: 'invoice',
      source: { type: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      facts: { issuerName: '山田商事', registrationNumber: 'T1234567890123', issueDate: '2026-09-01', grandTotal: 2180, totalsByRate: [{ rate: 10, taxableAmount: 1100, taxAmount: 100, amountIncludesTax: true }, { rate: 8, taxableAmount: 1080, amountIncludesTax: true }], lines: [{ description: 'ペン', quantity: 2, unitPrice: 550, amount: 1100, taxRate: 10 }], extra: { headcount: 3, purpose: 'meeting', nested: { ok: true } } },
      extraction: { method: 'llm', model: { provider: 'lm-studio', model: 'x' }, confidence: 0.9, warnings: ['w'], fieldEvidence: { grandTotal: { sourceText: '合計 2,180', confidence: 0.95 } } },
    }), () => 'generated');
    expect(document.id).toBe('generated');
    expect(document.facts.extra).toEqual({ headcount: 3, purpose: 'meeting', nested: { ok: true } });
    expect(document.extraction.fieldEvidence?.['grandTotal']).toEqual({ sourceText: '合計 2,180', confidence: 0.95 });
  });

  it('境界: 空の facts でも作れる。decided は entryId 必須', () => {
    expect(createJournalDocument(props({ facts: {} })).facts).toEqual({});
    expect(() => createJournalDocument(props({ status: 'decided' }))).toThrow(new JournalDomainError('createJournalDocument: a decided document must have an entryId'));
    expect(createJournalDocument(props({ status: 'decided', entryId: 'e1' })).entryId).toBe('e1');
  });

  it('異常: 日付の形式・整数でない金額・登録番号の形', () => {
    expect(() => createJournalDocument(props({ facts: { transactionDate: '2026/09/13' } }))).toThrow(/transactionDate must be a date in YYYY-MM-DD/u);
    expect(() => createJournalDocument(props({ facts: { issueDate: '2026-02-30' } }))).toThrow(/issueDate must be a date/u);
    expect(() => createJournalDocument(props({ facts: { grandTotal: 10.5 } }))).toThrow(/grandTotal must be an integer/u);
    expect(() => createJournalDocument(props({ facts: { registrationNumber: 'T-1234567890123' } }))).toThrow(/registrationNumber must be T followed by 13 digits/u);
    expect(() => createJournalDocument(props({ facts: { totalsByRate: [{ rate: 5 as 10, taxableAmount: 1, amountIncludesTax: true }] } }))).toThrow(/totalsByRate\[0\]\.rate must be one of/u);
    expect(() => createJournalDocument(props({ facts: { lines: [{ description: 'x', amount: 1.5 }] } }))).toThrow(/lines\[0\]\.amount must be an integer/u);
  });

  it('異常: dataUrl は image 以外で不可、形式・上限を守る', () => {
    expect(() => createJournalDocument(props({ source: { type: 'text', dataUrl: 'data:image/png;base64,AAAA' } }))).toThrow(/dataUrl is only allowed for type 'image'/u);
    expect(() => createJournalDocument(props({ source: { type: 'image', dataUrl: 'data:application/pdf;base64,AAAA' } }))).toThrow(/dataUrl must be a base64 data URL/u);
    expect(() => createJournalDocument(props({ source: { type: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(DOCUMENT_PAYLOAD_MAX_BYTES)}` } }))).toThrow(/dataUrl must be at most/u);
  });

  it('異常: 列挙値（kind / status / direction / paymentMethod / extraction.method）と confidence の範囲', () => {
    expect(() => createJournalDocument(props({ kind: 'memo' as 'other' }))).toThrow(/kind must be one of/u);
    expect(() => createJournalDocument(props({ status: 'done' as 'decided' }))).toThrow(/status must be one of/u);
    expect(() => createJournalDocument(props({ facts: { direction: 'both' as 'in' } }))).toThrow(/direction must be one of/u);
    expect(() => createJournalDocument(props({ facts: { paymentMethod: 'check' as 'cash' } }))).toThrow(/paymentMethod must be one of/u);
    expect(() => createJournalDocument(props({ extraction: { method: 'ocr' as 'llm', warnings: [] } }))).toThrow(/extraction\.method must be one of/u);
    expect(() => createJournalDocument(props({ extraction: { method: 'llm', confidence: 1.5, warnings: [] } }))).toThrow(/confidence must be between 0 and 1/u);
  });

  it('例外: tenant / id / 時刻が無い', () => {
    expect(() => createJournalDocument(props({ tenant: { tenantId: '', workspaceId: 'w' } }))).toThrow(/tenant\.tenantId must be a non-empty string/u);
    expect(() => createJournalDocument(props({ id: undefined }))).toThrow(/id must be a non-empty string/u);
    expect(() => createJournalDocument(props({ createdAt: 'now' }))).toThrow(/createdAt must be an ISO 8601 date-time string/u);
  });
});

describe('status transitions', () => {
  const later = '2026-09-13T01:00:00.000Z';
  const document = createJournalDocument(props());

  it('正常: withJudgment は decided（entryId あり）/ undecided / skipped に遷移し、前回の entryId を外す', () => {
    const decided = withJudgment(document, { stage: 'decided', ruleId: 'r1', entryId: 'e1', specificity: 3, candidates: [], judgedAt: later }, later);
    expect(decided).toMatchObject({ status: 'decided', entryId: 'e1', updatedAt: later });
    const undecided = withJudgment(decided, { stage: 'undecided', reasons: [{ code: 'no-rule' }], candidates: [], judgedAt: later }, later);
    expect(undecided.status).toBe('undecided');
    expect(undecided.entryId).toBeUndefined();
    expect(withJudgment(document, { stage: 'skipped', reason: 'document-kind', judgedAt: later }, later).status).toBe('skipped');
  });

  it('異常: decided で entryId が無い、exported の再判定', () => {
    expect(() => withJudgment(document, { stage: 'decided', ruleId: 'r1', specificity: 1, candidates: [], judgedAt: later }, later)).toThrow(/judgment\.entryId must be a non-empty string/u);
    const exported = markDocumentExported(withJudgment(document, { stage: 'decided', ruleId: 'r1', entryId: 'e1', specificity: 3, candidates: [], judgedAt: later }, later), later);
    expect(exported.status).toBe('exported');
    expect(() => withJudgment(exported, { stage: 'skipped', reason: 'document-kind', judgedAt: later }, later)).toThrow(/exported document cannot be re-judged/u);
  });

  it('正常 / 異常: withHearing は hearing に遷移。exported / skipped からは不可', () => {
    expect(withHearing(document, 'h1', later)).toMatchObject({ status: 'hearing', hearingId: 'h1' });
    const skipped = withJudgment(document, { stage: 'skipped', reason: 'document-kind', judgedAt: later }, later);
    expect(() => withHearing(skipped, 'h1', later)).toThrow(/skipped document cannot start a hearing/u);
  });

  it('正常 / 異常: markDocumentExported は decided からのみ（exported は冪等）', () => {
    expect(() => markDocumentExported(document, later)).toThrow(/only a decided document can be exported/u);
    const decided = withJudgment(document, { stage: 'decided', ruleId: 'r1', entryId: 'e1', specificity: 3, candidates: [], judgedAt: later }, later);
    const exported = markDocumentExported(decided, later);
    expect(markDocumentExported(exported, later)).toBe(exported);
  });

  it('正常: clearJudgment は判定と仕訳参照を外して extracted に戻す', () => {
    const decided = withJudgment(document, { stage: 'decided', ruleId: 'r1', entryId: 'e1', specificity: 3, candidates: [], judgedAt: later }, later);
    const cleared = clearJudgment(decided, later);
    expect(cleared.status).toBe('extracted');
    expect(cleared.judgment).toBeUndefined();
    expect(cleared.entryId).toBeUndefined();
  });
});

describe('toJournalDocumentSummary', () => {
  it('正常: data URL・原文・CSV 行を含まず、一覧に必要な項目だけを写す', () => {
    const document = createJournalDocument(props({ source: { type: 'image', fileName: 'r.png', dataUrl: 'data:image/png;base64,AAAA' }, facts: { issueDate: '2026-09-01', issuerName: '山田', grandTotal: 1 } }));
    const summary = toJournalDocumentSummary(document);
    expect(summary).toEqual({ id: 'doc-1', kind: 'bank_statement', status: 'extracted', sourceType: 'image', fileName: 'r.png', transactionDate: '2026-09-01', issuerName: '山田', grandTotal: 1, createdAt: at, updatedAt: at });
    expect(JSON.stringify(summary)).not.toContain('base64');
  });

  it('境界: 銀行行は counterpartyHint を issuerName の代わりに出す', () => {
    const document = createJournalDocument(props({ facts: { counterpartyHint: 'ヤマダ', description: '振込 ヤマダ' } }));
    expect(toJournalDocumentSummary(document)).toMatchObject({ issuerName: 'ヤマダ', description: '振込 ヤマダ' });
  });
});
