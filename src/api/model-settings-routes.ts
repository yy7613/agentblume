/**
 * api層: モデル設定（main / judge の切替）ルート。
 *
 * `mcp-routes.ts` の `parseWith` パターンを踏襲する。設定は版を持たないため PUT は upsert。
 *
 * **秘密値の扱いが本ルートの要**である。
 * - 応答は常にマスク済みDTO（`apiKey: { configured, hint? }`）。封緘済みデータも返さない。
 * - apiKey は PUT / POST の body でのみ受ける（クエリ文字列では受けない = URLに残さない）。
 * - 疎通テストは設定の妥当性確認なので、疎通の失敗は 200 + `ok:false` で返す（入力不正は 400）。
 * - **保存済みキーを使い得る操作は GET にしない**。単純GETはクロスサイトの `<img>` から
 *   発火でき（応答を読めなくても副作用は起きる）、任意の宛先へキーを送らせる経路になるため、
 *   OpenAI互換のモデル一覧は POST + JSON body で受ける。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { GetModelSettingsUseCase, SaveModelSettingsUseCase } from '../application/model-settings/manage-model-settings';
import type { QueryModelCatalogUseCase } from '../application/model-settings/query-model-catalog';
import type { TestModelSettingsUseCase } from '../application/model-settings/test-model-settings';
import { clientAbortSignal } from './client-abort';
import { BadRequestError } from './error-mapping';
import { modelCatalogProviderParamsSchema, modelSettingsQuerySchema, openAiCompatibleModelsBodySchema, saveModelSettingsBodySchema, testModelSettingsBodySchema } from './schemas';

export interface ModelSettingsRouteDeps {
  readonly getModelSettings: GetModelSettingsUseCase;
  readonly saveModelSettings: SaveModelSettingsUseCase;
  readonly testModelSettings: TestModelSettingsUseCase;
  readonly queryModelCatalog: QueryModelCatalogUseCase;
}

function parseWith<S extends z.ZodType>(schema: S, value: unknown, label: string): z.infer<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestError(`${label}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
  return parsed.data as z.infer<S>;
}

export function registerModelSettingsRoutes(app: FastifyInstance, deps: ModelSettingsRouteDeps): void {
  app.get('/model-settings', async (request) => {
    const query = parseWith(modelSettingsQuerySchema, request.query, 'invalid query');
    return { settings: await deps.getModelSettings.execute(query) };
  });

  // スロット省略 = 変更なし、null = 設定を消して env 既定へ戻す。
  app.put('/model-settings', async (request) => {
    const body = parseWith(saveModelSettingsBodySchema, request.body, 'invalid body');
    return {
      settings: await deps.saveModelSettings.execute({
        scope: body.scope,
        ...(body.main === undefined ? {} : { main: body.main }),
        ...(body.judge === undefined ? {} : { judge: body.judge }),
      }),
    };
  });

  app.post('/model-settings/test', async (request, reply) => {
    const body = parseWith(testModelSettingsBodySchema, request.body, 'invalid body');
    return deps.testModelSettings.execute({
      scope: body.scope,
      slot: body.slot,
      ...(body.candidate === undefined ? {} : { candidate: body.candidate }),
    }, clientAbortSignal(request, reply));
  });

  // 登録簿はオフラインの静的データなのでスコープ非依存で返す。
  // 見出しだけを返し（軽量）、モデル一覧は選ばれたプロバイダぶんを個別に取る2段構成。
  app.get('/model-catalog', async () => ({ providers: deps.queryModelCatalog.providers() }));

  app.get('/model-catalog/:providerId/models', async (request) => {
    const params = parseWith(modelCatalogProviderParamsSchema, request.params, 'invalid params');
    const models = deps.queryModelCatalog.providerModels(params.providerId);
    if (models === undefined) throw new BadRequestError(`unknown model catalog provider: ${params.providerId}`);
    return { models };
  });

  // GET ではなく POST。保存済みキーを使い得る操作を単純リクエストにしない（CSRF緩和）。
  app.post('/model-catalog/openai-compatible-models', async (request, reply) => {
    const body = parseWith(openAiCompatibleModelsBodySchema, request.body, 'invalid body');
    return deps.queryModelCatalog.openAiCompatibleModels({
      scope: body.scope,
      baseUrl: body.baseUrl,
      ...(body.slot === undefined ? {} : { slot: body.slot }),
    }, clientAbortSignal(request, reply));
  });
}
