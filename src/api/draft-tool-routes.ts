/** 未保存 Tool draft の検査・プレビュー HTTP routes。 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DiagnoseToolUseCase } from '../application/tool/diagnose-tool';
import type { DraftToolUseCase } from '../application/tool/draft-tool';
import type { SuggestAnalysisConfigUseCase } from '../application/tool/suggest-analysis-config';
import { SemVer } from '../domain/tool/semver';
import { createTool } from '../domain/tool/tool';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { analysisSuggestionBodySchema, draftInspectBodySchema, draftPreviewBodySchema, saveToolBodySchema } from './schemas';

export interface DraftToolRouteDeps {
  readonly draftTool: DraftToolUseCase;
  readonly suggestAnalysisConfig: SuggestAnalysisConfigUseCase;
  readonly diagnoseTool: DiagnoseToolUseCase;
}

/** 未保存 draft を表す版。採番は保存時に決まるので、診断結果にはこの値が「未保存」の印として載る。 */
const DRAFT_TOOL_VERSION = SemVer.of(0, 0, 0);

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
  // 未保存 Tool のプリフライト診断。POST /tools と同じ body を受け、保存と同じ createTool 検証を
  // 通した Tool を検査する（保存も採番もしない）。
  app.post('/tool-drafts/diagnose', async (request) => {
    const body = parseWith(saveToolBodySchema, request.body);
    const scope = scopeOf(request);
    const tool = createTool({
      metadata: {
        internalId: body.internalId, workingName: body.workingName, displayName: body.displayName,
        publishName: body.publishName, version: DRAFT_TOOL_VERSION, owner: body.owner,
        state: body.state ?? 'draft', tenant: scope,
      },
      sideEffect: body.sideEffect,
      graph: body.graph,
      ...(body.inputSchema !== undefined ? { inputSchema: body.inputSchema } : {}),
      ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
      ...(body.agentTool !== undefined ? { agentTool: body.agentTool } : {}),
    });
    return { diagnostics: await deps.diagnoseTool.execute(scope, tool) };
  });
  app.get('/runtime/capabilities', async () => ({ analysisAssistant: { enabled: await deps.suggestAnalysisConfig.available() } }));
  app.post('/tool-drafts/suggest-analysis-config', async (request) => {
    const body = parseWith(analysisSuggestionBodySchema, request.body);
    return { proposal: await deps.suggestAnalysisConfig.execute({ graph: body.graph, nodeId: body.nodeId, intent: body.intent }) };
  });
}
