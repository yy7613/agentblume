/**
 * /contracts ルートの任意項目がすべて use case まで届くこと（contract-routes.test.ts は既定の経路を見る）。
 * 画面が送りうる項目を 1 つずつ落とすと、利用者が入れた値が黙って捨てられるので、全項目を載せた要求で確かめる。
 */
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SingleUserAuthentication } from '../adapters/security/single-user-authentication';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const SCOPE = { tenantId: 'tenant-a', workspaceId: 'ws-1' };
const scopeQuery = `tenantId=${SCOPE.tenantId}&workspaceId=${SCOPE.workspaceId}`;
const BODY = ['前文', '第1条（目的）', '委託する。', '第2条（契約期間）', '本契約の有効期間は、2026年4月1日から2027年3月31日までとする。', '第3条（支払）', '翌月末日に支払う。'].join('\n');
const TERM = { topicId: 'term', present: true, articleRef: '第2条', evidence: [{ quote: '本契約の有効期間は', verified: true }], value: { kind: 'term', startDate: '2026-04-01', endDate: '2027-03-31', durationMonths: 12, startsOnSigning: false }, source: 'manual', warnings: [] };

describe('contract routes: 任意項目', () => {
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

  it('正常: 取込・確定・レビュー・締結登録・手修正・台帳の任意項目を全部載せて通る', async () => {
    const created = await server.inject({ method: 'POST', url: '/contracts/playbooks/from-template', payload: { scope: SCOPE, templateId: 'outsourcing-client', name: '自社基準', isDefault: true, ourCompanyNames: ['サンプル商事'] } });
    expect(created.json().playbook).toMatchObject({ name: '自社基準', ourCompanyNames: ['サンプル商事'] });
    const playbookId = created.json().playbook.id as string;

    const fields = {
      scope: SCOPE, title: '保守', body: BODY,
      source: { type: 'pdf-text', fileName: 'contract.pdf', pageCount: 1, sha256: 'a'.repeat(64) },
      pages: [{ page: 1, start: 0, end: BODY.length, method: 'text-layer', warnings: [] }],
      parties: { A: '株式会社サンプル商事', B: '架空テック合同会社' }, ourParty: 'A', ourRole: 'client',
      counterpartyProfile: { toriteki: 'no', freelance: 'yes' }, contractNature: 'ukeoi', contractAmount: 3_300_000, playbookId,
    };
    const imported = await server.inject({ method: 'POST', url: '/contracts/documents', payload: fields });
    expect(imported.statusCode).toBe(200);
    const document = imported.json().document;
    expect(document).toMatchObject({ source: { fileName: 'contract.pdf', pageCount: 1 }, counterpartyProfile: { freelance: 'yes' }, contractNature: { value: 'ukeoi' }, contractAmount: 3_300_000 });
    // 同じファイルの二重取込は警告だけ返す（保存はする）。
    expect((await server.inject({ method: 'POST', url: '/contracts/documents', payload: fields })).json().warnings[0]).toContain('取込済み');
    const updated = await server.inject({ method: 'PUT', url: `/contracts/documents/${document.id}`, payload: { ...fields, ourRole: 'vendor' } });
    expect(updated.json().document.ourRole).toBe('vendor');
    expect((await server.inject({ method: 'GET', url: `/contracts/documents?${scopeQuery}&status=imported&limit=1` })).json().documents).toHaveLength(1);

    const extract = await server.inject({ method: 'POST', url: `/contracts/documents/${document.id}/extract`, payload: { scope: SCOPE, playbookId, scanAllArticles: true, articleRefs: ['第2条'] } });
    expect(extract.statusCode).toBe(409);

    const confirmed = await server.inject({ method: 'PUT', url: `/contracts/documents/${document.id}/clauses`, payload: { scope: SCOPE, clauses: [TERM], ourParty: 'B', contractNature: 'jun_inin', playbookId } });
    expect(confirmed.json().document).toMatchObject({ status: 'confirmed', ourParty: 'B', contractNature: { value: 'jun_inin' } });

    const review = (await server.inject({ method: 'POST', url: `/contracts/documents/${document.id}/reviews`, payload: { scope: SCOPE, playbookId } })).json().review;
    const decisions = await server.inject({ method: 'PUT', url: `/contracts/reviews/${review.id}/decisions`, payload: { scope: SCOPE, decisions: [{ topicId: 'term', decision: 'accept', note: 'ok' }, { topicId: 'payment' }, { topicId: 'term', decision: null, note: null }] } });
    expect(decisions.statusCode).toBe(200);

    const preview = await server.inject({ method: 'POST', url: '/contracts/deadlines/preview', payload: { scope: SCOPE, documentId: document.id, signedDate: '2026-03-20', signingMethod: 'electronic', contractAmount: 1_000_000, playbookId } });
    expect(preview.json().preview.stampDutyCandidates).toEqual(expect.arrayContaining([expect.objectContaining({ documentTypeCode: 'no7', electronic: true })]));
    expect((await server.inject({ method: 'POST', url: '/contracts/deadlines/preview', payload: { scope: SCOPE, documentId: document.id } })).statusCode).toBe(200);

    const signed = await server.inject({ method: 'POST', url: '/contracts/signed', payload: { scope: SCOPE, documentId: document.id, signedDate: '2026-03-20', signingMethod: 'paper', title: '保守（締結版）', counterpartyName: '株式会社サンプル商事', stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: false }, playbookId } });
    expect(signed.json().contract).toMatchObject({ title: '保守（締結版）', counterpartyName: '株式会社サンプル商事', stampDuty: { documentTypeCode: 'no7', amount: 4000, affixed: false } });
    const contractId = signed.json().contract.id as string;

    const edited = await server.inject({
      method: 'PUT', url: `/contracts/signed/${contractId}`,
      payload: {
        scope: SCOPE, title: '保守（改）', counterpartyName: '架空テック', signedDate: '2026-03-21', signingMethod: 'electronic', stampDuty: { documentTypeCode: 'no7', amount: 0, affixed: null },
        clauses: [{ topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第2条', quote: '本契約の有効期間は', quoteVerified: true, value: TERM.value }],
        customDeadlines: [{ dueDate: '2026-10-31', basis: '月次報告', note: '10 月分' }],
      },
    });
    expect(edited.statusCode).toBe(200);
    const custom = edited.json().contract.deadlines.find((deadline: { kind: string }) => deadline.kind === 'custom');
    expect(custom).toMatchObject({ basis: '月次報告', note: '10 月分' });
    const keep = await server.inject({ method: 'PUT', url: `/contracts/signed/${contractId}`, payload: { scope: SCOPE, customDeadlines: [{ id: custom.id, dueDate: '2026-11-30', basis: '月次報告' }] } });
    expect(keep.json().contract.deadlines.find((deadline: { kind: string }) => deadline.kind === 'custom')).toMatchObject({ id: custom.id, dueDate: '2026-11-30' });

    expect((await server.inject({ method: 'GET', url: `/contracts/signed?${scopeQuery}&status=active` })).json().contracts).toHaveLength(1);
    const ledger = await server.inject({ method: 'GET', url: `/contracts/deadlines?${scopeQuery}&withinDays=400&includeOverdue=false&kind=custom&limit=5` });
    expect(ledger.json().ledger.rows.map((row: { deadline: { kind: string } }) => row.deadline.kind)).toEqual(['custom']);

    const terminated = await server.inject({ method: 'POST', url: `/contracts/signed/${contractId}/terminate`, payload: { scope: SCOPE, terminatedAt: '2026-09-30' } });
    expect(terminated.json().contract.status).toBe('terminated');
    expect((await server.inject({ method: 'PUT', url: `/contracts/signed/${contractId}`, payload: { scope: SCOPE, title: 'x' } })).statusCode).toBe(409);
    expect((await server.inject({ method: 'POST', url: `/contracts/signed/${contractId}/terminate`, payload: { scope: SCOPE, terminatedAt: '2026-09-30' } })).statusCode).toBe(409);
  });

  it('異常: 本文の無い POST（extract / reviews / finalize / complete）も既定で受け付け、存在しない対象は 404', async () => {
    expect((await server.inject({ method: 'POST', url: '/contracts/documents/missing/extract' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/contracts/documents/missing/reviews' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/contracts/reviews/missing/finalize' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/contracts/signed/missing/deadlines/x/complete' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/contracts/signed/missing/terminate', payload: { scope: SCOPE, terminatedAt: '2026-09-30', reason: 'r' } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: `/contracts/documents?${scopeQuery}&limit=0` })).statusCode).toBe(400);
  });
});
