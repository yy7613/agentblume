/**
 * /contracts ルートのテスト（LLM を使わない部分。LLM ルートは contract-llm-routes.test.ts）。
 *
 * createApp({profile:'test'}) + buildServer で配線し、`fastify.inject()` で UI が期待する形（パス・包み・状態コード・
 * エラーの code と「直す場所」の項目）を守る。今日の日付で期限が変わるので Date だけを固定する。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;

const BODY = [
  '業務委託契約書',
  '',
  '株式会社サンプル商事（以下「甲」という。）と架空テック合同会社（以下「乙」という。）は、次のとおり契約を締結する。',
  '',
  '第1条（目的）',
  '甲は、乙に対し、社内システムの保守業務を委託する。',
  '第2条（契約期間）',
  '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。',
  '第3条（自動更新）',
  '期間満了の3か月前までに甲乙いずれからも書面による別段の申出がないときは、本契約は同一条件でさらに1年間更新されるものとし、以後も同様とする。',
  '第4条（委託料の支払）',
  '甲は、毎月末日締めで乙の請求に基づき、翌々月末日までに乙の指定する銀行口座に振り込む方法により委託料を支払う。',
  '',
  '本契約締結の証として、本書2通を作成する。',
].join('\n');

const evidence = (quote: string) => [{ quote, verified: true }];
const CLAUSES = [
  { topicId: 'term', present: true, articleRef: '第2条', evidence: evidence('本契約の有効期間は、2026年4月1日から2027年3月31日までとする。'), value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }, source: 'manual', warnings: [] },
  { topicId: 'auto_renewal', present: true, articleRef: '第3条', evidence: evidence('本契約は同一条件でさらに1年間更新されるものとし'), value: { kind: 'auto_renewal', renews: true, renewalMonths: 12, sameAsInitial: false }, source: 'manual', warnings: [] },
  { topicId: 'renewal_notice', present: true, articleRef: '第3条', evidence: evidence('期間満了の3か月前までに甲乙いずれからも書面による別段の申出がないときは'), value: { kind: 'notice', amount: 3, unit: 'month', anchor: 'expiry', businessDays: false }, source: 'manual', warnings: [] },
  { topicId: 'payment', present: true, articleRef: '第4条', evidence: evidence('毎月末日締めで乙の請求に基づき、翌々月末日までに乙の指定する銀行口座に振り込む方法により委託料を支払う'), value: { kind: 'payment_terms', basis: 'invoice', closingDay: 'month_end', payMonthOffset: 2, payDay: 'month_end', method: 'bank_transfer' }, source: 'manual', warnings: [] },
];

describe('contract routes', () => {
  let app: App;
  let server: FastifyInstance;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-15T03:00:00.000Z'));
    app = createApp({ profile: 'test' });
    server = buildServer(app, { authentication: new SingleUserAuthentication(SCOPE) });
  });

  afterEach(async () => {
    await server.close();
    app.close();
    vi.useRealTimers();
  });

  async function createPlaybook(): Promise<string> {
    const res = await server.inject({ method: 'POST', url: '/contracts/playbooks/from-template', payload: { scope: SCOPE, templateId: 'outsourcing-client', ourCompanyNames: ['株式会社サンプル商事'] } });
    expect(res.statusCode).toBe(200);
    return res.json().playbook.id as string;
  }

  async function importDocument(extra: Record<string, unknown> = {}): Promise<string> {
    const res = await server.inject({ method: 'POST', url: '/contracts/documents', payload: { scope: SCOPE, title: '保守業務委託', body: BODY, source: { type: 'text' }, counterpartyProfile: { toriteki: 'yes', freelance: 'no' }, contractNature: 'jun_inin', ...extra } });
    expect(res.statusCode).toBe(200);
    return res.json().document.id as string;
  }

  async function confirmed(): Promise<string> {
    await createPlaybook();
    const id = await importDocument();
    const res = await server.inject({ method: 'PUT', url: `/contracts/documents/${id}/clauses`, payload: { scope: SCOPE, clauses: CLAUSES } });
    expect(res.statusCode).toBe(200);
    return id;
  }

  describe('審査基準', () => {
    it('正常: 0 件なら既定テンプレートを保存せず unsaved で返し、テンプレート一覧は 2 種', async () => {
      const list = await server.inject({ method: 'GET', url: `/contracts/playbooks?${scopeQuery}` });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toMatchObject({ unsaved: true, playbooks: [{ id: 'template-default', isDefault: true }] });
      const templates = await server.inject({ method: 'GET', url: `/contracts/playbook-templates?${scopeQuery}` });
      expect(templates.json().templates.map((template: { id: string }) => template.id)).toEqual(['outsourcing-client', 'nda-mutual']);
      expect((await app.contractPlaybookRepo.list(SCOPE))).toHaveLength(0);
    });

    it('正常: テンプレートから作成 → 取得 → 編集して保存 → 削除（204）。応答は tenant を含まない', async () => {
      const id = await createPlaybook();
      const got = await server.inject({ method: 'GET', url: `/contracts/playbooks/${id}?${scopeQuery}` });
      expect(got.statusCode).toBe(200);
      const playbook = got.json().playbook;
      expect(playbook).not.toHaveProperty('tenant');
      expect(playbook.isDefault).toBe(true);
      const saved = await server.inject({ method: 'POST', url: '/contracts/playbooks', payload: { scope: SCOPE, ...playbook, name: '自社の業務委託基準' } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().playbook).toMatchObject({ id, name: '自社の業務委託基準' });
      expect((await server.inject({ method: 'DELETE', url: `/contracts/playbooks/${id}?${scopeQuery}` })).statusCode).toBe(204);
    });

    it('異常: 未知の置換子は 400 CONTRACT_DOMAIN、存在しない id は 404、未知のテンプレートは 400', async () => {
      const id = await createPlaybook();
      const playbook = (await server.inject({ method: 'GET', url: `/contracts/playbooks/${id}?${scopeQuery}` })).json().playbook;
      const broken = { ...playbook, criteria: [{ ...playbook.criteria[0], recommendedText: '{unknown} へ修正を求める' }] };
      const res = await server.inject({ method: 'POST', url: '/contracts/playbooks', payload: { scope: SCOPE, ...broken } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'CONTRACT_DOMAIN', message: expect.stringContaining('{unknown}') });
      expect((await server.inject({ method: 'GET', url: `/contracts/playbooks/missing?${scopeQuery}` })).json().error.code).toBe('CONTRACT_PLAYBOOK_NOT_FOUND');
      expect((await server.inject({ method: 'DELETE', url: `/contracts/playbooks/missing?${scopeQuery}` })).statusCode).toBe(404);
      expect((await server.inject({ method: 'POST', url: '/contracts/playbooks/from-template', payload: { scope: SCOPE, templateId: 'nope' } })).statusCode).toBe(400);
      expect((await server.inject({ method: 'POST', url: '/contracts/playbooks', payload: { scope: SCOPE, name: 'x' } })).json().error.code).toBe('BAD_REQUEST');
    });
  });

  describe('文書', () => {
    it('正常: 取込で条文分割と甲乙の検出まで行い、一覧は本文を含まない要約', async () => {
      await createPlaybook();
      const id = await importDocument();
      const document = (await server.inject({ method: 'GET', url: `/contracts/documents/${id}?${scopeQuery}` })).json().document;
      expect(document.articles.map((article: { ref: string }) => article.ref)).toEqual(['前文', '第1条', '第2条', '第3条', '第4条', '後文']);
      expect(document).toMatchObject({ status: 'imported', ourParty: 'A', parties: { A: { name: '株式会社サンプル商事' }, B: { name: '架空テック合同会社' } } });
      const list = (await server.inject({ method: 'GET', url: `/contracts/documents?${scopeQuery}&status=imported` })).json().documents;
      expect(list).toHaveLength(1);
      expect(list[0]).not.toHaveProperty('body');
      expect(list[0]).toMatchObject({ counterpartyName: '架空テック合同会社' });
    });

    it('正常: 更新で相手方区分を直せる。本文を変えると imported に戻る', async () => {
      const id = await confirmed();
      const updated = await server.inject({ method: 'PUT', url: `/contracts/documents/${id}`, payload: { scope: SCOPE, title: '保守業務委託', body: BODY, source: { type: 'text' }, counterpartyProfile: { toriteki: 'no', freelance: 'no' } } });
      expect(updated.json().document).toMatchObject({ status: 'confirmed', counterpartyProfile: { toriteki: 'no' } });
      const changed = await server.inject({ method: 'PUT', url: `/contracts/documents/${id}`, payload: { scope: SCOPE, title: '保守業務委託', body: `${BODY}\n付則`, source: { type: 'text' } } });
      expect(changed.json().document).toMatchObject({ status: 'imported', clauses: [] });
    });

    it('異常: 本文の上限超過は 400、存在しない文書は 404', async () => {
      const tooLong = await server.inject({ method: 'POST', url: '/contracts/documents', payload: { scope: SCOPE, title: 'x', body: 'あ'.repeat(300_001), source: { type: 'text' } } });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json().error.message).toContain('split the appendices');
      expect((await server.inject({ method: 'GET', url: `/contracts/documents/missing?${scopeQuery}` })).json().error.code).toBe('CONTRACT_DOCUMENT_NOT_FOUND');
      expect((await server.inject({ method: 'DELETE', url: `/contracts/documents/missing?${scopeQuery}` })).statusCode).toBe(404);
    });
  });

  describe('レビュー', () => {
    it('正常: モデルが無くても決定的な判定を返し、固定文言を添える。判断をすべて入れて確定すると文書は reviewed', async () => {
      const id = await confirmed();
      const run = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/reviews`, payload: { scope: SCOPE } });
      expect(run.statusCode).toBe(200);
      const { review, notice } = run.json();
      expect(notice).toContain('法的な判断ではありません');
      const byTopic = Object.fromEntries(review.results.map((result: { topicId: string }) => [result.topicId, result]));
      // 月末締め翌々月末払いは最長 92 日目で、取適法の相手方には設定値 60 日を超える。
      expect(byTopic['payment']).toMatchObject({ verdict: 'reject', reasons: [{ code: 'payment-over-limit' }] });
      expect(byTopic['liability_cap'].verdict).toBe('accept');
      expect(review.overall).toBe('reject');
      expect(review.documentFindings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'stamp-duty-candidate' })]));

      const early = await server.inject({ method: 'POST', url: `/contracts/reviews/${review.id}/finalize`, payload: { scope: SCOPE } });
      expect(early.statusCode).toBe(400);
      expect(early.json().error.undecidedTopicIds).toHaveLength(review.results.length);

      const decisions = review.results.map((result: { topicId: string }) => ({ topicId: result.topicId, decision: 'negotiate', note: '交渉する' }));
      expect((await server.inject({ method: 'PUT', url: `/contracts/reviews/${review.id}/decisions`, payload: { scope: SCOPE, decisions } })).statusCode).toBe(200);
      const finalized = await server.inject({ method: 'POST', url: `/contracts/reviews/${review.id}/finalize`, payload: { scope: SCOPE } });
      expect(finalized.json().review.status).toBe('finalized');
      expect((await server.inject({ method: 'GET', url: `/contracts/documents/${id}?${scopeQuery}` })).json().document.status).toBe('reviewed');
      expect((await server.inject({ method: 'PUT', url: `/contracts/reviews/${review.id}/decisions`, payload: { scope: SCOPE, decisions } })).json().error.code).toBe('CONTRACT_STATE');
      expect((await server.inject({ method: 'GET', url: `/contracts/reviews/${review.id}?${scopeQuery}` })).json().review.id).toBe(review.id);
    });

    it('異常: 条項を確定していない文書のレビューは 409（どの文書かを本文に載せる）、存在しないレビューは 404', async () => {
      await createPlaybook();
      const id = await importDocument();
      const res = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/reviews`, payload: { scope: SCOPE } });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatchObject({ code: 'CONTRACT_STATE', documentId: id });
      expect((await server.inject({ method: 'GET', url: `/contracts/reviews/missing?${scopeQuery}` })).json().error.code).toBe('CONTRACT_REVIEW_NOT_FOUND');
    });
  });

  describe('締結登録と期限台帳', () => {
    it('正常: 期限プレビュー → 締結登録 → 台帳 → 通知済み → 手修正 → 終了 → 削除で文書が戻る', async () => {
      const id = await confirmed();
      const preview = await server.inject({ method: 'POST', url: '/contracts/deadlines/preview', payload: { scope: SCOPE, documentId: id, signedDate: '2026-03-20', signingMethod: 'paper' } });
      expect(preview.json().preview).toMatchObject({ autoRenewal: true, termEnd: '2027-03-31', review: 'none', counterpartyName: '架空テック合同会社' });

      const signed = await server.inject({ method: 'POST', url: '/contracts/signed', payload: { scope: SCOPE, documentId: id, signedDate: '2026-03-20', signingMethod: 'paper', stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: true } } });
      expect(signed.statusCode).toBe(200);
      const contract = signed.json().contract;
      expect(contract.deadlines.map((deadline: { id: string; dueDate: string }) => [deadline.id, deadline.dueDate])).toEqual([['renewal_notice-1', '2026-12-31'], ['expiry-1', '2027-03-31'], ['renewal-1', '2027-04-01']]);
      expect(signed.json().warnings[0].message).toContain('レビューしていません');

      const again = await server.inject({ method: 'POST', url: '/contracts/signed', payload: { scope: SCOPE, documentId: id, signedDate: '2026-03-20', signingMethod: 'paper' } });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toMatchObject({ code: 'CONTRACT_STATE', documentId: id });
      expect((await server.inject({ method: 'DELETE', url: `/contracts/documents/${id}?${scopeQuery}` })).statusCode).toBe(409);

      const ledger = await server.inject({ method: 'GET', url: `/contracts/deadlines?${scopeQuery}&withinDays=120&includeOverdue=true` });
      expect(ledger.json().ledger).toMatchObject({ today: '2026-09-15', rows: [{ contractId: contract.id, deadline: { kind: 'renewal_notice' }, daysLeft: 107, state: 'upcoming' }] });
      expect((await server.inject({ method: 'GET', url: `/contracts/deadlines?${scopeQuery}&kind=expiry` })).json().ledger.rows).toHaveLength(1);

      const done = await server.inject({ method: 'POST', url: `/contracts/signed/${contract.id}/deadlines/renewal_notice-1/complete`, payload: { scope: SCOPE, note: '9/20 に書面で通知' } });
      expect(done.json().contract.deadlines.find((deadline: { id: string }) => deadline.id === 'renewal_notice-1')).toMatchObject({ status: 'done', note: '9/20 に書面で通知' });
      expect((await server.inject({ method: 'POST', url: `/contracts/signed/${contract.id}/deadlines/renewal_notice-1/complete`, payload: { scope: SCOPE } })).statusCode).toBe(409);

      const list = await server.inject({ method: 'GET', url: `/contracts/signed?${scopeQuery}&counterparty=架空` });
      expect(list.json().contracts).toMatchObject([{ id: contract.id, displayStatus: 'active' }]);
      const edited = await server.inject({ method: 'PUT', url: `/contracts/signed/${contract.id}`, payload: { scope: SCOPE, customDeadlines: [{ dueDate: '2026-10-31', basis: '月次報告' }] } });
      expect(edited.json().contract.deadlines.some((deadline: { kind: string }) => deadline.kind === 'custom')).toBe(true);
      expect((await server.inject({ method: 'GET', url: `/contracts/signed/${contract.id}?${scopeQuery}` })).json().contract.id).toBe(contract.id);

      const terminated = await server.inject({ method: 'POST', url: `/contracts/signed/${contract.id}/terminate`, payload: { scope: SCOPE, terminatedAt: '2026-09-30', reason: '合意解約' } });
      expect(terminated.json().contract).toMatchObject({ status: 'terminated', terminatedAt: '2026-09-30' });
      expect((await server.inject({ method: 'DELETE', url: `/contracts/signed/${contract.id}?${scopeQuery}` })).statusCode).toBe(204);
      expect((await server.inject({ method: 'GET', url: `/contracts/documents/${id}?${scopeQuery}` })).json().document.status).toBe('confirmed');
    });

    it('異常: 存在しない契約は 404、締結日の形が崩れていれば 400', async () => {
      expect((await server.inject({ method: 'GET', url: `/contracts/signed/missing?${scopeQuery}` })).json().error.code).toBe('CONTRACT_SIGNED_NOT_FOUND');
      expect((await server.inject({ method: 'POST', url: '/contracts/signed', payload: { scope: SCOPE, documentId: 'x', signedDate: '20260320', signingMethod: 'paper' } })).statusCode).toBe(400);
    });
  });

  describe('LLM 機能（test プロファイルは使えない側へ倒す）', () => {
    it('異常: 抽出と文字起こしは 409 CONTRACT_EXTRACTION_UNAVAILABLE で、どこで直すかを書く', async () => {
      await createPlaybook();
      const id = await importDocument();
      const extract = await server.inject({ method: 'POST', url: `/contracts/documents/${id}/extract`, payload: { scope: SCOPE } });
      expect(extract.statusCode).toBe(409);
      expect(extract.json().error).toMatchObject({ code: 'CONTRACT_EXTRACTION_UNAVAILABLE', message: expect.stringContaining('Settings') });
      const transcribe = await server.inject({ method: 'POST', url: '/contracts/documents/transcribe', payload: { scope: SCOPE, images: ['data:image/png;base64,AAA='] } });
      expect(transcribe.statusCode).toBe(409);
    });

    it('正常: /runtime/capabilities に contract キーが「使えない」で載る', async () => {
      const res = await server.inject({ method: 'GET', url: '/runtime/capabilities' });
      expect(res.json().contract).toEqual({ extraction: { enabled: false, vision: false }, review: { llm: false } });
    });
  });
});
