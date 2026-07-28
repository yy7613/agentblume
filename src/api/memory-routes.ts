/**
 * api層: 長期記憶ルート（v21 実装契約 §4 / ADR-0016）
 *
 * Wiki（宣言的知識）の参照・保存と、記憶提案（Run抽出→人手承認）の一覧・承認・却下。
 * 承認時のみ実体（Wiki改訂 / Skill蒸留）へ適用される（人手承認制）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { SaveWikiPageUseCase } from '../application/memory/save-wiki-page';
import type { DeleteWikiPageUseCase, QueryWikiUseCase } from '../application/memory/query-wiki';
import type { ReflectRunUseCase } from '../application/memory/reflect-run';
import type { ListProposalsUseCase } from '../application/memory/list-proposals';
import type { ReviewProposalUseCase } from '../application/memory/review-proposal';
import type { DeleteWikiSpaceUseCase, QueryWikiSpacesUseCase, SaveWikiSpaceUseCase } from '../application/memory/wiki-spaces';
import { serializeMemoryProposal } from '../domain/memory/serialization';
import { serializeWikiPage } from '../domain/memory/serialization';
import { serializeWikiSpace } from '../domain/memory/serialization';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { proposalDecisionBodySchema, proposalListQuerySchema, reflectRunBodySchema, saveWikiBodySchema, saveWikiSpaceBodySchema, scopeQuerySchema, wikiSearchQuerySchema } from './schemas';

export interface MemoryRouteDeps {
  readonly saveWikiPage: SaveWikiPageUseCase;
  readonly queryWiki: QueryWikiUseCase;
  readonly deleteWikiPage: DeleteWikiPageUseCase;
  readonly reflectRun: ReflectRunUseCase;
  readonly listProposals: ListProposalsUseCase;
  readonly reviewProposal: ReviewProposalUseCase;
  readonly saveWikiSpace: SaveWikiSpaceUseCase;
  readonly queryWikiSpaces: QueryWikiSpacesUseCase;
  readonly deleteWikiSpace: DeleteWikiSpaceUseCase;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  }
  return result.data as z.infer<S>;
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  app.get('/wikis', async (request) => {
    parse(wikiSearchQuerySchema, request.query);
    return { wikis: await deps.queryWikiSpaces.list(scopeOf(request)) };
  });

  app.get<{ Params: { id: string } }>('/wikis/:id', async (request) => {
    parse(wikiSearchQuerySchema, request.query);
    return { wiki: serializeWikiSpace(await deps.queryWikiSpaces.get(scopeOf(request), request.params.id)) };
  });

  app.post('/wikis', async (request, reply) => {
    const body = parse(saveWikiSpaceBodySchema, request.body);
    return reply.status(201).send({ wiki: serializeWikiSpace(await deps.saveWikiSpace.execute({ ...body, scope: scopeOf(request) })) });
  });

  app.delete<{ Params: { id: string } }>('/wikis/:id', async (request, reply) => {
    parse(scopeQuerySchema, request.query);
    await deps.deleteWikiSpace.execute(scopeOf(request), request.params.id);
    return reply.status(204).send();
  });

  app.get('/wiki', async (request) => {
    const query = parse(wikiSearchQuerySchema, request.query);
    const scope = scopeOf(request);
    const pages = query.q !== undefined
      ? await deps.queryWiki.search(scope, query.q, query.limit ?? 10, query.wikiId === undefined ? undefined : [query.wikiId])
      : await deps.queryWiki.list(scope, query.wikiId);
    return { pages };
  });

  app.get<{ Params: { id: string } }>('/wiki/:id', async (request) => {
    parse(wikiSearchQuerySchema, request.query);
    const page = await deps.queryWiki.get(scopeOf(request), request.params.id);
    return { page: serializeWikiPage(page) };
  });

  app.delete<{ Params: { id: string } }>('/wiki/:id', async (request, reply) => {
    parse(scopeQuerySchema, request.query);
    await deps.deleteWikiPage.execute(scopeOf(request), request.params.id);
    return reply.status(204).send();
  });

  app.post('/wiki', async (request, reply) => {
    const body = parse(saveWikiBodySchema, request.body);
    const page = await deps.saveWikiPage.execute({
      scope: scopeOf(request),
      ...(body.id !== undefined ? { id: body.id } : {}),
      ...(body.wikiId !== undefined ? { wikiId: body.wikiId } : {}),
      title: body.title,
      tags: body.tags,
      body: body.body,
      ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}),
    });
    return reply.status(201).send({ page: serializeWikiPage(page) });
  });

  app.get<{ Params: { wikiId: string } }>('/wikis/:wikiId/pages', async (request) => {
    const query = parse(wikiSearchQuerySchema, request.query);
    const scope = scopeOf(request);
    const pages = query.q === undefined ? await deps.queryWiki.list(scope, request.params.wikiId) : await deps.queryWiki.search(scope, query.q, query.limit ?? 10, [request.params.wikiId]);
    return { pages };
  });

  app.get<{ Params: { wikiId: string; id: string } }>('/wikis/:wikiId/pages/:id', async (request) => {
    parse(wikiSearchQuerySchema, request.query);
    const page = await deps.queryWiki.get(scopeOf(request), request.params.id);
    if ((page.wikiId ?? 'default') !== request.params.wikiId) throw new BadRequestError('wiki page does not belong to requested wiki');
    return { page: serializeWikiPage(page) };
  });

  app.post<{ Params: { wikiId: string } }>('/wikis/:wikiId/pages', async (request, reply) => {
    const body = parse(saveWikiBodySchema, request.body);
    const page = await deps.saveWikiPage.execute({ scope: scopeOf(request), ...(body.id !== undefined ? { id: body.id } : {}), wikiId: request.params.wikiId, title: body.title, tags: body.tags, body: body.body, ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}) });
    return reply.status(201).send({ page: serializeWikiPage(page) });
  });

  app.post('/memory/reflect', async (request) => {
    const body = parse(reflectRunBodySchema, request.body);
    const proposals = await deps.reflectRun.execute({
      scope: scopeOf(request),
      input: body.input,
      output: body.output,
      ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}),
      ...(body.targetSkillId !== undefined ? { targetSkillId: body.targetSkillId } : {}),
      ...(body.existingWikiPageId !== undefined ? { existingWikiPageId: body.existingWikiPageId } : {}),
      ...(body.targetWikiId !== undefined ? { targetWikiId: body.targetWikiId } : {}),
    });
    return { proposals: proposals.map(serializeMemoryProposal) };
  });

  app.get('/memory/proposals', async (request) => {
    const query = parse(proposalListQuerySchema, request.query);
    const proposals = await deps.listProposals.list(
      scopeOf(request),
      query.state,
    );
    return { proposals: proposals.map(serializeMemoryProposal) };
  });

  app.post<{ Params: { id: string } }>('/memory/proposals/:id/approve', async (request) => {
    parse(proposalDecisionBodySchema, request.body);
    const proposal = await deps.reviewProposal.approve(scopeOf(request), request.params.id);
    return { proposal: serializeMemoryProposal(proposal) };
  });

  app.post<{ Params: { id: string } }>('/memory/proposals/:id/reject', async (request) => {
    parse(proposalDecisionBodySchema, request.body);
    const proposal = await deps.reviewProposal.reject(scopeOf(request), request.params.id);
    return { proposal: serializeMemoryProposal(proposal) };
  });
}
