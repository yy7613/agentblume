import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { DeleteDataSourceUseCase, QueryDataSourcesUseCase, QueryDatabaseConnectionsUseCase, RegisterDatabaseDataSourceUseCase, SaveFileDataSourceUseCase } from '../application/data-source/manage-data-sources';
import type { WebSearchUseCase } from '../application/search/web-search';
import { BadRequestError } from './error-mapping';
import { dataSourceListQuerySchema, databaseConnectionTestBodySchema, registerDatabaseDataSourceBodySchema, saveFileDataSourceBodySchema, webSearchFetchBodySchema } from './schemas';

export interface DataSourceRouteDeps {
  readonly saveFileDataSource: SaveFileDataSourceUseCase;
  readonly registerDatabaseDataSource: RegisterDatabaseDataSourceUseCase;
  readonly queryDataSources: QueryDataSourcesUseCase;
  readonly deleteDataSource: DeleteDataSourceUseCase;
  readonly queryDatabaseConnections: QueryDatabaseConnectionsUseCase;
  readonly webSearch: WebSearchUseCase;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new BadRequestError(`invalid request: ${result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return result.data as z.infer<S>;
}

/** CSV/JSON payloadはserverで保持し、DBには接続IDだけを登録する。 */
export function registerDataSourceRoutes(app: FastifyInstance, deps: DataSourceRouteDeps): void {
  app.get('/data-sources', async (request) => {
    const query = parse(dataSourceListQuerySchema, request.query);
    return { sources: await deps.queryDataSources.list({ tenantId: query.tenantId, workspaceId: query.workspaceId }) };
  });

  app.get('/data-sources/connections', async () => ({ connections: deps.queryDatabaseConnections.list() }));

  // providerのキー・利用量・接続設定は返さず、設定済みproviderだけをUIへ公開する。
  app.get('/search-providers', async () => ({ providers: deps.webSearch.listProviders() }));

  app.post('/web-searches', async (request, reply) => {
    const body = parse(webSearchFetchBodySchema, request.body);
    const search = await deps.webSearch.fetch(body.scope, body);
    return reply.status(201).send({ search });
  });

  app.post('/data-sources/files', async (request, reply) => {
    const body = parse(saveFileDataSourceBodySchema, request.body);
    const source = await deps.saveFileDataSource.execute(body);
    return reply.status(201).send({ source });
  });

  app.post('/data-sources/databases', async (request, reply) => {
    const body = parse(registerDatabaseDataSourceBodySchema, request.body);
    const source = await deps.registerDatabaseDataSource.execute(body);
    return reply.status(201).send({ source });
  });

  app.post<{ Params: { connectionId: string } }>('/data-sources/connections/:connectionId/test', async (request) => {
    parse(databaseConnectionTestBodySchema, request.body);
    return { connection: await deps.queryDatabaseConnections.test(request.params.connectionId) };
  });

  app.delete<{ Params: { id: string } }>('/data-sources/:id', async (request, reply) => {
    const query = parse(dataSourceListQuerySchema, request.query);
    await deps.deleteDataSource.execute({ tenantId: query.tenantId, workspaceId: query.workspaceId }, request.params.id);
    return reply.status(204).send();
  });
}
