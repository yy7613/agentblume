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

  it('複数Wikiを分離しAgent allowlist内だけを実行contextへ入れる', async () => {
    for (const wiki of [{ id: 'customer-a', name: 'Customer A' }, { id: 'customer-b', name: 'Customer B' }]) {
      const created = await server.inject({ method: 'POST', url: '/wikis', payload: { scope, ...wiki, description: `${wiki.name} knowledge` } });
      expect(created.statusCode).toBe(201);
    }
    await server.inject({ method: 'POST', url: '/wikis/customer-a/pages', payload: { scope, title: 'Refund policy', tags: ['refund'], body: 'Alpha requires a receipt.' } });
    await server.inject({ method: 'POST', url: '/wikis/customer-b/pages', payload: { scope, title: 'Refund policy', tags: ['refund'], body: 'Beta never requires a receipt.' } });
    const onlyA = await server.inject({ method: 'GET', url: '/wikis/customer-a/pages?tenantId=tenant&workspaceId=workspace&q=refund' });
    expect(onlyA.json().pages).toHaveLength(1); expect(onlyA.json().pages[0].wikiId).toBe('customer-a');

    model.enqueue(reflectionCompletion({ wikiTitle: 'Cohort A', wikiBody: 'Customer A cohort rule.' }));
    const reflected = await server.inject({ method: 'POST', url: '/memory/reflect', payload: { scope, input: 'cohort', output: 'done', targetWikiId: 'customer-a' } });
    expect(reflected.json().proposals[0].target.wikiId).toBe('customer-a');
    await server.inject({ method: 'POST', url: `/memory/proposals/${reflected.json().proposals[0].id}/approve`, payload: { scope } });
    const proposedPage = await server.inject({ method: 'GET', url: '/wikis/customer-a/pages?tenantId=tenant&workspaceId=workspace&q=cohort' });
    expect(proposedPage.json().pages.some((page: { title: string }) => page.title === 'Cohort A')).toBe(true);

    const agent = await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'wiki-agent', workingName: 'wiki', displayName: 'Wiki Agent', publishName: 'wiki_agent', owner: 'owner', kind: 'normal', systemPrompt: 'Answer from memory.', tools: [], wikis: [{ wikiId: 'customer-a' }] } });
    expect(agent.statusCode).toBe(201); expect(agent.json().agent.wikis).toEqual([{ wikiId: 'customer-a' }]);
    model.enqueue({ message: { role: 'assistant', content: 'Alpha answer' }, finishReason: 'stop' });
    const run = await server.inject({ method: 'POST', url: '/runs', payload: { scope, agent: { internalId: 'wiki-agent', version: '1.0.0' }, message: 'refund policy', mode: 'preview' } });
    expect(run.statusCode).toBe(200);
    const system = model.requests.at(-1)?.messages[0]?.content ?? '';
    expect(system).toContain('Alpha requires a receipt.'); expect(system).not.toContain('Beta never requires');

    const unknown = await server.inject({ method: 'POST', url: '/agents', payload: { scope, internalId: 'bad-agent', workingName: 'bad', displayName: 'Bad', publishName: 'bad_agent', owner: 'owner', kind: 'normal', systemPrompt: 'x', tools: [], wikis: [{ wikiId: 'ghost' }] } });
    expect(unknown.statusCode).toBe(400); expect(unknown.json().error.message).toMatch(/wiki not found/);
  });
});
