import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { receiptSha256 } from './receipt-hash';

// 'ABCD' を base64 にしたもの。期待値は「文字列」ではなく「バイト列」の SHA-256 で持つ（実装と同じ式を書き写さないため）。
const ABCD = 'QUJDRA==';
const SHA_OF_ABCD = createHash('sha256').update('ABCD').digest('hex');

describe('receiptSha256', () => {
  it('正常: data URL の本体（カンマ以降）を復号したバイト列の SHA-256 を 64 桁の小文字 16 進で返す', () => {
    const hash = receiptSha256(`data:image/png;base64,${ABCD}`);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(hash).toBe(SHA_OF_ABCD);
  });

  it('境界: MIME の宣言・base64 の改行・末尾の = の有無が違っても、同じ画像なら同じハッシュ（重複検出で別物扱いにしない）', () => {
    expect(receiptSha256(`data:image/jpeg;base64,${ABCD}`)).toBe(SHA_OF_ABCD);
    expect(receiptSha256('data:image/png;base64,QUJD\nRA==')).toBe(SHA_OF_ABCD);
    expect(receiptSha256('data:image/png;base64,QUJDRA')).toBe(SHA_OF_ABCD);
  });

  it('境界: カンマの無い文字列は全体を base64 本体として扱う', () => {
    expect(receiptSha256(ABCD)).toBe(SHA_OF_ABCD);
  });

  it('異常: 1 バイトでも違う画像は別のハッシュになる', () => {
    // 'ABCE'
    expect(receiptSha256('data:image/png;base64,QUJDRQ==')).not.toBe(SHA_OF_ABCD);
  });
});
