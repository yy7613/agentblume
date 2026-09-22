/**
 * /contracts の LLM ルート（抽出・文字起こし・LLM 基準つきレビュー）のテスト。
 *
 * test プロファイルは LLM を無効にしているので、LLM を使うユースケースだけを缶詰モデルと有効なゲートで差し替える
 * （リポジトリ・認可・直列化・エラー写像は本物のまま通す）。仕訳の journal-llm-routes.test.ts と同じ形。
 */
import type { FastifyInstance } from 'fastify';
import { bundledPrompts } from '../test-support/prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { ContractClauseExtractor, ExtractContractClausesUseCase } from '../application/contract/extract-clauses';
import { ContractCriteriaAnswerer } from '../application/contract/llm-criteria';
import { ContractPlaybookResolver } from '../application/contract/manage-playbooks';
import { RunContractReviewUseCase } from '../application/contract/run-review';
import { ContractModelGate } from '../application/contract/support';
import { TranscribeContractPagesUseCase } from '../application/contract/transcribe-pages';
import { FLAT_VALUE_KEYS } from '../domain/contract/clause-value';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const BODY = [
  '株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は、次のとおり契約を締結する。',
  '第1条（目的）',
  '甲は、乙に対し、社内システムの保守業務を委託する。',
  '第2条（契約期間）',
  '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。',
  '第3条（損害賠償）',
  '乙が本契約に違反して甲に損害を与えたときは、乙は甲に対し、当該損害を賠償する。',
].join('\n');

function completion(content: unknown) {
  return { message: { role: 'assistant' as const, content: typeof content === 'string' ? content : JSON.stringify(content) }, finishReason: 'stop' as const };
}

function value(overrides: Record<string, unknown>) {
  return { ...Object.fromEntries(FLAT_VALUE_KEYS.map((key) => [key, null])), ...overrides };
}

function extraction(findings: readonly Record<string, unknown>[]) {
  return {
    parties: { A: { label: '甲', name: '株式会社サンプル商事' }, B: { label: '乙', name: '架空テック合同会社' } },
    contractNature: { value: 'jun_inin', quote: null }, signingDateText: null,
    findings: findings.map((finding) => ({ confidence: 0.9, note: null, ...finding })),
    warnings: [],
  };
}

const TERM = { topicId: 'term', articleRef: '第2条', quote: '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。', value: value({ term_start: '2026-04-01', term_end: '2027-03-31', term_months: 12 }) };
const CAP = { topicId: 'liability_cap', articleRef: '第3条', quote: '乙は甲に対し、当該損害を賠償する。', value: value({ cap_kind: 'none' }) };

describe('contract LLM routes', () => {
  let app: App;
  let server: FastifyInstance;
  let model: ScriptedModelProvider;

  function wire(enabled = true): void {
    const gate = new ContractModelGate(model, () => enabled);
    const resolver = new ContractPlaybookResolver(app.contractPlaybookRepo);
    Object.assign(app, {
      contractExtractClauses: new ExtractContractClausesUseCase(app.contractDocumentRepo, app.contractReviewRepo, resolver, new ContractClauseExtractor(gate, bundledPrompts()), app.unitOfWork),
      contractTranscribePages: new TranscribeContractPagesUseCase(gate, bundledPrompts()),
      contractRunReview: new RunContractReviewUseCase(app.contractDocumentRepo, app.contractReviewRepo, resolver, new ContractCriteriaAnswerer(gate, bundledPrompts()), app.unitOfWork),
    });
  }

  async function importDocument(): Promise<string> {
    await server.inject({ method: 'POST', url: '/contracts/playbooks/from-template', payload: { scope: SCOPE, templateId: 'outsourcing-client', ourCompanyNames: ['サンプル商事'] } });
    const res = await server.inject({ method: 'POST', url: '/contracts/documents', payload: { scope: SCOPE, title: '保守', body: BODY, source: { type: 'text' } } });
    return res.json().document.id as string;
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

  describe('POST /contracts/documents/:id/extract', () => {
    it('正常: 抽出結果を文書へ保存し、引用は本文の位置つきで照合済みになる。キーワードに当たらない条文は未スキャン', async () => {
      const id = await importDocument();
      model.enqueue(completion(extraction([TERM, CAP])));
      const res = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/extract`, payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(200);
      const document = res.json().document;
      expect(document.status).toBe('extracted');
      const term = document.clauses.find((clause: { topicId: string }) => clause.topicId === 'term');
      expect(term).toMatchObject({ present: true, articleRef: '第2条', value: { kind: 'term', startDate: '2026-04-01', durationMonths: 12 } });
      expect(term.evidence[0]).toMatchObject({ verified: true, start: BODY.indexOf('本契約の有効期間') });
      expect(document.extraction.unscannedArticleRefs).toEqual(['第1条']);
      expect(document.ourParty).toBe('A');
      // 本文は命令の形をしていても引用データとして囲って渡す。
      expect(JSON.stringify(model.requests[0]?.messages)).toContain('<untrusted-contract-text>');
    });

    it('異常: 全部の束が修復後もスキーマに合わなければ 502 で、文書は取込直後のまま', async () => {
      const id = await importDocument();
      model.enqueue(completion('not json'), completion('still not json'));
      const res = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/extract`, payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('CONTRACT_EXTRACTION_SCHEMA');
      expect((await app.contractDocumentRepo.findById(SCOPE, id))?.status).toBe('imported');
    });

    it('異常: モデル未設定は 409', async () => {
      wire(false);
      server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
      const id = await importDocument();
      expect((await server.inject({ method: 'POST', url: `/contracts/documents/${id}/extract`, payload: { scope: SCOPE } })).statusCode).toBe(409);
    });
  });

  describe('POST /contracts/documents/transcribe', () => {
    it('正常: ページ画像を文字起こしし、保存はしない', async () => {
      model.enqueue(completion('第1条（目的）\n甲は〓〓に委託する。'));
      const res = await server.inject({ method: 'POST', url: '/contracts/documents/transcribe', payload: { scope: SCOPE, images: ['data:image/png;base64,AAA='], fileName: 'p1.png' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().result.pages[0]).toMatchObject({ index: 0, text: '第1条（目的）\n甲は〓〓に委託する。', warnings: [expect.stringContaining('2 文字')] });
      expect(await app.contractDocumentRepo.list(SCOPE)).toEqual([]);
    });

    it('異常: data URL でない画像は 400 CONTRACT_DOMAIN', async () => {
      const res = await server.inject({ method: 'POST', url: '/contracts/documents/transcribe', payload: { scope: SCOPE, images: ['https://example.com/a.png'] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('CONTRACT_DOMAIN');
    });
  });

  describe('POST /contracts/documents/:id/reviews（LLM 基準）', () => {
    it('正常: はい/いいえ の回答を判定に使い、同じ条文と質問なら再レビューで回答を再利用する（モデルを呼ばない）', async () => {
      const id = await importDocument();
      model.enqueue(completion(extraction([TERM, CAP])));
      await server.inject({ method: 'POST', url: `/contracts/documents/${id}/extract`, payload: { scope: SCOPE } });
      const document = (await app.contractDocumentRepo.findById(SCOPE, id))!;
      await server.inject({ method: 'PUT', url: `/contracts/documents/${id}/clauses`, payload: { scope: SCOPE, clauses: document.clauses } });

      model.enqueue(completion({ answers: [{ criterionId: 'liability-cap', answer: 'no', evidenceQuote: '当該損害を賠償する', reasoning: '上限の定めが無い' }] }));
      const first = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/reviews`, payload: { scope: SCOPE } });
      const cap = first.json().review.results.find((result: { topicId: string }) => result.topicId === 'liability_cap');
      expect(cap).toMatchObject({ verdict: 'accept', criteria: [{ criterionId: 'liability-cap', outcome: 'pass', llm: { answer: 'no' } }] });
      const calls = model.requests.length;

      const second = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/reviews`, payload: { scope: SCOPE } });
      expect(second.json().review.results.find((result: { topicId: string }) => result.topicId === 'liability_cap').verdict).toBe('accept');
      expect(model.requests.length).toBe(calls);
    });
  });
});
