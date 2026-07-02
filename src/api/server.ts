/**
 * api層: buildServer — Fastify インスタンスの組み立て（v4 実装契約 §5）
 *
 * Fastify 生成 → setErrorHandler（toHttpError）→ registerToolRoutes →
 * GET /health を追加して返す。**listen はしない**（エントリポイント src/server.ts の責務）。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { toHttpError } from './error-mapping';
import { registerToolRoutes } from './tool-routes';
import type { ToolRouteDeps } from './tool-routes';

/** ルート・エラーハンドラ設定済みの Fastify インスタンスを組み立てる（listen しない）。 */
export function buildServer(
  deps: ToolRouteDeps,
  options?: { logger?: boolean },
): FastifyInstance {
  const app = Fastify({ logger: options?.logger ?? false });

  // ハンドラから throw された例外を §2 のマッピングで HTTP へ変換する。
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toHttpError(error);
    void reply.status(status).send(body);
  });

  registerToolRoutes(app, deps);

  // ヘルスチェック。
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
