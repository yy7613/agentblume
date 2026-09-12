/**
 * api層: ツール検証（Tool Check）のルート。
 *
 * | ルート | 応答 |
 * |---|---|
 * | POST /tool-checks/run | 200 { result } — 保存せずに単体実行（実行失敗も 200 で status: 'error'） |
 * | GET /tool-checks/cases?toolId | 200 { cases }（新しい定義が先） |
 * | POST /tool-checks/cases | 200 { case } — id 省略で新規、指定で上書き |
 * | DELETE /tool-checks/cases/:id | 204 |
 * | POST /tool-checks/cases/:id/run | 200 { case, result } |
 * | POST /tool-checks/cases/run-all | 200 { results } — 逐次実行・error でも続ける |
 * | POST /tool-checks/suggest | 200 { suggestions } — LLM による 正常 / 境界 / 異常 のケース案（保存しない。モデル未設定は 502） |
 *
 * 応答の `case` は永続化用の Serialized から scope を除いた形（scope は Principal 由来で、
 * クライアントは自分のスコープしか見られないため返す意味が無い）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DeleteToolCheckCaseUseCase, ListToolCheckCasesUseCase, SaveToolCheckCaseUseCase } from '../application/tool-check/manage-tool-check-cases';
import type { RunToolCheckUseCase } from '../application/tool-check/run-tool-check';
import type { RunToolCheckCaseUseCase, ToolCheckCaseRun } from '../application/tool-check/run-tool-check-case';
import type { SuggestToolCheckCasesUseCase } from '../application/tool-check/suggest-tool-check-cases';
import { ModelProviderError } from '../application/model/model-provider';
import { serializeToolCheckCase, type SerializedToolCheckCase } from '../domain/tool-check/serialization';
import type { ToolCheckCase } from '../domain/tool-check/tool-check-case';
import { SemVer } from '../domain/tool/semver';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { runAllToolCheckCasesBodySchema, runToolCheckBodySchema, saveToolCheckCaseBodySchema, suggestToolCheckCasesBodySchema, toolCheckCaseActionBodySchema, toolCheckCaseListQuerySchema } from './schemas';

export interface ToolCheckRouteDeps {
  readonly runToolCheck: RunToolCheckUseCase;
  readonly saveToolCheckCase: SaveToolCheckCaseUseCase;
  readonly listToolCheckCases: ListToolCheckCasesUseCase;
  readonly deleteToolCheckCase: DeleteToolCheckCaseUseCase;
  readonly runToolCheckCase: RunToolCheckCaseUseCase;
  readonly suggestToolCheckCases: SuggestToolCheckCasesUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

function version(value: string | undefined): SemVer | undefined {
  if (value === undefined) return undefined;
  try { return SemVer.parse(value); } catch { throw new BadRequestError(`invalid version string: "${value}"`); }
}

/** API 応答用のケース表現（scope 抜き）。 */
export function toolCheckCaseResponse(item: ToolCheckCase): Omit<SerializedToolCheckCase, 'scope'> {
  const { scope: _scope, ...rest } = serializeToolCheckCase(item);
  return rest;
}

function caseRunResponse(run: ToolCheckCaseRun) {
  return { case: toolCheckCaseResponse(run.case), result: run.result };
}

export function registerToolCheckRoutes(app: FastifyInstance, deps: ToolCheckRouteDeps): void {
  app.post('/tool-checks/run', async (request) => {
    const body = parseWith(runToolCheckBodySchema, request.body, 'invalid body');
    const requested = version(body.version);
    const result = await deps.runToolCheck.execute({
      scope: scopeOf(request), toolId: body.toolId, ...(requested === undefined ? {} : { version: requested }),
      arguments: body.arguments,
      ...(body.expectations === undefined ? {} : { expectations: body.expectations }),
      ...(body.rowLimit === undefined ? {} : { rowLimit: body.rowLimit }),
    });
    return { result };
  });

  app.get('/tool-checks/cases', async (request) => {
    const query = parseWith(toolCheckCaseListQuerySchema, request.query, 'invalid query');
    const cases = await deps.listToolCheckCases.execute(scopeOf(request), query.toolId === undefined ? undefined : { toolId: query.toolId });
    return { cases: cases.map(toolCheckCaseResponse) };
  });

  app.post('/tool-checks/cases', async (request) => {
    const body = parseWith(saveToolCheckCaseBodySchema, request.body, 'invalid body');
    const saved = await deps.saveToolCheckCase.execute({
      scope: scopeOf(request),
      ...(body.id === undefined ? {} : { id: body.id }),
      toolId: body.toolId,
      ...(body.toolVersion === undefined ? {} : { toolVersion: body.toolVersion }),
      name: body.name,
      arguments: body.arguments,
      expectations: body.expectations,
    });
    return { case: toolCheckCaseResponse(saved) };
  });

  app.delete<{ Params: { id: string } }>('/tool-checks/cases/:id', async (request, reply) => {
    await deps.deleteToolCheckCase.execute(scopeOf(request), request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/tool-checks/cases/:id/run', async (request) => {
    parseWith(toolCheckCaseActionBodySchema, request.body, 'invalid body');
    return caseRunResponse(await deps.runToolCheckCase.execute(scopeOf(request), request.params.id));
  });

  app.post('/tool-checks/cases/run-all', async (request) => {
    const body = parseWith(runAllToolCheckCasesBodySchema, request.body, 'invalid body');
    const runs = await deps.runToolCheckCase.runAll(scopeOf(request), body.toolId === undefined ? undefined : { toolId: body.toolId });
    return { results: runs.map(caseRunResponse) };
  });

  app.post('/tool-checks/suggest', async (request) => {
    const body = parseWith(suggestToolCheckCasesBodySchema, request.body, 'invalid body');
    const requested = version(body.version);
    // 未設定は 502（ModelProviderError の既存対応）。Tool の 404 より先に判定して、モデル無しで Tool を読みに行かない。
    if (!await deps.suggestToolCheckCases.available()) throw new ModelProviderError('tool check suggestions are not configured');
    const suggestions = await deps.suggestToolCheckCases.execute({
      scope: scopeOf(request), toolId: body.toolId, ...(requested === undefined ? {} : { version: requested }),
      ...(body.perCategory === undefined ? {} : { perCategory: body.perCategory }),
      ...(body.focus === undefined ? {} : { focus: body.focus }),
    });
    return { suggestions };
  });
}
