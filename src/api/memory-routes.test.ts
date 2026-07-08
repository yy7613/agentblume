import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedModelProvider } from '../adapters/model/scripted-model-provider';
import { createApp, type App } from '../composition/root';
import { buildServer } from './server';

const scope = { tenantId: 'tenant', workspaceId: 'workspace' };

function reflectionCompletion(over: Record<string, unknown> = {}) {
  const content = JSON.stringify({
    wikiShouldPropose: true, wikiTitle: 'Cohort rule', wikiTags: 'sql, cohort', wikiBody: 'Filter age>=18.', wikiSummary: 'capture cohort rule',
    skillShouldPropose: false, skillInstructions: '', skillSummary: '', ...over,
  });
  return { message: { role: 'assistant' as const, content }, finishReason: 'stop' as const };
}

describe('memory routes (v21)', () => {
  let app: App;
  let model: ScriptedModelProvider;
  let server: FastifyInstance;

  beforeEach(() => {
    model = new ScriptedModelProvider();
    app = createApp({ profile: 'test', modelProvider: model });
    server = buildServer(app);
  });
  afterEach(async () => { await server.close(); app.close(); });

  it('Wiki を保存・取得・検索できる（M1）', async () => {
    const saved = await server.inject({ method: 'POST', url: '/wiki', payload: { scope, title: 'Cohort SQL', tags: ['sql'], body: 'age filter' } });
    expect(saved.statusCode).toBe(201);
    const id = saved.json().page.id as string;
    expect(saved.json().page.version).toBe(1);

    const got = await server.inject({ method: 'GET', url: `/wiki/${id}?tenantId=tenant&workspaceId=workspace` });
    expect(got.json().page.body).toBe('age filter');

    const list = await server.inject({ method: 'GET', url: '/wiki?tenantId=tenant&workspaceId=workspace' });
    expect(list.json().pages).toHaveLength(1);

    const search = await server.inject({ method: 'GET', url: '/wiki?tenantId=tenant&workspaceId=workspace&q=cohort' });
    expect(search.json().pages.map((p: { id: string }) => p.id)).toEqual([id]);
    const miss = await server.inject({ method: 'GET', url: '/wiki?tenantId=tenant&workspaceId=workspace&q=zzz' });
    expect(miss.json().pages).toEqual([]);
  });

  it('reflect→proposals→approve で Wiki が実体化される（M2→M3 ループ）', async () => {
    model.enqueue(reflectionCompletion());
    const reflect = await server.inject({ method: 'POST', url: '/memory/reflect', payload: { scope, input: 'show adults', output: '42 rows', sourceRunId: 'run-1' } });
    expect(reflect.statusCode).toBe(200);
    expect(reflect.json().proposals).toHaveLength(1);

    const drafts = await server.inject({ method: 'GET', url: '/memory/proposals?tenantId=tenant&workspaceId=workspace&state=draft' });
    const proposalId = drafts.json().proposals[0].id as string;
    expect(drafts.json().proposals[0].target.kind).toBe('wiki');

    const approve = await server.inject({ method: 'POST', url: `/memory/proposals/${proposalId}/approve`, payload: { scope } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().proposal.state).toBe('approved');

    // 承認で Wiki が作られている。
    const wiki = await server.inject({ method: 'GET', url: '/wiki?tenantId=tenant&workspaceId=workspace&q=cohort' });
    expect(wiki.json().pages).toHaveLength(1);
    expect(wiki.json().pages[0].title).toBe('Cohort rule');
  });

  it('reject は状態のみ変更する', async () => {
    model.enqueue(reflectionCompletion());
    const reflect = await server.inject({ method: 'POST', url: '/memory/reflect', payload: { scope, input: 'i', output: 'o' } });
    const proposalId = reflect.json().proposals[0].id as string;
    const reject = await server.inject({ method: 'POST', url: `/memory/proposals/${proposalId}/reject`, payload: { scope } });
    expect(reject.json().proposal.state).toBe('rejected');
    const rejected = await server.inject({ method: 'GET', url: '/memory/proposals?tenantId=tenant&workspaceId=workspace&state=rejected' });
    expect(rejected.json().proposals).toHaveLength(1);
  });

  it('未知の提案 approve は 404、空 title の Wiki 保存は 400', async () => {
    const notFound = await server.inject({ method: 'POST', url: '/memory/proposals/ghost/approve', payload: { scope } });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json().error.code).toBe('MEMORY_PROPOSAL_NOT_FOUND');

    const bad = await server.inject({ method: 'POST', url: '/wiki', payload: { scope, title: '', tags: [], body: 'b' } });
    expect(bad.statusCode).toBe(400);
  });

  it('未存在 Wiki の取得は 404', async () => {
    const res = await server.inject({ method: 'GET', url: '/wiki/nope?tenantId=tenant&workspaceId=workspace' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('WIKI_PAGE_NOT_FOUND');
  });
});
