/**
 * ドメイン: 変更検知と LLM 回答の再利用に使う短い指紋（暗号学的な強度は要らない）。
 *
 * 「条文と基準が変わらない限り再レビューで回答を再利用する」ためのキー（docs/23 §4.6）と、
 * レビュー後に条項が変わったか（stale）の判定に使う。domain は node:crypto に依らない。
 */

/** FNV-1a（32bit）を 2 本の種で回して 16 桁の 16 進にする。 */
export function fingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x5bd1e995) >>> 0;
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}

/** キーの並びに依らない JSON（同じ値なら同じ文字列）。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
