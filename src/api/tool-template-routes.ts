/**
 * api層: ツールテンプレート（外部ファイル）の HTTP routes（v43 実装契約 §5 / ADR-0049）。
 *
 * | メソッド/パス | 成功 | 認可 |
 * |---|---|---|
 * | GET /tool-templates | 200 { templates, invalid } | read / tool |
 * | POST /tool-templates/:id/slot-candidates | 200 { templateId, version, candidates, arguments } | read / tool |
 * | POST /tool-templates/:id/instantiate | 200 { template, graph, inputSchema?, agentTool, pendingExpressions } | execute / tool |
 *
 * 実体化はデータソースを読み、設計時プレビューまで走らせる（手で組んだ Tool と同じ検査）ので、
 * `/tool-drafts/diagnose` と同じ `execute` を要求する。候補は読み取りだけなので `read`。
 *
 * 保存はしない。返すのはツール作成画面のキャンバスへ展開するためのグラフである。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type {
  InstantiateToolTemplateUseCase,
  ListToolTemplatesUseCase,
  TemplateSlotCandidatesUseCase,
} from '../application/tool-template/template-use-cases';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { scopeQuerySchema, toolTemplateCandidatesBodySchema, toolTemplateInstantiateBodySchema } from './schemas';

export interface ToolTemplateRouteDeps {
  readonly listToolTemplates: ListToolTemplatesUseCase;
  readonly templateSlotCandidates: TemplateSlotCandidatesUseCase;
  readonly instantiateToolTemplate: InstantiateToolTemplateUseCase;
}

/** :id パスパラメータ（テンプレートの id）。 */
interface TemplateParams {
  id: string;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? '(root)' : issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new BadRequestError(`${label}: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

export function registerToolTemplateRoutes(app: FastifyInstance, deps: ToolTemplateRouteDeps): void {
  // 読めたテンプレートと、読めなかったファイル（理由と直し方つき）を一緒に返す。
  app.get('/tool-templates', async (request) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    return deps.listToolTemplates.execute();
  });

  // スロットごとの候補。`values`（部分でよい）に依存する候補はそれに合わせて絞られる。
  app.post<{ Params: TemplateParams }>('/tool-templates/:id/slot-candidates', async (request) => {
    const body = parseWith(toolTemplateCandidatesBodySchema, request.body, 'invalid body');
    return deps.templateSlotCandidates.execute({
      scope: scopeOf(request),
      templateId: request.params.id,
      dataSourceIds: body.dataSourceIds,
      ...(body.values === undefined ? {} : { values: body.values }),
      ...(body.language === undefined ? {} : { language: body.language }),
    });
  });

  // 実体化（保存はしない）。スロット違反は 422 + スロット名つきで返る（error-mapping）。
  app.post<{ Params: TemplateParams }>('/tool-templates/:id/instantiate', async (request) => {
    const body = parseWith(toolTemplateInstantiateBodySchema, request.body, 'invalid body');
    return deps.instantiateToolTemplate.execute({
      scope: scopeOf(request),
      templateId: request.params.id,
      dataSourceIds: body.dataSourceIds,
      values: body.values,
      language: body.language ?? 'ja',
      toolName: body.toolName,
      ...(body.argumentNullability === undefined ? {} : { argumentNullability: body.argumentNullability }),
    });
  });
}
