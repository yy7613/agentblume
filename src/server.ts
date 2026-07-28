/**
 * エントリポイント（v4 実装契約 §6）
 *
 * - 開発: `npm run serve`（tsx で TypeScript を直接実行）
 * - 本番: `npm run build` → `npm start`（`dist/server/server.js` を node が直接実行）
 *
 * 起動時にまず **全 env をまとめて検証**し（不正なら何が不正かを並べて exit 1）、
 * createApp で配線し、buildServer で Fastify を組み立てて listen する。
 * ビルド済みUI（`dist/ui`）が見つかれば同じポートから配信する（開発時は Vite が 5173 で配信するので使わない）。
 * SIGINT / SIGTERM で server.close() + app.close() のグレースフルシャットダウン。
 */
// Mastra 用 env（テレメトリ無効化・オフライン）を最初に確定させる。
// import は記述順に評価されるため、この行は @mastra を辿る import より必ず前に置く（並べ替え禁止）。
import './mastra-runtime-env';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildServer } from './api/server';
import { seedBuiltinTools } from './builtin-tools';
import { LOOPBACK_HOST_NAMES } from './api/host-check';
import { EnvironmentValidationError, isLoopbackHost, serverSettings, validateEnvironment, type ServerSettings } from './config/environment';
import { createAuthentication, createAuthorization } from './composition/authentication';
import { createApp } from './composition/root';
import type { LoggerPort } from './application/operations/logger';
import { RetentionScheduler } from './application/operations/retention-scheduler';
import { startTelemetry } from './otel-runtime';
import { seedSampleData } from './sample-data';

/** env を検証して起動設定へまとめる。1件でも不正なら理由を並べて起動しない。 */
function loadSettings(): ServerSettings {
  try {
    return serverSettings(validateEnvironment());
  } catch (error) {
    if (!(error instanceof EnvironmentValidationError)) throw error;
    console.error(`agentblume: ${error.message}`);
    console.error('agentblume: .env または環境変数を修正してから再実行してください（全項目の説明は .env.example）。');
    process.exit(1);
  }
}

/**
 * ビルド済みUIの場所を決める。
 *
 * 探すのは**自分がビルド成果物として動いているとき**だけ（`dist/server/server.js` → 隣の `dist/ui`）。
 * `npm run serve`（`src/server.ts` を tsx で実行）では `src/../ui` を見て空振りするので、
 * 開発時は従来どおりUIを配信しない。開発中に古い `dist/ui` を掴むと、ソースを直しても画面が変わらず
 * Vite開発サーバー（5173）との違いに気づけなくなる。
 * `AGENTCONTEXT_UI_ROOT` を明示したときは探索せず、そこに無ければ「UI無し」として扱う（別のUIを黙って配らない）。
 */
function resolveUiRoot(override: string | undefined): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const candidate = override === undefined ? resolve(here, '..', 'ui') : resolve(override);
  return existsSync(join(candidate, 'index.html')) ? candidate : undefined;
}

const settings = loadSettings();

/**
 * OTel の TracerProvider を登録する（`AGENTCONTEXT_OTEL_ENABLED=true` のときだけ）。
 *
 * **`createApp()` より前**であることに意味がある。`createApp` が組み立てる `OpenTelemetryAdapter` は
 * この時点で tracer を取得するが、その先の span 生成は実行時なので、ここで登録が済んでいれば
 * 最初の span から本物の provider に載る。無効時はSDKパッケージを import すらしない
 * （オフラインファースト：exporter も送信タイマーも作らない）。詳細は `src/otel-runtime.ts`。
 */
const telemetry = await startTelemetry();

const app = createApp();
const uiRoot = resolveUiRoot(settings.uiRootOverride);
/**
 * 認証は**必ず**明示的に渡す。`buildServer` の省略時既定（単一ユーザー）に暗黙で頼ると、
 * 配線の抜けが「無認証で公開されている」という形でしか現れない。
 */
const authentication = createAuthentication(settings.authentication, settings.scope);
/**
 * 認可と監査も明示的に渡す。`buildServer` の既定はテスト・埋め込み用の最小形で、
 * 監査に至っては**省略すると1行も残らない**。本番経路で暗黙に頼らない。
 */
/**
 * ループバックへバインドしているときだけ `Host` を縛る（DNSリバインディング対策）。
 *
 * この構成では認証が無いこともあり、そのとき `Host` が唯一の識別子になる。
 * 非ループバック（＝認証必須）では、`Host` は運用者が付けたホスト名やLBのIPになり得るので
 * 検査しない — そこでの識別はトークンが担う。
 */
const hostCheck = isLoopbackHost(settings.host) ? { allowedHosts: LOOPBACK_HOST_NAMES } : undefined;

const server = buildServer(app, {
  logger: { level: settings.logLevel },
  authentication,
  authorization: createAuthorization(),
  ...(hostCheck === undefined ? {} : { hostCheck }),
  audit: { sink: app.auditSink, fallbackScope: settings.scope },
  ...(uiRoot === undefined ? {} : { uiRoot }),
  ...(settings.revision === undefined ? {} : { revision: settings.revision }),
  // DBは必須依存。読み取りが1本通ることを readiness の条件にする。
  readiness: [{ name: 'database', probe: async () => { await app.repo.list(settings.scope); } }],
});

// 組み込みツールは環境変数に関係なく常に用意する（冪等）。
const builtin = await seedBuiltinTools(app);
server.log.info({ builtin }, 'builtin tools are ready');

/** 起動後の運用ログはFastify（pino）へ流す。`LoggerPort` はapplication層のPortなのでここで橋渡しする。 */
const runtimeLogger: LoggerPort = {
  info: (message, context) => { server.log.info(context ?? {}, message); },
  warn: (message, context) => { server.log.warn(context ?? {}, message); },
  error: (message, context) => { server.log.error(context ?? {}, message); },
};

/**
 * 孤児Runの回収。**listen より前**に行う。
 *
 * ワーカーのキューはメモリ内なので、前のプロセスが持っていたジョブは全て消えている一方、
 * DBには `queued` / `running` のRunが残る。ここで `running` を終端させ（retry/resume可能にする）、
 * `queued` をワーカーへ戻す。リクエストを受け始めたあとに走らせると、回収前のRunを利用者が
 * 「実行中」と誤認したまま操作してしまう。
 */
const recovered = await app.recoverInterruptedRuns.execute();
server.log.info(recovered, 'interrupted runs recovered');

/**
 * v36以前に平文で保存されたMCPの資格情報（env / headers）を封緘し直す。
 *
 * 読み出し側は平文を受け入れるので放っておいても動くが、それでは**誰も編集しない設定の
 * 資格情報がディスク上に平文で残り続ける**。べき等なので毎回走らせてよい（件数0で即終わる）。
 * サーバー名も値もログへ出さない。
 */
const resealedMcpSecrets = await app.resealMcpSecrets();
if (resealedMcpSecrets > 0) server.log.info({ count: resealedMcpSecrets }, 'MCP server credentials were re-encrypted at rest');

/**
 * retentionの定期実行。初回は1インターバル後（起動のたびに重い削除が走らないように）。
 * `AGENTCONTEXT_RETENTION_INTERVAL_MS=0` で無効化できる。
 */
const retentionScheduler = new RetentionScheduler(app.retention, {
  intervalMs: settings.retentionIntervalMs,
  scopes: [settings.scope],
  logger: runtimeLogger,
});
if (retentionScheduler.start()) server.log.info({ intervalMs: settings.retentionIntervalMs }, 'retention scheduler started');
else server.log.info('retention scheduler is disabled (AGENTCONTEXT_RETENTION_INTERVAL_MS=0)');

if (settings.sampleData) {
  const sample = await seedSampleData(app);
  server.log.info({ sample }, 'manual sample data is ready');
}

/** 1回目のシグナルで graceful shutdown に入ったか。2回目は待たずに落とすための判定に使う。 */
let shuttingDown = false;

/**
 * シグナル受信時: HTTP を閉じ、実行中ジョブを猶予つきで待ち、リポジトリを解放して終了する。
 *
 * 順序に意味がある。
 * 1. `server.close()` — 新規接続を止め、処理中のHTTPリクエストを終わらせる。
 * 2. `app.drainWorkers()` — ワーカーの新規受付を止め、**実行中のジョブ**を最大 `shutdownGraceMs` 待つ。
 *    以前はここが無く、`app.close()` が実行中のジョブを即 abort してキューごと捨てていた
 *    （`Ctrl+C` が「進行中の実験・Factory Runを捨てる」操作になっていた）。
 *    キューはメモリ内なので、abort されたジョブの途中経過は失われる（次回起動時に
 *    `recoverInterruptedRuns` が終端へ確定させ、retry / resume で流し直せる）。待てる分だけ待つ。
 * 3. `mcpClient.close()` — stdio接続は子プロセスを抱えるため、process.exit で孤児にしないよう先に待って閉じる。
 * 4. `app.close()` — DBハンドル等の解放（ワーカーへの最終 abort も兼ねる）。
 *
 * これらの前に retention の定期実行タイマーを止める（`unref()` 済みなので終了は妨げないが、
 * shutdown の最中に数万行のDELETEを始めさせない）。
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // 猶予が長すぎる／ジョブが止まらないときに、利用者が2回目のCtrl+Cで即座に降りられるようにする。
    server.log.warn(`received ${signal} again, forcing immediate exit`);
    process.exit(1);
  }
  shuttingDown = true;
  server.log.info({ graceMs: settings.shutdownGraceMs }, `received ${signal}, shutting down`);
  // 掃除は次回起動時にやり直せる。shutdown中に重い削除を始めさせない。
  retentionScheduler.stop();
  try {
    await server.close();
    const drained = await app.drainWorkers(settings.shutdownGraceMs);
    if (!drained) server.log.warn({ graceMs: settings.shutdownGraceMs }, 'in-flight jobs did not finish within the grace period and were aborted');
  } finally {
    try { await app.mcpClient.close(); } catch (err) { server.log.warn({ err }, 'failed to close MCP connections'); }
    app.close();
    // 未送信の span をフラッシュしてから降りる。BatchSpanProcessor は既定で5秒ためてから送るので、
    // これが無いと「落ちる直前の実行」の trace が丸ごと消える（障害調査で一番見たいところ）。
    try { await telemetry.shutdown(); } catch (err) { server.log.warn({ err }, 'failed to flush OpenTelemetry spans'); }
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await server.listen({ port: settings.port, host: settings.host });
  server.log.info(
    {
      profile: app.profile,
      port: settings.port,
      host: settings.host,
      database: app.dbPath ?? 'in-memory',
      ui: uiRoot ?? 'disabled (use the Vite dev server)',
      shutdownGraceMs: settings.shutdownGraceMs,
      retentionIntervalMs: settings.retentionIntervalMs,
      logLevel: settings.logLevel,
      telemetry: telemetry.enabled ? 'opentelemetry' : 'disabled',
      authentication: settings.authentication.mode,
      ...(settings.authentication.mode === 'token' ? { authenticatedSubjects: settings.authentication.tokens.length } : {}),
    },
    'agentblume API started',
  );
  /**
   * 単一ユーザーモードは「誰でも既定テナントの全データを触れる」状態なので、
   * 稼働中であることを1行で明言する（バインド先がループバックであることは検証済み）。
   */
  if (settings.authentication.mode === 'single-user') {
    server.log.warn(
      { scope: settings.scope },
      `agentblume is running in SINGLE-USER mode: requests are not authenticated (bound to ${settings.host}). `
      + 'Set AGENTCONTEXT_AUTH_TOKENS before sharing this instance.',
    );
  }
} catch (err) {
  server.log.error(err);
  app.close();
  await telemetry.shutdown();
  process.exit(1);
}
