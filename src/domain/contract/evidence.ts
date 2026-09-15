/**
 * ドメイン: 根拠の引用を本文と照合する（docs/23 §3.5）。
 *
 * LLM は「一字一句そのまま」と頼んでも全角・半角や改行の位置を変えて写す。そこで本文と引用の両方を
 * NFKC で正規化し、空白（改行を含む）を除いた文字列で部分一致を探す。見つかれば**原文の位置**（start / end）を返す。
 * 言い換え・省略記号・存在しない条文は見つからないので `quote-not-found` になる（値は残し、判定は unresolved）。
 */

export interface QuoteLocation {
  readonly start: number;
  readonly end: number;
}

interface NormalizedText {
  readonly text: string;
  /** 正規化後の i コード単位目が、原文のどこ（開始）から来たか。 */
  readonly origin: readonly number[];
  /** 同じく原文の終わり（その字の直後）。 */
  readonly originEnd: readonly number[];
}

const WHITESPACE = /\s/u;
/** 基底字 + 後続の結合文字（半角の濁点・半濁点を含む）。1 字ずつ NFKC すると「ｶﾞ」が「ガ」に合成されないため束ねる。 */
const CLUSTER = /[^ﾞﾟ\p{M}][ﾞﾟ\p{M}]*|[ﾞﾟ\p{M}]+/gsu;

function normalizeWithOrigin(value: string, offset = 0): NormalizedText {
  let text = '';
  const origin: number[] = [];
  const originEnd: number[] = [];
  for (const match of value.matchAll(CLUSTER)) {
    const cluster = match[0];
    if (WHITESPACE.test(cluster)) continue;
    for (const piece of cluster.normalize('NFKC')) {
      if (WHITESPACE.test(piece)) continue;
      text += piece;
      // indexOf の位置はコード単位なので、サロゲートペアは 2 要素ぶん積んで添字をそろえる。
      for (let unit = 0; unit < piece.length; unit += 1) { origin.push(offset + match.index); originEnd.push(offset + match.index + cluster.length); }
    }
  }
  return { text, origin, originEnd };
}

/** 照合の比較用の正規化（位置は要らない）。 */
export function normalizeForMatch(value: string): string {
  return normalizeWithOrigin(value).text;
}

/**
 * 本文ごとに 1 回だけ正規化して使い回す（本文は最大 30 万文字、引用は数十件ある）。
 * `within` を渡すとその範囲を先に探し、無ければ本文全体を探す（同じ文言が複数の条にある契約書のため）。
 */
export function createQuoteLocator(body: string): (quote: string, within?: QuoteLocation) => QuoteLocation | undefined {
  const normalizedBody = normalizeWithOrigin(body);
  const locate = (needle: string, from: number, to: number): QuoteLocation | undefined => {
    const position = normalizedBody.text.indexOf(needle, from);
    // 最初の一致が範囲を越えるなら、それより後ろの一致も必ず越える。
    if (position === -1 || position + needle.length > to) return undefined;
    return { start: normalizedBody.origin[position]!, end: normalizedBody.originEnd[position + needle.length - 1]! };
  };
  const indexAtOrAfter = (originalIndex: number): number => {
    const found = normalizedBody.origin.findIndex((origin) => origin >= originalIndex);
    return found === -1 ? normalizedBody.text.length : found;
  };
  return (quote, within) => {
    const needle = normalizeForMatch(quote);
    if (needle === '') return undefined;
    if (within !== undefined) {
      const hit = locate(needle, indexAtOrAfter(within.start), indexAtOrAfter(within.end));
      if (hit !== undefined) return hit;
    }
    return locate(needle, 0, normalizedBody.text.length);
  };
}

/** 引用が与えた文字列の中にあるか（LLM 基準の根拠を条文内で確かめる）。 */
export function quoteAppearsIn(text: string, quote: string): boolean {
  const needle = normalizeForMatch(quote);
  return needle !== '' && normalizeForMatch(text).includes(needle);
}
