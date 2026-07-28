import { describe, expect, it, vi } from 'vitest';
import { describeError, logSwallowed, NOOP_LOGGER, redactSecrets, type LoggerPort } from './logger';

function fakeLogger(): LoggerPort & { readonly warns: { message: string; context?: Record<string, unknown> }[] } {
  const warns: { message: string; context?: Record<string, unknown> }[] = [];
  return {
    warns,
    info: () => {},
    warn: (message, context) => { warns.push({ message, ...(context === undefined ? {} : { context: { ...context } }) }); },
    error: () => {},
  };
}

describe('redactSecrets', () => {
  it('鍵の形をした値を伏せる（例外メッセージにはURLやヘッダがそのまま載る）', () => {
    expect(redactSecrets('401 from Authorization: Bearer sk-abc.DEF-123')).toBe('401 from Authorization: [redacted]');
    expect(redactSecrets('sent Bearer sk-abc.DEF-123 upstream')).toBe('sent Bearer [redacted] upstream');
    expect(redactSecrets('GET https://api.example.com/v1?api_key=sk-secret&q=1')).toBe('GET https://api.example.com/v1?api_key=[redacted]&q=1');
    expect(redactSecrets('{"apiKey":"sk-live-9","model":"gpt"}')).toBe('{"apiKey":"[redacted]","model":"gpt"}');
    expect(redactSecrets('password=hunter2; user=alice')).toBe('password=[redacted]; user=alice');
  });

  it('秘密でない本文は変えない', () => {
    expect(redactSecrets('ECONNREFUSED 127.0.0.1:1234')).toBe('ECONNREFUSED 127.0.0.1:1234');
  });
});

describe('describeError', () => {
  it('Errorはメッセージだけを出し、名前付きの型は名前を添える', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
    const named = new Error('offline'); named.name = 'ModelProviderError';
    expect(describeError(named)).toBe('ModelProviderError: offline');
  });

  it('Error以外も文字列化する', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError(undefined)).toBe('undefined');
  });

  it('長すぎるメッセージは切り詰め、秘密値は伏せる', () => {
    expect(describeError(new Error('x'.repeat(400)))).toHaveLength(301);
    expect(describeError(new Error('token=abcdef'))).toBe('token=[redacted]');
  });
});

describe('logSwallowed', () => {
  it('warnへ理由とcontextを載せる', () => {
    const logger = fakeLogger();
    logSwallowed(logger, 'run metric was not recorded', new Error('db is locked'), { runId: 'run-1' });
    expect(logger.warns).toEqual([{ message: 'run metric was not recorded', context: { runId: 'run-1', reason: 'db is locked' } }]);
  });

  it('loggerが未配線なら何もしない', () => {
    expect(() => { logSwallowed(undefined, 'ignored', new Error('boom')); }).not.toThrow();
  });

  it('logger自身が投げても呼び出し側へ伝播させない（ログのために業務を落とさない）', () => {
    const broken: LoggerPort = { info: () => {}, warn: () => { throw new Error('sink is gone'); }, error: () => {} };
    expect(() => { logSwallowed(broken, 'still swallowed', new Error('boom')); }).not.toThrow();
  });
});

describe('NOOP_LOGGER', () => {
  it('3レベルとも何もしない（テスト・testプロファイルの既定）', () => {
    const spy = vi.spyOn(console, 'warn');
    NOOP_LOGGER.info('a'); NOOP_LOGGER.warn('b'); NOOP_LOGGER.error('c');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
