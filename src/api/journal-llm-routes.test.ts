/**
 * /journal の LLM ルート（抽出とヒアリング）のテスト。
 *
 * `createApp({profile:'test'})` は仕訳の LLM 機能を**わざと無効**にしている（缶詰モデルの能力を見に行かない）。
 * ここではその配線のうち LLM を使う 7 つのユースケースだけを、缶詰モデルと有効な機能フラグで差し替える。
 * リポジトリ・認可・直列化・エラー写像は本物のまま通すので、**UI が期待する形**（パス・包み・状態コード）が守られる。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { ExtractJournalDocumentUseCase } from '../application/journal/extract-document';
import {
  AcceptJournalHearingUseCase, AnswerJournalHearingUseCase, CancelJournalHearingUseCase,
  GetJournalHearingUseCase, ListJournalHearingsUseCase, StartJournalHearingUseCase,
} from '../application/journal/hearing';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function completion(content: unknown) {
  return { message: { role: 'assistant' as const, content: typeof content === 'string' ? content : JSON.stringify(content) }, finishReason: 'stop' as const };
}

function extraction(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'simplified_invoice',
    facts: {
      direction: 'out', issuerName: 'カフェ サンプル 霞が関店', recipientName: null, registrationNumber: 'T1234567890123',
      issueDate: '2026-09-10', transactionDate: '2026-09-10', dueDate: null, grandTotal: 1100,
      totalsByRate: null, lines: null, paymentMethod: 'cash', description: 'カフェ サンプル', extra: null,
    },
    fieldEvidence: { grandTotal: { sourceText: '合計 1,100', confidence: 0.8 } },
    warnings: null,
    ...overrides,
  };
}

const QUESTION = {
  id: 'meal_purpose', text: '誰と・何の目的の飲食でしたか？', kind: 'single',
  options: [{ value: 'internal-meeting', label: '社内打合せ', hint: null }],
  factPath: 'extra.purpose', catalogId: 'meal_purpose', note: null,
};

const PROPOSAL = {
  questions: null,
  proposal: {
    rule: {
      name: 'カフェは会議費', enabled: true, mode: 'auto', priority: 100, scope: { direction: 'out' },
      conditions: [{ field: 'descriptionNorm', op: 'contains', value: 'カフェ' }],
      outcome: { lines: [
        { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 'total' },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 'total' },
      ] },
      askIf: [], requiredFacts: [],
    },
    entry: {
      date: '2026-09-10',
      lines: [
        { side: 'debit', accountId: 'expense.meetings', taxCode: 'JP-IN-10-S', amount: 1100 },
        { side: 'credit', accountId: 'asset.cash', taxCode: 'JP-NA', amount: 1100 },
      ],
      description: 'カフェ サンプル 打合せ', invoiceStatus: 'qualified',
    },
    newAccounts: [], newDimensionValues: [], newTaxCategories: [],
    rationale: '社内打合せの飲食は会議費。',
  },
};

describe('journal LLM routes（抽出・ヒアリング）', () => {
  let app: App;
  let server: FastifyInstance;
  let model: ScriptedModelProvider;

  /** 缶詰モデルで LLM ユースケースだけを差し替える（リポジトリは app のものをそのまま使う）。 */
  function wire(enabled = true): void {
    const gate = (): boolean => enabled;
    Object.assign(app, {
      extractJournalDocument: new ExtractJournalDocumentUseCase(model, gate),
      startJournalHearing: new StartJournalHearingUseCase(app.journalDocumentRepo, app.journalHearingRepo, app.journalChartRepo, model, gate),
      answerJournalHearing: new AnswerJournalHearingUseCase(app.journalDocumentRepo, app.journalHearingRepo, app.journalChartRepo, model, gate),
      acceptJournalHearing: new AcceptJournalHearingUseCase(app.journalDocumentRepo, app.journalHearingRepo, app.journalChartRepo, app.journalRuleRepo, app.journalEntryRepo, app.judgeJournalDocuments),
      cancelJournalHearing: new CancelJournalHearingUseCase(app.journalDocumentRepo, app.journalHearingRepo),
      getJournalHearing: new GetJournalHearingUseCase(app.journalHearingRepo),
      listJournalHearings: new ListJournalHearingsUseCase(app.journalHearingRepo),
    });
  }

  /** 未判定の文書を 1 件作る（ヒアリングは undecided の文書からしか始められない）。 */
  async function undecidedDocument(): Promise<string> {
    const created = await server.inject({
      method: 'POST', url: '/journal/documents',
      payload: { scope: SCOPE, kind: 'simplified_invoice', source: { type: 'structured' }, facts: { direction: 'out', description: 'カフェ サンプル', transactionDate: '2026-09-10', grandTotal: 1100 } },
    });
    const id = created.json().document.id as string;
    await server.inject({ method: 'POST', url: '/journal/documents/judge', payload: { scope: SCOPE, documentIds: [id] } });
    return id;
  }

  beforeEach(() => {
    app = createApp({ profile: 'test' });
    model = new ScriptedModelProvider();
    wire();
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
  });

  afterEach(async () => {
    await server.close();
    app.close();
  });

  describe('POST /journal/documents/extract', () => {
    it('正常: 200 { result } を返し、保存はしない（文書一覧は増えない）', async () => {
      model.enqueue(completion(extraction()));
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, images: [PNG], fileName: 'receipt.png' } });

      expect(res.statusCode).toBe(200);
      const { result } = res.json();
      expect(result.kind).toBe('simplified_invoice');
      expect(result.facts).toMatchObject({ grandTotal: 1100, registrationNumber: 'T1234567890123', descriptionNorm: 'カフェ サンプル' });
      expect(result.extraction).toMatchObject({ method: 'llm', confidence: 0.8 });
      expect((await server.inject({ method: 'GET', url: `/journal/documents?${scopeQuery}` })).json().documents).toEqual([]);
    });

    it('正常: テキストだけでも抽出できる', async () => {
      model.enqueue(completion(extraction({ kind: 'other' })));
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, text: 'カフェ サンプル 1,100 円' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.kind).toBe('other');
    });

    it('異常: data URL でない画像・画像 5 枚は 400（本文の検証で入口で断つ）', async () => {
      const external = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, images: ['https://example.com/a.png'] } });
      expect(external.statusCode).toBe(400);
      expect(external.json().error.code).toBe('BAD_REQUEST');

      const tooMany = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, images: [PNG, PNG, PNG, PNG, PNG] } });
      expect(tooMany.statusCode).toBe(400);
    });

    it('境界: 画像ちょうど 4 枚（上限）は通る', async () => {
      model.enqueue(completion(extraction()));
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, images: [PNG, PNG, PNG, PNG] } });
      expect(res.statusCode).toBe(200);
    });

    it('異常: 画像もテキストも無ければ 400 JOURNAL_DOMAIN', async () => {
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('JOURNAL_DOMAIN');
    });

    it('異常: モデルが未設定なら 409 JOURNAL_EXTRACTION_UNAVAILABLE（設定画面への導線を message に持つ）', async () => {
      wire(false);
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, text: 'x' } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('JOURNAL_EXTRACTION_UNAVAILABLE');
      expect(res.json().error.message).toContain('Settings');
    });

    it('例外: 応答が修復後も壊れていれば 502 JOURNAL_EXTRACTION_SCHEMA', async () => {
      model.enqueue(completion('壊れた'), completion('やはり壊れた'));
      const res = await server.inject({ method: 'POST', url: '/journal/documents/extract', payload: { scope: SCOPE, text: 'x' } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('JOURNAL_EXTRACTION_SCHEMA');
    });
  });

  describe('ヒアリング（Stage 2）', () => {
    it('正常: 開始 → 取得 → 一覧 → 回答 → 受け入れ が UI の期待する包みで通る', async () => {
      const documentId = await undecidedDocument();
      model.enqueue(completion({ questions: [QUESTION] }), completion(PROPOSAL));

      const started = await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } });
      expect(started.statusCode).toBe(200);
      const { hearing } = started.json();
      expect(hearing).toMatchObject({ documentId, status: 'open' });
      expect(hearing.tenant).toBeUndefined(); // scope は返さない
      expect(hearing.turns[0].question.id).toBe('meal_purpose');

      const fetched = await server.inject({ method: 'GET', url: `/journal/hearings/${hearing.id}?${scopeQuery}` });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().hearing.id).toBe(hearing.id);

      const listed = await server.inject({ method: 'GET', url: `/journal/hearings?${scopeQuery}&documentId=${documentId}` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().hearings).toHaveLength(1);

      const answered = await server.inject({ method: 'POST', url: `/journal/hearings/${hearing.id}/answers`, payload: { scope: SCOPE, answers: [{ questionId: 'meal_purpose', value: 'internal-meeting' }] } });
      expect(answered.statusCode).toBe(200);
      expect(answered.json().hearing.status).toBe('proposed');
      expect(answered.json().warnings).toEqual([]);

      const accepted = await server.inject({ method: 'POST', url: `/journal/hearings/${hearing.id}/accept`, payload: { scope: SCOPE } });
      expect(accepted.statusCode).toBe(200);
      const body = accepted.json();
      expect(body.hearing.status).toBe('accepted');
      expect(body.rule).toMatchObject({ name: 'カフェは会議費', provenance: { origin: 'hearing', exampleDocumentIds: [documentId] } });
      expect(body.entry).toMatchObject({ documentId, status: 'draft', decidedBy: 'rule' });
      expect(body.chart.accounts.length).toBeGreaterThan(50);
      expect(body.rule.tenant).toBeUndefined();

      const document = await server.inject({ method: 'GET', url: `/journal/documents/${documentId}?${scopeQuery}` });
      expect(document.json().document.status).toBe('decided');
    });

    it('正常: 中止すると 200 { hearing } を返し、文書は未判定へ戻る', async () => {
      const documentId = await undecidedDocument();
      model.enqueue(completion({ questions: [QUESTION] }));
      const hearingId = (await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } })).json().hearing.id as string;

      const cancelled = await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/cancel`, payload: { scope: SCOPE } });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().hearing.status).toBe('cancelled');
      expect((await server.inject({ method: 'GET', url: `/journal/documents/${documentId}?${scopeQuery}` })).json().document.status).toBe('undecided');
    });

    it('異常: 本文が足りなければ 400、聞いていない questionId も 400 JOURNAL_DOMAIN', async () => {
      const documentId = await undecidedDocument();
      expect((await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE } })).statusCode).toBe(400);

      model.enqueue(completion({ questions: [QUESTION] }));
      const hearingId = (await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } })).json().hearing.id as string;

      const empty = await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/answers`, payload: { scope: SCOPE, answers: [] } });
      expect(empty.statusCode).toBe(400);

      const unknown = await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/answers`, payload: { scope: SCOPE, answers: [{ questionId: 'nope', value: 'x' }] } });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json().error).toMatchObject({ code: 'JOURNAL_DOMAIN' });
    });

    it('異常: 無い文書は 404 JOURNAL_DOCUMENT_NOT_FOUND、無いヒアリングは 404 JOURNAL_HEARING_NOT_FOUND', async () => {
      const missingDocument = await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId: 'nope' } });
      expect(missingDocument.statusCode).toBe(404);
      expect(missingDocument.json().error.code).toBe('JOURNAL_DOCUMENT_NOT_FOUND');

      for (const url of ['/journal/hearings/nope', '/journal/hearings/nope/accept', '/journal/hearings/nope/cancel']) {
        const method = url.endsWith('/nope') ? 'GET' : 'POST';
        const res = await server.inject(method === 'GET' ? { method, url: `${url}?${scopeQuery}` } : { method, url, payload: { scope: SCOPE } });
        expect(res.statusCode, url).toBe(404);
        expect(res.json().error.code, url).toBe('JOURNAL_HEARING_NOT_FOUND');
      }
    });

    it('異常: 確定済みの文書からは始められない（400 JOURNAL_DOMAIN。状態を message に持つ）', async () => {
      const documentId = await undecidedDocument();
      model.enqueue(completion({ questions: [QUESTION] }), completion(PROPOSAL));
      const hearingId = (await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } })).json().hearing.id as string;
      await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/answers`, payload: { scope: SCOPE, answers: [{ questionId: 'meal_purpose', value: 'internal-meeting' }] } });
      await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/accept`, payload: { scope: SCOPE } });

      const again = await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } });
      expect(again.statusCode).toBe(400);
      expect(again.json().error.message).toContain('decided');
    });

    it('異常: 提案に無い id を登録しようとすると 400（モデルが科目体系を勝手に増やせない）', async () => {
      const documentId = await undecidedDocument();
      model.enqueue(completion({ questions: [QUESTION] }), completion(PROPOSAL));
      const hearingId = (await server.inject({ method: 'POST', url: '/journal/hearings', payload: { scope: SCOPE, documentId } })).json().hearing.id as string;
      await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/answers`, payload: { scope: SCOPE, answers: [{ questionId: 'meal_purpose', value: 'internal-meeting' }] } });

      const res = await server.inject({ method: 'POST', url: `/journal/hearings/${hearingId}/accept`, payload: { scope: SCOPE, registerAccountIds: ['expense.whatever'] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('JOURNAL_DOMAIN');
    });
  });
});
