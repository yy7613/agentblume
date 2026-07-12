/** 未保存 Tool draft の検査・プレビュー HTTP routes。 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DraftToolUseCase } from '../application/tool/draft-tool';
import { BadRequestError } from './error-mapping';
import { draftInspectBodySchema, draftPreviewBodySchema } from './schemas';

export interface DraftToolRouteDeps {
  readonly draftTool: DraftToolUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new BadRequestError(`invalid body: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

export function registerDraftToolRoutes(app: FastifyInstance, deps: DraftToolRouteDeps): void {
  app.post('/tool-drafts/infer-schema', async (request) => {
    const body = parseWith(draftInspectBodySchema, request.body);
    return { propagation: await deps.draftTool.inspect(body.graph, body.scope) };
  });

  app.post('/tool-drafts/preview', async (request) => {
    const body = parseWith(draftPreviewBodySchema, request.body);
    const result = await deps.draftTool.preview(
      body.graph,
      body.rowLimit === undefined ? undefined : { rowLimit: body.rowLimit },
      body.scope,
    );
    return { result };
  });
}
