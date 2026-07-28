/** 未保存 Tool draft の検査・プレビュー HTTP routes。 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DraftToolUseCase } from '../application/tool/draft-tool';
import type { SuggestAnalysisConfigUseCase } from '../application/tool/suggest-analysis-config';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { analysisSuggestionBodySchema, draftInspectBodySchema, draftPreviewBodySchema } from './schemas';

export interface DraftToolRouteDeps {
  readonly draftTool: DraftToolUseCase;
  readonly suggestAnalysisConfig: SuggestAnalysisConfigUseCase;
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
    return { propagation: await deps.draftTool.inspect(body.graph, scopeOf(request)) };
  });

  app.post('/tool-drafts/preview', async (request) => {
    const body = parseWith(draftPreviewBodySchema, request.body);
    const result = await deps.draftTool.preview(
      body.graph,
      body.rowLimit === undefined ? undefined : { rowLimit: body.rowLimit },
      scopeOf(request),
    );
    return { result };
  });
  app.get('/runtime/capabilities', async () => ({ analysisAssistant: { enabled: await deps.suggestAnalysisConfig.available() } }));
  app.post('/tool-drafts/suggest-analysis-config', async (request) => {
    const body = parseWith(analysisSuggestionBodySchema, request.body);
    return { proposal: await deps.suggestAnalysisConfig.execute({ graph: body.graph, nodeId: body.nodeId, intent: body.intent }) };
  });
}
