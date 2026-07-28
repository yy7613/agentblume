/**
 * api層: MCPクライアント（外部MCPサーバー接続設定）ルート。
 *
 * `factory-routes.ts` / `harness-routes.ts` の `parseWith` パターンを踏襲する。
 * 設定は版を持たないため、POST は upsert、PUT は標準 `mcpServers` ドキュメントによる一括置換。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DeleteMcpServerUseCase, ListMcpServersUseCase, ReplaceMcpServersUseCase, SaveMcpServerUseCase } from '../application/mcp/manage-mcp-servers';
import type { TestMcpServerUseCase } from '../application/mcp/test-mcp-server';
import type { McpServerConfig, McpTransportConfig } from '../domain/mcp/mcp-server';
import { serializeMcpServerConfig, type SerializedMcpServerConfig } from '../domain/mcp/serialization';
import { clientAbortSignal } from './client-abort';
import { scopeOf } from './authentication';
import { BadRequestError } from './error-mapping';
import { mcpServerListQuerySchema, replaceMcpServersBodySchema, saveMcpServerBodySchema, scopeQuerySchema, testMcpServerBodySchema } from './schemas';

export interface McpRouteDeps {
  readonly saveMcpServer: SaveMcpServerUseCase;
  readonly listMcpServers: ListMcpServersUseCase;
  readonly deleteMcpServer: DeleteMcpServerUseCase;
  readonly replaceMcpServers: ReplaceMcpServersUseCase;
  readonly testMcpServer: TestMcpServerUseCase;
}
interface McpServerParams { name: string }

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

function toDto(config: McpServerConfig): SerializedMcpServerConfig { return serializeMcpServerConfig(config); }

export function registerMcpRoutes(app: FastifyInstance, deps: McpRouteDeps): void {
  app.get('/mcp-servers', async (request) => {
    parseWith(mcpServerListQuerySchema, request.query, 'invalid query');
    return { servers: (await deps.listMcpServers.execute(scopeOf(request))).map(toDto) };
  });

  app.post('/mcp-servers', async (request, reply) => {
    const body = parseWith(saveMcpServerBodySchema, request.body, 'invalid body');
    const server = await deps.saveMcpServer.execute({
      scope: scopeOf(request),
      server: {
        name: body.server.name,
        transport: body.server.transport as McpTransportConfig,
        ...(body.server.disabled === undefined ? {} : { disabled: body.server.disabled }),
      },
    });
    return reply.status(201).send({ server: toDto(server) });
  });

  // JSONタブのApply。スコープ内の設定を丸ごと置き換える（標準 mcpServers ドキュメント互換）。
  app.put('/mcp-servers', async (request) => {
    const body = parseWith(replaceMcpServersBodySchema, request.body, 'invalid body');
    const servers = await deps.replaceMcpServers.execute(scopeOf(request), { mcpServers: body.mcpServers });
    return { servers: servers.map(toDto) };
  });

  app.delete<{ Params: McpServerParams }>('/mcp-servers/:name', async (request, reply) => {
    parseWith(scopeQuerySchema, request.query, 'invalid query');
    await deps.deleteMcpServer.execute(scopeOf(request), request.params.name);
    return reply.status(204).send();
  });

  // 接続テストは「設定が正しいか確かめる」機能なので、接続失敗も200で ok:false として返す
  // （HTTPエラーにすると、UIが通信障害と設定ミスを区別できなくなる）。
  app.post<{ Params: McpServerParams }>('/mcp-servers/:name/test', async (request, reply) => {
    parseWith(testMcpServerBodySchema, request.body, 'invalid body');
    return deps.testMcpServer.execute(scopeOf(request), request.params.name, clientAbortSignal(request, reply));
  });
}
