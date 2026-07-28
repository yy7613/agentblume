/**
 * ログ設定のテスト（`src/api/logging.ts`）。
 *
 * 「redact のパス表を目視で読んで正しそう」では守れない。実際に Fastify を **本物のロガー付きで**
 * 組み立て、出力ストリームを掴んで「秘密値の文字列が1バイトも出ていない」ことを確認する。
 * pino の redact はロガー生成時に fast-redact がパスを事前コンパイルするため、
 * パスの綴り間違いは黙って無効化される（例外にならない）。ここで固定しておかないと気づけない。
 */
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { LOG_REDACT_CENSOR, LOG_REDACT_PATHS, loggerOptions } from './logging';
import { DEFAULT_SERVER_LOG_LEVEL, resolveLoggerOption } from './server';

/** pino の出力を1行ずつ溜める。 */
function captureStream(): { readonly stream: Writable; text(): string; entries(): readonly Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return {
    stream,
    text: () => chunks.join(''),
    entries: () => chunks.join('').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('loggerOptions', () => {
  const servers: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => { await server.close(); }));
  });

  /** 実ロガー付きの Fastify を作る（`buildServer` は通さない。ここで見たいのはログ設定だけ）。 */
  const build = (level: Parameters<typeof loggerOptions>[0], stream: Writable, extra: Record<string, unknown> = {}): FastifyInstance => {
    const server = Fastify({ logger: { ...loggerOptions(level), stream, ...extra } });
    servers.push(server);
    return server;
  };

  it('ログcontextのトップレベルにある機微フィールドを伏せる', async () => {
    const captured = captureStream();
    const server = build('info', captured.stream);
    server.log.info({ apiKey: 'sk-TOPSECRET', password: 'hunter2', token: 'tok-abc', secret: 's3cr3t', authorization: 'Bearer zzz', model: 'gpt-oss' }, 'saved');
    await server.close();

    const text = captured.text();
    for (const leak of ['sk-TOPSECRET', 'hunter2', 'tok-abc', 's3cr3t', 'Bearer zzz']) {
      expect(text).not.toContain(leak);
    }
    const entry = captured.entries().at(-1) ?? {};
    expect(entry['apiKey']).toBe(LOG_REDACT_CENSOR);
    expect(entry['password']).toBe(LOG_REDACT_CENSOR);
    expect(entry['token']).toBe(LOG_REDACT_CENSOR);
    expect(entry['secret']).toBe(LOG_REDACT_CENSOR);
    expect(entry['authorization']).toBe(LOG_REDACT_CENSOR);
    // 機微でない値は落とさない（マスクしすぎるとログの意味が無くなる）。
    expect(entry['model']).toBe('gpt-oss');
  });

  it('ネストしたオブジェクト（深さ2）の機微フィールドも伏せる', async () => {
    const captured = captureStream();
    const server = build('info', captured.stream);
    server.log.warn({ settings: { apiKey: 'sk-NESTED', baseUrl: 'http://127.0.0.1:1234/v1' } }, 'model settings');
    await server.close();

    expect(captured.text()).not.toContain('sk-NESTED');
    const entry = captured.entries().at(-1) ?? {};
    expect(entry['settings']).toEqual({ apiKey: LOG_REDACT_CENSOR, baseUrl: 'http://127.0.0.1:1234/v1' });
  });

  it('リクエストヘッダの Authorization / Cookie / APIキーを伏せる', async () => {
    const captured = captureStream();
    const server = build('info', captured.stream);
    server.get('/probe', async (request) => {
      // 障害調査でヘッダをログへ出す、という「その場では正しく見える」変更を再現する。
      request.log.info({ headers: request.headers }, 'probe');
      return { ok: true };
    });
    await server.inject({
      method: 'GET',
      url: '/probe',
      headers: { authorization: 'Bearer LEAKME', cookie: 'sid=LEAKME2', 'x-api-key': 'LEAKME3', 'user-agent': 'vitest' },
    });
    await server.close();

    const text = captured.text();
    expect(text).not.toContain('LEAKME');
    const probe = captured.entries().find((entry) => entry['msg'] === 'probe') ?? {};
    expect(probe['headers']).toMatchObject({
      authorization: LOG_REDACT_CENSOR,
      cookie: LOG_REDACT_CENSOR,
      'x-api-key': LOG_REDACT_CENSOR,
      // 機微でないヘッダは残す。
      'user-agent': 'vitest',
    });
  });

  it('req をボディごと出すシリアライザを入れても伏せる（redact はシリアライザの後に効く）', async () => {
    // Fastify の**既定**の req シリアライザは method / url / host / remoteAddress しか出さないので、
    // 素の状態でボディは漏れない。危ないのは「調査のためにボディも出す」ようにした瞬間で、
    // そのときに redact が後段で効くことをここで固定する。
    const captured = captureStream();
    const server = build('info', captured.stream, {
      serializers: { req: (request: { method: string; url: string; body: unknown }) => ({ method: request.method, url: request.url, body: request.body }) },
    });
    server.post('/model-settings', async (request) => {
      request.log.info({ req: request }, 'incoming');
      return { ok: true };
    });
    await server.inject({ method: 'POST', url: '/model-settings', payload: { apiKey: 'sk-BODY', password: 'pw-BODY', model: 'local' } });
    await server.close();

    const text = captured.text();
    expect(text).not.toContain('sk-BODY');
    expect(text).not.toContain('pw-BODY');
    const entry = captured.entries().find((line) => line['msg'] === 'incoming') ?? {};
    expect(entry['req']).toMatchObject({ body: { apiKey: LOG_REDACT_CENSOR, password: LOG_REDACT_CENSOR, model: 'local' } });
  });

  it('既定のシリアライザはそもそもボディもヘッダも出さない（多層防御の前提を固定する）', async () => {
    const captured = captureStream();
    const server = build('info', captured.stream);
    server.post('/model-settings', async () => ({ ok: true }));
    await server.inject({ method: 'POST', url: '/model-settings', payload: { apiKey: 'sk-DEFAULT' }, headers: { authorization: 'Bearer NOPE' } });
    await server.close();

    const incoming = captured.entries().find((line) => line['msg'] === 'incoming request') ?? {};
    expect(incoming['req']).not.toHaveProperty('body');
    expect(incoming['req']).not.toHaveProperty('headers');
    expect(captured.text()).not.toContain('sk-DEFAULT');
    expect(captured.text()).not.toContain('NOPE');
  });

  it('リクエストごとのログに reqId が載る（Run実行のログと相関させるための土台）', async () => {
    const captured = captureStream();
    const server = build('info', captured.stream);
    server.get('/probe', async (request) => {
      request.log.info('handler ran');
      return { ok: true };
    });
    await server.inject({ method: 'GET', url: '/probe' });
    await server.close();

    const entries = captured.entries();
    // Fastify がリクエストごとに logger.child({ reqId }) を作るので、自動ログにもハンドラのログにも載る。
    const handlerLog = entries.find((entry) => entry['msg'] === 'handler ran');
    expect(handlerLog?.['reqId']).toEqual(expect.any(String));
    expect(entries.find((entry) => entry['msg'] === 'incoming request')?.['reqId']).toBe(handlerLog?.['reqId']);
    expect(entries.find((entry) => entry['msg'] === 'request completed')?.['reqId']).toBe(handlerLog?.['reqId']);
  });

  it('レベル指定が効く（warn 未満は出さない / silent は1行も出さない）', async () => {
    const warnOnly = captureStream();
    const warnServer = build('warn', warnOnly.stream);
    warnServer.log.info('dropped');
    warnServer.log.warn('kept');
    await warnServer.close();
    expect(warnOnly.text()).not.toContain('dropped');
    expect(warnOnly.text()).toContain('kept');

    const silent = captureStream();
    const silentServer = build('silent', silent.stream);
    silentServer.log.error('not even this');
    await silentServer.close();
    expect(silent.text()).toBe('');
  });

  it('redact のパスは fast-redact が受理する形式（生成時に throw しない）', () => {
    expect(() => loggerOptions('info')).not.toThrow();
    expect(LOG_REDACT_PATHS.length).toBeGreaterThan(0);
    // ワイルドカードは1階層ぶんだけ（`*.*.x` は fast-redact が扱えない）。
    expect(LOG_REDACT_PATHS.filter((path) => path.split('*').length > 2)).toEqual([]);
  });
});

describe('resolveLoggerOption', () => {
  it('省略・false はロガー無効（テストの既定）', () => {
    expect(resolveLoggerOption(undefined)).toBe(false);
    expect(resolveLoggerOption(false)).toBe(false);
  });

  it('true は既定レベル＋redact 付き（素の pino へ素通しさせない）', () => {
    const resolved = resolveLoggerOption(true);
    expect(resolved).toMatchObject({ level: DEFAULT_SERVER_LOG_LEVEL, redact: { censor: LOG_REDACT_CENSOR } });
  });

  it('{ level } は指定レベル＋redact 付き', () => {
    expect(resolveLoggerOption({ level: 'debug' })).toMatchObject({ level: 'debug', redact: { paths: [...LOG_REDACT_PATHS] } });
  });
});
