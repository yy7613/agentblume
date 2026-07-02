/**
 * エントリポイント（v4 実装契約 §6）— `npm run serve` で実行する。
 *
 * createApp（env 駆動: AGENTCONTEXT_PROFILE / AGENTCONTEXT_DB_PATH）で配線し、
 * buildServer で Fastify を組み立てて listen する。
 * SIGINT / SIGTERM で server.close() + app.close() のグレースフルシャットダウン。
 */
import { buildServer } from './api/server';
import { createApp } from './composition/root';

const app = createApp();
const server = buildServer(app, { logger: true });
const port = Number(process.env['AGENTCONTEXT_PORT'] ?? 3030);

/** シグナル受信時: HTTP を閉じ、リポジトリを解放して終了する。 */
async function shutdown(signal: string): Promise<void> {
  server.log.info(`received ${signal}, shutting down`);
  try {
    await server.close();
  } finally {
    app.close();
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await server.listen({ port, host: '127.0.0.1' });
  server.log.info(`AgentContext API started (profile=${app.profile}, port=${port})`);
} catch (err) {
  server.log.error(err);
  app.close();
  process.exit(1);
}
