/**
 * OpenTelemetry の実配線 — `AGENTCONTEXT_OTEL_ENABLED=true` のときだけ TracerProvider を登録する。
 *
 * ## なぜ必要だったか
 *
 * 計装（`agent.run` / `model.complete` / `tool.execute` / `evaluation.case` の span 生成）は
 * `adapters/telemetry/open-telemetry-adapter.ts` に実装済みで、`AGENTCONTEXT_OTEL_ENABLED=true` にすると
 * `createApp` はそちらを注入していた。しかし依存は `@opentelemetry/api` **だけ**で、SDKも exporter も
 * 初期化コードも無かった。`trace.getTracer()` は TracerProvider が未登録なら no-op を返すため、
 * フラグを立てても **span は1本も出ない**（しかもエラーにならないので気づけない）状態だった。
 * ここが「no-op を本物に差し替える」唯一の場所になる。
 *
 * ## なぜ「副作用だけのモジュール」にしないのか
 *
 * `src/mastra-runtime-env.ts` は import された時点で env を立てる副作用専用モジュールで、
 * エントリポイントの**最初の import** に置くことで評価順を ESM の言語仕様として固定している。
 * 同じ形をここで採ると壊れる。SDKの起動は非同期（`await import(...)`）なので top-level await が要り、
 * **ESM の兄弟モジュールは async な兄弟の完了を待たない**（実測: 同期モジュール B は、TLA を持つ
 * 兄弟 A より先に評価が完了する）。つまり「最初の import に置いたから fastify より先に起動している」
 * という保証は得られない。
 *
 * 代わりに `startTelemetry()` を公開し、`src/server.ts` の**本体の最初の文**で await する。
 * これは順序が言語仕様どおりに読める形であり、かつ十分でもある。この計装は自動計装
 * （モジュールの monkey-patch）を一切使わず手書きの span だけなので、必要なのは
 * 「**最初の span が作られる前に** provider が登録されていること」であり、`@opentelemetry/api` の
 * ProxyTracer は span 生成のたびに delegate を引き直す。`createApp()` より前に await していれば足りる。
 *
 * ## オフラインファースト
 *
 * 無効時は SDK パッケージを **import すらしない**（`await import()` を通らない）。
 * exporter は生成されず、バックグラウンドの送信タイマーも立たない。
 */
import { describeError } from './application/operations/logger';

/** exporter へ載せるサービス名（`service.name` リソース属性）。 */
export const OTEL_SERVICE_NAME = 'agentblume';

/** 起動済みテレメトリのハンドル。`enabled: false` のときも同じ形を返す（呼び出し側に分岐を作らない）。 */
export interface TelemetryRuntime {
  /** TracerProvider を登録したか。無効・初期化失敗のどちらでも `false`。 */
  readonly enabled: boolean;
  /** 未送信 span をフラッシュして停止する。無効時は何もしない。 */
  shutdown(): Promise<void>;
}

/**
 * SDK側で使う最小限の型。`@opentelemetry/*` の型をそのまま持ち込むと、
 * テストのfakeが実装詳細（`Resource` の内部構造など）まで満たす羽目になる。
 */
export interface LoadedTracerProvider {
  register(): void;
  shutdown(): Promise<void>;
}

/** `startTelemetry` が使うSDKの入口。テストはここを差し替えて実SDKを起動せずに検証する。 */
export interface TelemetrySdkLoader {
  (config: { readonly serviceName: string; readonly serviceVersion: string | undefined }): Promise<LoadedTracerProvider>;
}

/** 無効時（と初期化失敗時）に返すハンドル。 */
const DISABLED: TelemetryRuntime = { enabled: false, shutdown: async () => {} };

/**
 * 実SDKを読み込んで TracerProvider を組み立てる（**有効時にしか呼ばれない**）。
 *
 * exporter のエンドポイント・ヘッダ・プロトコルは OTel 標準env（`OTEL_EXPORTER_OTLP_ENDPOINT`、
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_HEADERS` …）に従う。
 * `@opentelemetry/sdk-trace-base` 側の `NodeTracerProvider` / `BatchSpanProcessor` は
 * これら `OTEL_*` の既定値解決を内蔵しているので、こちらで読み直さない
 * （読み直すと「SDKの解釈」と「アプリの解釈」が二重になり、片方だけ直す事故が起きる）。
 *
 * `export` しているのはテストのため。ここだけは fake で置き換えると意味が無く（SDKのAPIが変わっても
 * 気づけない）、実物を1回組み立てて壊れていないことを見る必要がある。
 */
export const loadOpenTelemetrySdk: TelemetrySdkLoader = async ({ serviceName, serviceVersion }) => {
  const [{ BatchSpanProcessor, NodeTracerProvider }, { OTLPTraceExporter }, { resourceFromAttributes }, { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION }] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);
  return new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      ...(serviceVersion === undefined ? {} : { [ATTR_SERVICE_VERSION]: serviceVersion }),
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
};

/** `startTelemetry` の差し替え口（テスト用）。 */
export interface StartTelemetryOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly load?: TelemetrySdkLoader;
  /** 初期化に失敗したときの通知先。既定は `console.warn`（この時点ではまだ Fastify のロガーが無い）。 */
  readonly onError?: (message: string) => void;
}

/**
 * OTel を（有効なら）起動する。**このプロセスで1回だけ**、`createApp()` より前に呼ぶ。
 *
 * 初期化に失敗しても throw しない。観測系の障害を業務へ伝播させないというコードベース共通の規律に従う
 * （エンドポイントの綴り間違いやSDKの読み込み失敗でサーバーが起動しないほうが害が大きい）。
 * ただし**黙って無効化はしない**。理由を1行出す。
 */
export async function startTelemetry(options: StartTelemetryOptions = {}): Promise<TelemetryRuntime> {
  const env = options.env ?? process.env;
  if (env['AGENTCONTEXT_OTEL_ENABLED'] !== 'true') return DISABLED;

  const load = options.load ?? loadOpenTelemetrySdk;
  const onError = options.onError ?? ((message: string) => { console.warn(message); });
  const revision = env['AGENTCONTEXT_SOURCE_REVISION'];
  try {
    const provider = await load({
      serviceName: OTEL_SERVICE_NAME,
      serviceVersion: revision === undefined || revision.trim() === '' ? undefined : revision,
    });
    provider.register();
    return {
      enabled: true,
      shutdown: async () => { await provider.shutdown(); },
    };
  } catch (error) {
    onError(`agentblume: OpenTelemetry の初期化に失敗したため trace を送信しません（${describeError(error)}）`);
    return DISABLED;
  }
}
