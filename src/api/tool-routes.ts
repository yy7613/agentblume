/**
 * api層: /tools ルート登録（v4 実装契約 §4）
 *
 * use case は注入で受ける（adapters/composition を import しない）。
 * ハンドラはドメイン例外をそのまま throw し、server.ts の setErrorHandler
 * （toHttpError）で HTTP へ変換する方式に統一する。
 *
 * | メソッド/パス | 成功 |
 * |---|---|
 * | POST /tools | 201 { tool } |
 * | GET /tools/:internalId | 200 { tool } |
 * | GET /tools/:internalId/versions | 200 { versions: string[] } |
 * | POST /tools/:internalId/infer-schema | 200 { tool, propagation } |
 * | POST /tools/:internalId/preview | 200 { tool, result } |
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { PreviewToolUseCase, PreviewToolOptions } from '../application/tool/preview-tool';
import type { GetToolUseCase, ListToolVersionsUseCase, ListToolsUseCase } from '../application/tool/query-tool';
import type { SaveToolUseCase } from '../application/tool/save-tool';
import { serializeTool } from '../domain/tool/serialization';
import { SemVer } from '../domain/tool/semver';
import { BadRequestError } from './error-mapping';
import { previewBodySchema, saveToolBodySchema, scopeQuerySchema, versionQuerySchema } from './schemas';

/** ルートが必要とする use case 群（Composition Root から注入される）。 */
export interface ToolRouteDeps {
  saveTool: SaveToolUseCase;
  getTool: GetToolUseCase;
  listToolVersions: ListToolVersionsUseCase;
  listTools: ListToolsUseCase;
  previewTool: PreviewToolUseCase;
}

/** :internalId パスパラメータ。 */
interface ToolParams {
  internalId: string;
}

/** Zod で検証し、失敗を BadRequestError（400 BAD_REQUEST）へ変換する。 */
function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
      .join('; ');
    throw new BadRequestError(`${label}: ${issues}`);
  }
  return parsed.data as z.infer<S>;
}

/** version 文字列を SemVer へ。不正 → BadRequestError。undefined はそのまま。 */
function parseVersion(version: string | undefined): SemVer | undefined {
  if (version === undefined) return undefined;
  try {
    return SemVer.parse(version);
  } catch {
    throw new BadRequestError(`invalid version string: "${version}"`);
  }
}

/** version / rowLimit から PreviewToolOptions を組み立てる。 */
function previewOptions(version: SemVer | undefined, rowLimit?: number): PreviewToolOptions {
  return {
    ...(version !== undefined ? { version } : {}),
    ...(rowLimit !== undefined ? { rowLimit } : {}),
  };
}

/** /tools 配下のルートを登録する（§4 の表に準拠）。 */
export function registerToolRoutes(app: FastifyInstance, deps: ToolRouteDeps): void {
  // GET /tools — workspace内の各Toolのlatest summary。
  app.get('/tools', async (request) => {
    const query = parseWith(scopeQuerySchema, request.query, 'invalid query');
    const tools = await deps.listTools.execute({ tenantId: query.tenantId, workspaceId: query.workspaceId });
    return { tools: tools.map((tool) => ({ ...tool, latestVersion: tool.latestVersion.toString() })) };
  });

  // POST /tools — 保存（検証・採番）→ 201。
  app.post('/tools', async (request, reply) => {
    const body = parseWith(saveToolBodySchema, request.body, 'invalid body');
    const tool = await deps.saveTool.execute({
      scope: body.scope,
      internalId: body.internalId,
      workingName: body.workingName,
      displayName: body.displayName,
      publishName: body.publishName,
      owner: body.owner,
      sideEffect: body.sideEffect,
      graph: body.graph,
      ...(body.inputSchema !== undefined ? { inputSchema: body.inputSchema } : {}),
      ...(body.outputSchema !== undefined ? { outputSchema: body.outputSchema } : {}),
      ...(body.agentTool !== undefined ? { agentTool: body.agentTool } : {}),
      ...(body.bump !== undefined ? { bump: body.bump } : {}),
      ...(body.state !== undefined ? { state: body.state } : {}),
    });
    return reply.status(201).send({ tool: serializeTool(tool) });
  });

  // GET /tools/:internalId — version 指定あり→そのバージョン / なし→latest。
  app.get<{ Params: ToolParams }>('/tools/:internalId', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const scope = { tenantId: query.tenantId, workspaceId: query.workspaceId };
    const version = parseVersion(query.version);
    const tool =
      version !== undefined
        ? await deps.getTool.version(scope, request.params.internalId, version)
        : await deps.getTool.latest(scope, request.params.internalId);
    return { tool: serializeTool(tool) };
  });

  // GET /tools/:internalId/versions — 昇順の文字列配列（未存在→[]）。
  app.get<{ Params: ToolParams }>('/tools/:internalId/versions', async (request) => {
    const query = parseWith(versionQuerySchema, request.query, 'invalid query');
    const scope = { tenantId: query.tenantId, workspaceId: query.workspaceId };
    const versions = await deps.listToolVersions.execute(scope, request.params.internalId);
    return { versions: versions.map((v) => v.toString()) };
  });

  // POST /tools/:internalId/infer-schema — スキーマ点検（実行なし）。
  app.post<{ Params: ToolParams }>('/tools/:internalId/infer-schema', async (request) => {
    const body = parseWith(previewBodySchema, request.body, 'invalid body');
    const version = parseVersion(body.version);
    const { tool, propagation } = await deps.previewTool.inspect(
      body.scope,
      request.params.internalId,
      previewOptions(version),
    );
    return { tool: serializeTool(tool), propagation };
  });

  // POST /tools/:internalId/preview — プレビュー実行（行数制限つき）。
  app.post<{ Params: ToolParams }>('/tools/:internalId/preview', async (request) => {
    const body = parseWith(previewBodySchema, request.body, 'invalid body');
    const version = parseVersion(body.version);
    const { tool, result } = await deps.previewTool.preview(
      body.scope,
      request.params.internalId,
      previewOptions(version, body.rowLimit),
    );
    return { tool: serializeTool(tool), result };
  });
}
