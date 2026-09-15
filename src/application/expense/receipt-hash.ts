/**
 * application層: 証憑画像のハッシュ（同一画像の重複 `duplicate-receipt-image` に使う）。
 *
 * data URL の文字列ではなく**画像のバイト列**から計算する（base64 の改行や末尾の `=` の揺れで別物扱いにしないため）。
 * domain は `node:crypto` を使わないので、ここで計算して渡す（docs/21 §2.6）。
 */
import { createHash } from 'node:crypto';

export function receiptSha256(dataUrl: string): string {
  const comma = dataUrl.indexOf(',');
  const base64 = comma < 0 ? dataUrl : dataUrl.slice(comma + 1);
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}
