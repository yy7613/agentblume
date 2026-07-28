/**
 * OTel 配線のテスト（`src/otel-runtime.ts`）。
 *
 * ここで守りたいのは2つ。
 *
 * 1. **無効時に何も起きない**こと。オフラインファーストの土台なので、フラグを立てていないのに
 *    SDKが読み込まれたり exporter がバックグラウンドで送信を始めたりしてはいけない。
 * 2. **有効時に本当に provider が登録され、shutdown でフラッシュされる**こと。
 *    以前は `AGENTCONTEXT_OTEL_ENABLED=true` にしても span が1本も出なかった（provider 未登録）ので、
 *    「有効にしたのに何も出ない」を二度と静かに起こさない。
 *
 * exporter への実送信は検証しない（テストでネットワークへ出ない方針）。SDKローダーを差し替えて
 * 「呼ばれたか・register されたか・shutdown が伝わるか」を見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTEL_SERVICE_NAME, loadOpenTelemetrySdk, startTelemetry, type LoadedTracerProvider, type TelemetrySdkLoader } from './otel-runtime';

/** register / shutdown の呼ばれ方を記録する TracerProvider の代役。 */
function fakeProvider(): LoadedTracerProvider & { registered: number; stopped: number } {
  const provider = {
    registered: 0,
    stopped: 0,
    register: () => { provider.registered += 1; },
    shutdown: async () => { provider.stopped += 1; },
  };
  return provider;
}

describe('startTelemetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('AGENTCONTEXT_OTEL_ENABLED 未設定ならSDKを読み込まない（オフラインファースト）', async () => {
    const load = vi.fn<TelemetrySdkLoader>();
    const runtime = await startTelemetry({ env: {}, load });

    expect(load).not.toHaveBeenCalled();
    expect(runtime.enabled).toBe(false);
  });

  it(`'false' や他の値では有効化しない（'true' 以外は全て無効）`, async () => {
    const load = vi.fn<TelemetrySdkLoader>();
    for (const value of ['false', 'TRUE', '1', 'yes', '']) {
      const runtime = await startTelemetry({ env: { AGENTCONTEXT_OTEL_ENABLED: value }, load });
      expect(runtime.enabled).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('無効時の shutdown は何もせず解決する（呼び出し側に分岐を作らせない）', async () => {
    const runtime = await startTelemetry({ env: {}, load: vi.fn<TelemetrySdkLoader>() });
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('無効時はネットワークへ出ない（fetch が1度も呼ばれない）', async () => {
    const fetchSpy = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchSpy);

    const runtime = await startTelemetry({ env: { AGENTCONTEXT_SOURCE_REVISION: 'abc123' }, load: vi.fn<TelemetrySdkLoader>() });
    await runtime.shutdown();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it(`'true' なら provider を組み立てて register する`, async () => {
    const provider = fakeProvider();
    const load = vi.fn<TelemetrySdkLoader>(async () => provider);

    const runtime = await startTelemetry({ env: { AGENTCONTEXT_OTEL_ENABLED: 'true' }, load });

    expect(runtime.enabled).toBe(true);
    expect(provider.registered).toBe(1);
    expect(load).toHaveBeenCalledWith({ serviceName: OTEL_SERVICE_NAME, serviceVersion: undefined });
    expect(OTEL_SERVICE_NAME).toBe('agentblume');
  });

  it('AGENTCONTEXT_SOURCE_REVISION があれば service.version として渡す', async () => {
    const load = vi.fn<TelemetrySdkLoader>(async () => fakeProvider());
    await startTelemetry({ env: { AGENTCONTEXT_OTEL_ENABLED: 'true', AGENTCONTEXT_SOURCE_REVISION: 'ed1e707' }, load });

    expect(load).toHaveBeenCalledWith({ serviceName: OTEL_SERVICE_NAME, serviceVersion: 'ed1e707' });
  });

  it('空白だけの revision は未設定として扱う（"   " というバージョンを送らない）', async () => {
    const load = vi.fn<TelemetrySdkLoader>(async () => fakeProvider());
    await startTelemetry({ env: { AGENTCONTEXT_OTEL_ENABLED: 'true', AGENTCONTEXT_SOURCE_REVISION: '   ' }, load });

    expect(load).toHaveBeenCalledWith({ serviceName: OTEL_SERVICE_NAME, serviceVersion: undefined });
  });

  it('shutdown が provider の shutdown へ伝わる（未送信 span のフラッシュ）', async () => {
    const provider = fakeProvider();
    const runtime = await startTelemetry({ env: { AGENTCONTEXT_OTEL_ENABLED: 'true' }, load: async () => provider });

    await runtime.shutdown();

    expect(provider.stopped).toBe(1);
  });

  it('SDKの読み込みに失敗しても throw せず、理由を1行出して無効化する', async () => {
    const messages: string[] = [];
    const runtime = await startTelemetry({
      env: { AGENTCONTEXT_OTEL_ENABLED: 'true' },
      load: async () => { throw new Error('Cannot find module @opentelemetry/sdk-trace-node'); },
      onError: (message) => messages.push(message),
    });

    expect(runtime.enabled).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('OpenTelemetry');
    expect(messages[0]).toContain('Cannot find module');
    // 無効化されたので shutdown も無害。
    await expect(runtime.shutdown()).resolves.toBeUndefined();
  });

  it('初期化失敗のメッセージから秘密値を落とす（エンドポイントのAPIキー等）', async () => {
    const messages: string[] = [];
    await startTelemetry({
      env: { AGENTCONTEXT_OTEL_ENABLED: 'true' },
      load: async () => { throw new Error('connect failed: authorization: Bearer sk-LEAKME'); },
      onError: (message) => messages.push(message),
    });

    expect(messages[0]).not.toContain('sk-LEAKME');
    expect(messages[0]).toContain('[redacted]');
  });

  it('register が投げても throw しない（観測系の障害を業務へ伝播させない）', async () => {
    const messages: string[] = [];
    const runtime = await startTelemetry({
      env: { AGENTCONTEXT_OTEL_ENABLED: 'true' },
      load: async () => ({ register: () => { throw new Error('already registered'); }, shutdown: async () => {} }),
      onError: (message) => messages.push(message),
    });

    expect(runtime.enabled).toBe(false);
    expect(messages[0]).toContain('already registered');
  });

  it('既定のローダーは実SDKから TracerProvider を組み立てられる（OTelのAPI変更を検出する）', async () => {
    // ここだけは fake で代替できない。SDK側の型・コンストラクタ引数が変わったとき、
    // 「フラグを立てた本番でだけ落ちる」のを防ぐために実物を1回組み立てる。
    // register() はグローバルの TracerProvider を差し替えて他のテストへ漏れるので**呼ばない**。
    const fetchSpy = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = await loadOpenTelemetrySdk({ serviceName: OTEL_SERVICE_NAME, serviceVersion: 'test-revision' });
    expect(typeof provider.register).toBe('function');
    // span を1つも作っていないので、フラッシュしても送信は発生しない。
    await provider.shutdown();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('onError 未指定なら console.warn へ出す（Fastifyのロガーはまだ無い時点なので）', async () => {
    const warn = vi.fn();
    vi.stubGlobal('console', { ...console, warn });

    await startTelemetry({
      env: { AGENTCONTEXT_OTEL_ENABLED: 'true' },
      load: async () => { throw new Error('boom'); },
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('agentblume:');
  });
});
