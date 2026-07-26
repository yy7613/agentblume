/**
 * エントリポイント（v4 実装契約 §6）— `npm run serve` で実行する。
 *
 * createApp（env 駆動: AGENTCONTEXT_PROFILE / AGENTCONTEXT_DB_PATH）で配線し、
 * buildServer で Fastify を組み立てて listen する。
 * SIGINT / SIGTERM で server.close() + app.close() のグレースフルシャットダウン。
 */
import { buildServer } from './api/server';
import { seedBuiltinTools } from './builtin-tools';
import { createApp } from './composition/root';
import { seedSampleData } from './sample-data';

// Mastra Evals(@mastra/core)同梱の外部テレメトリを無効化する（オフラインファースト）。
process.env['MASTRA_TELEMETRY_DISABLED'] ??= 'true';

const app = createApp();
const server = buildServer(app, { logger: true });
const port = Number(process.env['AGENTCONTEXT_PORT'] ?? 3030);

// 組み込みツールは環境変数に関係なく常に用意する（冪等）。
const builtin = await seedBuiltinTools(app);
server.log.info({ builtin }, 'builtin tools are ready');

if (process.env['AGENTCONTEXT_SAMPLE_DATA'] === 'true') {
  const sample = await seedSampleData(app);
  server.log.info({ sample }, 'manual sample data is ready');
}

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
  server.log.info(`agentblume API started (profile=${app.profile}, port=${port})`);
} catch (err) {
  server.log.error(err);
  app.close();
  process.exit(1);
}
