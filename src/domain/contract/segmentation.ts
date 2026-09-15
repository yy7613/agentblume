/**
 * ドメイン: 条文分割（docs/23 §3.2。純関数）。
 *
 * 1. 行頭の条見出し `第N条`（漢数字・全角数字・枝番 `第12条の2`）と、続く `（見出し）` か直前の行の `（見出し）` を検出する。
 * 2. 検出が 3 件未満なら段落（空行）で分け、`chunkMaxChars` を超えないように連結した擬似条文（`段落 1-4`）にする。
 * 3. 最初の条見出しより前は `前文`、末尾の署名欄（「本契約締結の証として」以降）は `後文` として残す（締結日・当事者の根拠）。
 * 4. 項（`2` `２` `(1)`）は分けない。根拠の `articleRef` はモデルが「第12条第2項」まで書く。
 *
 * 英文契約の `Article N` は MVP では扱わない（検出 0 件 → 段落分割）。
 */
import { parseJapaneseNumber } from './date-expressions';

export interface ContractPage {
  /** 1 始まり。 */
  readonly page: number;
  readonly start: number;
  readonly end: number;
  readonly method: 'text-layer' | 'vision';
  readonly warnings: readonly string[];
}

export interface ContractArticle {
  readonly ref: string;
  readonly heading?: string;
  readonly start: number;
  readonly end: number;
  readonly page: number;
}

const ARTICLE_HEADING = /^[ \t　]*第([0-9０-９一二三四五六七八九十百〇零]+)条(?:の([0-9０-９一二三四五六七八九十]+))?(?:[ \t　]*[（(]([^）)\n]{1,40})[）)])?/gmu;
const STANDALONE_HEADING = /^[ \t　]*[（(]([^）)\n]{1,40})[）)][ \t　]*$/u;
const CLOSING_MARKERS = ['本契約締結の証として', '本契約の成立を証するため', '本契約成立の証として', '以上の証として', '本合意の成立を証するため'];

/** 条見出しとして数える最小件数（これ未満は段落へ落とす。「第1条」だけ引用した文書を条文扱いしない）。 */
export const MIN_ARTICLE_HEADINGS = 3;

function pageOf(pages: readonly ContractPage[], position: number): number {
  return pages.find((page) => position >= page.start && position < page.end)?.page ?? pages[pages.length - 1]?.page ?? 1;
}

function refOf(main: string, branch: string | undefined): string {
  const number = parseJapaneseNumber(main) ?? main;
  const branchNumber = branch === undefined ? undefined : parseJapaneseNumber(branch) ?? branch;
  return `第${number}条${branchNumber === undefined ? '' : `の${branchNumber}`}`;
}

function lineStartBefore(body: string, position: number): { readonly start: number; readonly text: string } | undefined {
  if (position === 0) return undefined;
  const previousEnd = position - 1; // position の直前は改行
  const start = body.lastIndexOf('\n', previousEnd - 1) + 1;
  return { start, text: body.slice(start, previousEnd) };
}

/** 全ページを覆う 1 要素のページ（貼り付けテキスト用）。 */
export function singlePage(body: string): readonly ContractPage[] {
  return [{ page: 1, start: 0, end: body.length, method: 'text-layer', warnings: [] }];
}

export function segmentArticles(body: string, pages: readonly ContractPage[], chunkMaxChars: number): readonly ContractArticle[] {
  const headings: { start: number; ref: string; heading?: string }[] = [];
  for (const match of body.matchAll(ARTICLE_HEADING)) {
    let start = match.index;
    let heading = match[3];
    const previous = lineStartBefore(body, start);
    const standalone = previous === undefined ? null : STANDALONE_HEADING.exec(previous.text);
    if (standalone !== null && previous !== undefined) { heading ??= standalone[1]; start = previous.start; }
    headings.push({ start, ref: refOf(match[1]!, match[2]), ...(heading === undefined ? {} : { heading: heading.trim() }) });
  }
  if (headings.length < MIN_ARTICLE_HEADINGS) return paragraphArticles(body, pages, chunkMaxChars);

  const articles: ContractArticle[] = [];
  const push = (ref: string, start: number, end: number, heading?: string) => {
    if (body.slice(start, end).trim() === '') return;
    articles.push({ ref, ...(heading === undefined ? {} : { heading }), start, end, page: pageOf(pages, start) });
  };
  push('前文', 0, headings[0]!.start);
  const last = headings[headings.length - 1]!;
  const closing = CLOSING_MARKERS.map((marker) => body.indexOf(marker, last.start)).filter((index) => index !== -1).sort((left, right) => left - right)[0];
  const closingStart = closing === undefined ? body.length : body.lastIndexOf('\n', closing) + 1;
  headings.forEach((entry, index) => {
    const next = headings[index + 1];
    push(entry.ref, entry.start, next === undefined ? closingStart : next.start, entry.heading);
  });
  push('後文', closingStart, body.length);
  return articles;
}

/** 条見出しが無い文書: 空行で段落に分け、上限まで連結する。 */
function paragraphArticles(body: string, pages: readonly ContractPage[], chunkMaxChars: number): readonly ContractArticle[] {
  const paragraphs: { start: number; end: number }[] = [];
  const separator = /\n[ \t　]*\n/gu;
  let cursor = 0;
  for (const match of body.matchAll(separator)) {
    if (body.slice(cursor, match.index).trim() !== '') paragraphs.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  if (body.slice(cursor).trim() !== '') paragraphs.push({ start: cursor, end: body.length });
  const articles: ContractArticle[] = [];
  let group: { first: number; last: number; start: number; end: number } | undefined;
  const flush = () => {
    if (group === undefined) return;
    const ref = group.first === group.last ? `段落 ${group.first}` : `段落 ${group.first}-${group.last}`;
    articles.push({ ref, start: group.start, end: group.end, page: pageOf(pages, group.start) });
    group = undefined;
  };
  paragraphs.forEach((paragraph, index) => {
    const number = index + 1;
    if (group !== undefined && paragraph.end - group.start > chunkMaxChars) flush();
    group = group === undefined ? { first: number, last: number, start: paragraph.start, end: paragraph.end } : { ...group, last: number, end: paragraph.end };
  });
  flush();
  return articles;
}

/** 甲乙の行の決定的な検出（前文の「〇〇（以下「甲」という。）」）。画面の初期値に使い、人が確かめる。 */
export function detectParties(body: string): { readonly A?: string; readonly B?: string } {
  const head = body.slice(0, 3000);
  const found: { A?: string; B?: string } = {};
  // 名前の直後の短い括弧書き（「（架空）」「（旧商号）」など）は名前に含めず読み飛ばす。
  const pattern = /([^\s、。「」（）()]{2,60}?)(?:\s*[（(][^（）()\n]{1,20}[）)])?\s*[（(]\s*以下[、,]?\s*[「『]?\s*(甲|乙)\s*[」』]?\s*という/gu;
  for (const match of head.matchAll(pattern)) {
    const key = match[2] === '甲' ? 'A' : 'B';
    if (found[key] === undefined) found[key] = match[1]!.replace(/^(?:本契約は|と|、)/u, '').trim();
  }
  return found;
}
