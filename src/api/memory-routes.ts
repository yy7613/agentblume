/**
 * api層: 長期記憶ルート（v21 実装契約 §4 / ADR-0016）
 *
 * Wiki（宣言的知識）の参照・保存と、記憶提案（Run抽出→人手承認）の一覧・承認・却下。
 * 承認時のみ実体（Wiki改訂 / Skill蒸留）へ適用される（人手承認制）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { SaveWikiPageUseCase } from '../application/memory/save-wiki-page';
import type { QueryWikiUseCase } from '../application/memory/query-wiki';
import type { ReflectRunUseCase } from '../application/memory/reflect-run';
import type { ListProposalsUseCase } from '../application/memory/list-proposals';
import type { ReviewProposalUseCase } from '../application/memory/review-proposal';
import { serializeMemoryProposal } from '../domain/memory/serialization';
import { serializeWikiPage } from '../domain/memory/serialization';
import { BadRequestError } from './error-mapping';
import { proposalDecisionBodySchema, proposalListQuerySchema, reflectRunBodySchema, saveWikiBodySchema, wikiSearchQuerySchema } from './schemas';

export interface MemoryRouteDeps {
  readonly saveWikiPage: SaveWikiPageUseCase;
  readonly queryWiki: QueryWikiUseCase;
  readonly reflectRun: ReflectRunUseCase;
  readonly listProposals: ListProposalsUseCase;
  readonly reviewProposal: ReviewProposalUseCase;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  }
  return result.data as z.infer<S>;
}

export function registerMemoryRoutes(app: FastifyInstance, deps: MemoryRouteDeps): void {
  app.get('/wiki', async (request) => {
    const query = parse(wikiSearchQuerySchema, request.query);
    const scope = { tenantId: query.tenantId, workspaceId: query.workspaceId };
    const pages = query.q !== undefined
      ? await deps.queryWiki.search(scope, query.q, query.limit ?? 10)
      : await deps.queryWiki.list(scope);
    return { pages };
  });

  app.get<{ Params: { id: string } }>('/wiki/:id', async (request) => {
    const query = parse(wikiSearchQuerySchema, request.query);
    const page = await deps.queryWiki.get({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.id);
    return { page: serializeWikiPage(page) };
  });

  app.post('/wiki', async (request, reply) => {
    const body = parse(saveWikiBodySchema, request.body);
    const page = await deps.saveWikiPage.execute({
      scope: body.scope,
      ...(body.id !== undefined ? { id: body.id } : {}),
      title: body.title,
      tags: body.tags,
      body: body.body,
      ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}),
    });
    return reply.status(201).send({ page: serializeWikiPage(page) });
  });

  app.post('/memory/reflect', async (request) => {
    const body = parse(reflectRunBodySchema, request.body);
    const proposals = await deps.reflectRun.execute({
      scope: body.scope,
      input: body.input,
      output: body.output,
      ...(body.sourceRunId !== undefined ? { sourceRunId: body.sourceRunId } : {}),
      ...(body.targetSkillId !== undefined ? { targetSkillId: body.targetSkillId } : {}),
      ...(body.existingWikiPageId !== undefined ? { existingWikiPageId: body.existingWikiPageId } : {}),
    });
    return { proposals: proposals.map(serializeMemoryProposal) };
  });

  app.get('/memory/proposals', async (request) => {
    const query = parse(proposalListQuerySchema, request.query);
    const proposals = await deps.listProposals.list(
      { tenantId: query.tenantId, workspaceId: query.workspaceId },
      query.state,
    );
    return { proposals: proposals.map(serializeMemoryProposal) };
  });

  app.post<{ Params: { id: string } }>('/memory/proposals/:id/approve', async (request) => {
    const body = parse(proposalDecisionBodySchema, request.body);
    const proposal = await deps.reviewProposal.approve(body.scope, request.params.id);
    return { proposal: serializeMemoryProposal(proposal) };
  });

  app.post<{ Params: { id: string } }>('/memory/proposals/:id/reject', async (request) => {
    const body = parse(proposalDecisionBodySchema, request.body);
    const proposal = await deps.reviewProposal.reject(body.scope, request.params.id);
    return { proposal: serializeMemoryProposal(proposal) };
  });
}
