// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthToken, readAuthToken, writeAuthToken } from './auth-token';

beforeEach(() => { localStorage.clear(); clearAuthToken(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); clearAuthToken(); });

describe('auth token storage', () => {
  it('未設定なら undefined', () => {
    expect(readAuthToken()).toBeUndefined();
  });

  it('保存した値を読み戻す（前後の空白は落とす）', () => {
    writeAuthToken('  secret-token  ');
    expect(readAuthToken()).toBe('secret-token');
  });

  it('空文字・undefined は消去と同じ', () => {
    writeAuthToken('secret-token');
    writeAuthToken('   ');
    expect(readAuthToken()).toBeUndefined();
    writeAuthToken('secret-token');
    clearAuthToken();
    expect(readAuthToken()).toBeUndefined();
  });

  it('localStorage が使えなくても画面を落とさず、そのタブの間は動く', () => {
    // プライベートモード等で setItem / getItem が throw する環境の再現。
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(() => writeAuthToken('secret-token')).not.toThrow();
    expect(readAuthToken()).toBe('secret-token');
  });
});
