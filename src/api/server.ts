/**
 * api層: buildServer — Fastify インスタンスの組み立て（v4 実装契約 §5）
 *
 * Fastify 生成 → setErrorHandler（toHttpError）→ registerToolRoutes →
 * GET /health を追加して返す。**listen はしない**（エントリポイント src/server.ts の責務）。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { registerDraftToolRoutes } from './draft-tool-routes';
import type { DraftToolRouteDeps } from './draft-tool-routes';
import { toHttpError } from './error-mapping';
import { registerToolRoutes } from './tool-routes';
import type { ToolRouteDeps } from './tool-routes';
import { registerRunRoutes } from './run-routes';
import type { RunRouteDeps } from './run-routes';
import { registerAgentRoutes, type AgentRouteDeps } from './agent-routes';
import { registerSkillRoutes, type SkillRouteDeps } from './skill-routes';
import { registerValidationRoutes, type ValidationRouteDeps } from './validation-routes';
import { registerEvaluationRoutes, type EvaluationRouteDeps } from './evaluation-routes';
import { registerMemoryRoutes, type MemoryRouteDeps } from './memory-routes';
import { registerEvaluationAssetRoutes, type EvaluationAssetRouteDeps } from './evaluation-asset-routes';
import { registerExperimentRoutes, type ExperimentRouteDeps } from './experiment-routes';
import { registerQualityGateRoutes, type QualityGateRouteDeps } from './quality-gate-routes';
import { registerOperationsRoutes, type OperationsRouteDeps } from './operations-routes';
import { registerSessionRoutes, type SessionRouteDeps } from './session-routes';
import { registerDataSourceRoutes, type DataSourceRouteDeps } from './data-source-routes';
import { registerHarnessRoutes, type HarnessRouteDeps } from './harness-routes';
import { registerHarnessRunRoutes, type HarnessRunRouteDeps } from './harness-run-routes';
import { registerFactoryRoutes, type FactoryRouteDeps } from './factory-routes';
import { registerMcpRoutes, type McpRouteDeps } from './mcp-routes';

/** ルート・エラーハンドラ設定済みの Fastify インスタンスを組み立てる（listen しない）。 */
export function buildServer(
  deps: ToolRouteDeps & DraftToolRouteDeps & RunRouteDeps & AgentRouteDeps & HarnessRouteDeps & HarnessRunRouteDeps & SkillRouteDeps & ValidationRouteDeps & EvaluationRouteDeps & EvaluationAssetRouteDeps & ExperimentRouteDeps & QualityGateRouteDeps & MemoryRouteDeps & OperationsRouteDeps & SessionRouteDeps & DataSourceRouteDeps & FactoryRouteDeps & McpRouteDeps,
  options?: { logger?: boolean },
): FastifyInstance {
  // チャットの画像（最大2枚・各3 MiB）はBase64化で合計約8 MiBになる。
  // JSONのメタデータ分も含めて受理できるよう、10 MiBまで許可する。
  const app = Fastify({ logger: options?.logger ?? false, bodyLimit: 10 * 1024 * 1024 });

  // ハンドラから throw された例外を §2 のマッピングで HTTP へ変換する。
  app.setErrorHandler((error, _request, reply) => {
    const { status, body } = toHttpError(error);
    void reply.status(status).send(body);
  });

  registerToolRoutes(app, deps);
  registerDraftToolRoutes(app, deps);
  registerRunRoutes(app, deps);
  registerAgentRoutes(app, deps);
  registerHarnessRoutes(app, deps);
  registerHarnessRunRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerValidationRoutes(app, deps);
  registerEvaluationRoutes(app, deps);
  registerEvaluationAssetRoutes(app, deps);
  registerExperimentRoutes(app, deps);
  registerQualityGateRoutes(app, deps);
  registerMemoryRoutes(app, deps);
  registerOperationsRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerDataSourceRoutes(app, deps);
  registerFactoryRoutes(app, deps);
  registerMcpRoutes(app, deps);

  // ヘルスチェック。
  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
