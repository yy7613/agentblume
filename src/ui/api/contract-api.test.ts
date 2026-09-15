import { describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from './business-api';
import { contractApi, CONTRACT_CAPABILITIES_DISABLED_DTO } from './contract-api';
import { CONTRACT_ERROR_MESSAGES } from './contract-error-messages';

const scope = { tenantId: 't', workspaceId: 'w' };
const q = 'tenantId=t&workspaceId=w';

function transportReturning(response: unknown) {
  const request = vi.fn(async () => response);
  return { transport: { request } as unknown as ApiTransport, request };
}

describe('contractApi', () => {
  it('正常: GET / DELETE は scope をクエリに、それ以外は JSON 本文に載せ、包みを外して返す', async () => {
    const cases: readonly [string, (api: ReturnType<typeof contractApi>) => Promise<unknown>, unknown, string, string | undefined, unknown][] = [
      ['listPlaybooks', (api) => api.listPlaybooks(scope), { playbooks: [], unsaved: true }, `/contracts/playbooks?${q}`, undefined, { playbooks: [], unsaved: true }],
      ['getPlaybook', (api) => api.getPlaybook(scope, 'a b'), { playbook: { id: 'x' }, unsaved: false }, `/contracts/playbooks/a%20b?${q}`, undefined, { playbook: { id: 'x' }, unsaved: false }],
      ['savePlaybook', (api) => api.savePlaybook(scope, { name: 'n' } as never), { playbook: { id: 'p' } }, '/contracts/playbooks', 'POST', { id: 'p' }],
      ['deletePlaybook', (api) => api.deletePlaybook(scope, 'p'), {}, `/contracts/playbooks/p?${q}`, 'DELETE', undefined],
      ['listTemplates', (api) => api.listTemplates(scope), { templates: [{ id: 't' }] }, `/contracts/playbook-templates?${q}`, undefined, [{ id: 't' }]],
      ['createPlaybookFromTemplate', (api) => api.createPlaybookFromTemplate(scope, { templateId: 't' }), { playbook: { id: 'p' } }, '/contracts/playbooks/from-template', 'POST', { id: 'p' }],
      ['listDocuments', (api) => api.listDocuments(scope, { status: 'signed', limit: 5 }), { documents: [1] }, `/contracts/documents?${q}&status=signed&limit=5`, undefined, [1]],
      ['listDocuments（既定）', (api) => api.listDocuments(scope), { documents: [] }, `/contracts/documents?${q}`, undefined, []],
      ['importDocument', (api) => api.importDocument(scope, { title: 't', body: 'b', source: { type: 'text' } }), { document: { id: 'd' }, warnings: [] }, '/contracts/documents', 'POST', { document: { id: 'd' }, warnings: [] }],
      ['getDocument', (api) => api.getDocument(scope, 'd'), { document: { id: 'd' } }, `/contracts/documents/d?${q}`, undefined, { id: 'd' }],
      ['updateDocument', (api) => api.updateDocument(scope, 'd', { title: 't', body: 'b', source: { type: 'text' } }), { document: { id: 'd' } }, '/contracts/documents/d', 'PUT', { id: 'd' }],
      ['deleteDocument', (api) => api.deleteDocument(scope, 'd'), {}, `/contracts/documents/d?${q}`, 'DELETE', undefined],
      ['transcribe', (api) => api.transcribe(scope, ['data:'], 'p.png'), { result: { pages: [] } }, '/contracts/documents/transcribe', 'POST', { pages: [] }],
      ['transcribe（名前なし）', (api) => api.transcribe(scope, ['data:']), { result: { pages: [] } }, '/contracts/documents/transcribe', 'POST', { pages: [] }],
      ['extract', (api) => api.extract(scope, 'd', { scanAllArticles: true }), { document: { id: 'd' } }, '/contracts/documents/d/extract', 'POST', { id: 'd' }],
      ['extract（既定）', (api) => api.extract(scope, 'd'), { document: { id: 'd' } }, '/contracts/documents/d/extract', 'POST', { id: 'd' }],
      ['confirmClauses', (api) => api.confirmClauses(scope, 'd', { clauses: [] }), { document: { id: 'd' } }, '/contracts/documents/d/clauses', 'PUT', { id: 'd' }],
      ['runReview', (api) => api.runReview(scope, 'd', 'p'), { review: { id: 'r' }, notice: 'n' }, '/contracts/documents/d/reviews', 'POST', { review: { id: 'r' }, notice: 'n' }],
      ['runReview（基準なし）', (api) => api.runReview(scope, 'd'), { review: { id: 'r' }, notice: 'n' }, '/contracts/documents/d/reviews', 'POST', { review: { id: 'r' }, notice: 'n' }],
      ['getReview', (api) => api.getReview(scope, 'r'), { review: { id: 'r' } }, `/contracts/reviews/r?${q}`, undefined, { review: { id: 'r' } }],
      ['saveDecisions', (api) => api.saveDecisions(scope, 'r', [{ topicId: 't', decision: 'accept' }]), { review: {} }, '/contracts/reviews/r/decisions', 'PUT', { review: {} }],
      ['finalizeReview', (api) => api.finalizeReview(scope, 'r'), { review: {} }, '/contracts/reviews/r/finalize', 'POST', { review: {} }],
      ['previewDeadlines', (api) => api.previewDeadlines(scope, { documentId: 'd' }), { preview: { deadlines: [] } }, '/contracts/deadlines/preview', 'POST', { deadlines: [] }],
      ['registerSigned', (api) => api.registerSigned(scope, { documentId: 'd', signedDate: '2026-01-01', signingMethod: 'paper' }), { contract: {}, warnings: [] }, '/contracts/signed', 'POST', { contract: {}, warnings: [] }],
      ['listSigned', (api) => api.listSigned(scope, { status: 'active', counterparty: '架空' }), { contracts: [1] }, `/contracts/signed?${q}&status=active&counterparty=%E6%9E%B6%E7%A9%BA`, undefined, [1]],
      ['listSigned（既定）', (api) => api.listSigned(scope, { counterparty: '' }), { contracts: [] }, `/contracts/signed?${q}`, undefined, []],
      ['getSigned', (api) => api.getSigned(scope, 'c'), { contract: { id: 'c' } }, `/contracts/signed/c?${q}`, undefined, { id: 'c' }],
      ['updateSigned', (api) => api.updateSigned(scope, 'c', { title: 't' }), { contract: { id: 'c' } }, '/contracts/signed/c', 'PUT', { id: 'c' }],
      ['deleteSigned', (api) => api.deleteSigned(scope, 'c'), {}, `/contracts/signed/c?${q}`, 'DELETE', undefined],
      ['terminateSigned', (api) => api.terminateSigned(scope, 'c', '2026-09-30', '合意'), { contract: { id: 'c' } }, '/contracts/signed/c/terminate', 'POST', { id: 'c' }],
      ['terminateSigned（理由なし）', (api) => api.terminateSigned(scope, 'c', '2026-09-30', ''), { contract: { id: 'c' } }, '/contracts/signed/c/terminate', 'POST', { id: 'c' }],
      ['listDeadlines', (api) => api.listDeadlines(scope, { withinDays: 30, includeOverdue: false, kind: 'expiry', limit: 3 }), { ledger: { rows: [] } }, `/contracts/deadlines?${q}&withinDays=30&includeOverdue=false&kind=expiry&limit=3`, undefined, { rows: [] }],
      ['listDeadlines（既定）', (api) => api.listDeadlines(scope), { ledger: { rows: [] } }, `/contracts/deadlines?${q}`, undefined, { rows: [] }],
      ['completeDeadline', (api) => api.completeDeadline(scope, 'c', 'renewal_notice-1', 'done'), { contract: { id: 'c' } }, '/contracts/signed/c/deadlines/renewal_notice-1/complete', 'POST', { id: 'c' }],
      ['completeDeadline（メモなし）', (api) => api.completeDeadline(scope, 'c', 'x'), { contract: { id: 'c' } }, '/contracts/signed/c/deadlines/x/complete', 'POST', { id: 'c' }],
    ];
    for (const [label, call, response, path, method, expected] of cases) {
      const { transport, request } = transportReturning(response);
      const result = await call(contractApi(transport));
      expect(result, label).toEqual(expected);
      const [calledPath, init] = request.mock.calls[0] as unknown as [string, RequestInit | undefined];
      expect(calledPath, label).toBe(path);
      expect(init?.method, label).toBe(method);
      if (method === 'POST' || method === 'PUT') expect(JSON.parse(String(init?.body)).scope, label).toEqual(scope);
    }
  });

  it('境界: capabilities は contract キーが無い旧サーバーなら「使えない」に倒す', async () => {
    expect(await contractApi(transportReturning({}).transport).capabilities()).toEqual(CONTRACT_CAPABILITIES_DISABLED_DTO);
    const enabled = { extraction: { enabled: true, vision: false }, review: { llm: true } };
    const { transport, request } = transportReturning({ contract: enabled });
    const signal = new AbortController().signal;
    expect(await contractApi(transport).capabilities(signal)).toEqual(enabled);
    expect(request).toHaveBeenCalledWith('/runtime/capabilities', { signal });
  });
});

describe('CONTRACT_ERROR_MESSAGES', () => {
  it('正常: 判断が未入力の条項があれば件数と id を見出しに入れる', () => {
    const heading = CONTRACT_ERROR_MESSAGES.heading!;
    expect(heading({ status: 400, code: 'CONTRACT_DOMAIN', serverMessage: '', details: { undecidedTopicIds: ['term', 'payment'] } }, 'ja')).toContain('2 件あります（term、payment）');
    expect(heading({ status: 400, code: 'CONTRACT_DOMAIN', serverMessage: '', details: { undecidedTopicIds: ['term'] } }, 'en')).toContain('1 clause type(s)');
  });

  it('境界: 他の code・詳細なし・空の一覧には反応しない', () => {
    const heading = CONTRACT_ERROR_MESSAGES.heading!;
    expect(heading({ status: 409, code: 'CONTRACT_STATE', serverMessage: '', details: { undecidedTopicIds: ['x'] } }, 'ja')).toBeUndefined();
    expect(heading({ status: 400, code: 'CONTRACT_DOMAIN', serverMessage: '' }, 'ja')).toBeUndefined();
    expect(heading({ status: 400, code: 'CONTRACT_DOMAIN', serverMessage: '', details: { undecidedTopicIds: [] } }, 'en')).toBeUndefined();
    expect(Object.keys(CONTRACT_ERROR_MESSAGES.headings).every((code) => code.startsWith('CONTRACT_'))).toBe(true);
  });
});
