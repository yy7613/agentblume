/**
 * api層: モデル設定（main / judge の切替）ルート。
 *
 * `mcp-routes.ts` の `parseWith` パターンを踏襲する。設定は版を持たないため PUT は upsert。
 *
 * **秘密値の扱いが本ルートの要**である。
 * - 応答は常にマスク済みDTO（`apiKey: { configured, hint? }`）。封緘済みデータも返さない。
 * - apiKey は PUT / POST の body でのみ受ける（クエリ文字列では受けない = URLに残さない）。
 * - 疎通テストは設定の妥当性確認なので、失敗も 200 + `ok:false` で返す（HTTPエラーにしない）。
 */
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import type { GetModelSettingsUseCase, SaveModelSettingsUseCase } from '../application/model-settings/manage-model-settings';
import type { QueryModelCatalogUseCase } from '../application/model-settings/query-model-catalog';
import type { TestModelSettingsUseCase } from '../application/model-settings/test-model-settings';
import { BadRequestError } from './error-mapping';
import { modelSettingsQuerySchema, openAiCompatibleModelsQuerySchema, saveModelSettingsBodySchema, testModelSettingsBodySchema } from './schemas';

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

  app.post('/model-settings/test', async (request) => {
    const body = parseWith(testModelSettingsBodySchema, request.body, 'invalid body');
    return deps.testModelSettings.execute({
      scope: body.scope,
      slot: body.slot,
      ...(body.candidate === undefined ? {} : { candidate: body.candidate }),
    }, request.raw.signal);
  });

  // 登録簿はオフラインの静的データなのでスコープ非依存で返す。
  app.get('/model-catalog', async () => ({ providers: deps.queryModelCatalog.providers() }));

  app.get('/model-catalog/openai-compatible-models', async (request) => {
    const query = parseWith(openAiCompatibleModelsQuerySchema, request.query, 'invalid query');
    const models = await deps.queryModelCatalog.openAiCompatibleModels({
      scope: { tenantId: query.tenantId, workspaceId: query.workspaceId },
      baseUrl: query.baseUrl,
      ...(query.slot === undefined ? {} : { slot: query.slot }),
    }, request.raw.signal);
    return { models };
  });
}
