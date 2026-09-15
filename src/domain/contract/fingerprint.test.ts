import { describe, expect, it } from 'vitest';
import { fingerprint, stableJson } from './fingerprint';

describe('fingerprint', () => {
  it('正常: 同じ入力は同じ 16 桁の 16 進', () => {
    expect(fingerprint('第1条')).toMatch(/^[0-9a-f]{16}$/u);
    expect(fingerprint('第1条')).toBe(fingerprint('第1条'));
  });

  it('境界: 空文字でも 16 桁、1 文字違えば変わる', () => {
    expect(fingerprint('')).toHaveLength(16);
    expect(fingerprint('a')).not.toBe(fingerprint('b'));
  });
});

describe('stableJson', () => {
  it('正常: キーの並びに依らず同じ文字列（undefined のキーは落とす）', () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: undefined, b: null }] })).toBe(stableJson({ a: [1, { b: null, d: 2 }], b: 1 }));
    expect(stableJson({ b: 1, a: 'x' })).toBe('{"a":"x","b":1}');
  });

  it('境界: スカラーと undefined', () => {
    expect(stableJson('x')).toBe('"x"');
    expect(stableJson(undefined)).toBe('null');
    expect(stableJson([])).toBe('[]');
  });
});
