/**
 * api層: `POST /sample-data` — オンボーディング用サンプルデータの投入
 *
 * 空のスタジオで「何から触ればよいか分からない」状態を1クリックで抜けるための唯一のHTTP入口。
 * 冪等（既に投入済みなら何も作らない）なので、押し間違い・二重クリックで資産が増えることはない。
 * 投入済みかどうかは応答の `created`（今回作成した件数）で判別できる。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SampleDataSummary } from '../application/onboarding/seed-sample-data';
import { BadRequestError } from './error-mapping';

/** 投入ユースケース（composition が配線する）。 */
export interface SeedSampleDataPort {
  execute(scope: { readonly tenantId: string; readonly workspaceId: string }): Promise<SampleDataSummary>;
}

export interface SampleDataRouteDeps {
  readonly seedSampleData: SeedSampleDataPort;
}

/**
 * 他のルートと同じ `{ scope: { tenantId, workspaceId } }` 形。
 * schemas.ts へ足さずここで閉じているのは、この経路が他と共有する入力を持たないため。
 */
const seedSampleDataBodySchema = z.object({
  scope: z.object({ tenantId: z.string().min(1), workspaceId: z.string().min(1) }),
});

export function registerSampleDataRoutes(app: FastifyInstance, deps: SampleDataRouteDeps): void {
  app.post('/sample-data', async (request, reply) => {
    const parsed = seedSampleDataBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`).join('; ');
      throw new BadRequestError(`invalid body: ${issues}`);
    }
    const sample = await deps.seedSampleData.execute(parsed.data.scope);
    // 新規作成が無かった回も「既に揃っている」という成功なので 201 ではなく 200 を返す。
    return reply.status(200).send({ sample });
  });
}
