/**
 * ドメイン: 社内規程の文章を節に分け、モデルへ渡す塊にまとめる（docs/21 §20.7.2。UC9。純関数）。
 *
 * 12B 級のローカルモデルの文脈長に収めるため、見出し（`第N条`・Markdown の `#`・数字の見出し・【】）で節に分け、
 * 1 塊 6,000 字以内に隣り合う節をまとめる。1 節が長すぎるときは字数で割る（見出しは各片に付ける）。
 * 節の位置（start / end）は原文の文字位置で、引用の検査と画面の表示に使う。
 */

export const HEARING_CHUNK_MAX_CHARS = 6000;

export interface DocumentSection {
  readonly heading: string;
  /** 原文の文字位置（start 以上 end 未満）。 */
  readonly start: number;
  readonly end: number;
}

export interface DocumentChunk {
  readonly headings: readonly string[];
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const HEADING_PATTERNS: readonly RegExp[] = [
  /^#{1,6}\s+\S/u,
  /^第[0-9０-９一二三四五六七八九十百千]+条/u,
  /^(?:\d+|[０-９]+)(?:[.．][0-9０-９]+)*[.．、)）]\s*\S/u,
  /^【[^】]+】/u,
];

export function isHeadingLine(line: string): boolean {
  const text = line.trim();
  return text !== '' && text.length <= 80 && HEADING_PATTERNS.some((pattern) => pattern.test(text));
}

/** 見出しで節に分ける。最初の見出しより前の本文は見出しの無い節（heading は空）。空白だけの節は作らない。 */
export function splitPolicySections(text: string): readonly DocumentSection[] {
  const sections: DocumentSection[] = [];
  let current: { heading: string; start: number } = { heading: '', start: 0 };
  let offset = 0;
  const push = (end: number): void => {
    if (text.slice(current.start, end).trim() !== '') sections.push({ heading: current.heading, start: current.start, end });
  };
  for (const line of text.split(/(?<=\n)/u)) {
    if (isHeadingLine(line) && offset > current.start) {
      push(offset);
      current = { heading: line.trim(), start: offset };
    } else if (isHeadingLine(line)) {
      current = { heading: line.trim(), start: offset };
    }
    offset += line.length;
  }
  push(text.length);
  return sections;
}

/** 隣り合う節を `maxChars` 以内にまとめる。1 節が長ければ字数で割る。 */
export function chunkPolicyDocument(text: string, sections: readonly DocumentSection[] = splitPolicySections(text), maxChars: number = HEARING_CHUNK_MAX_CHARS): readonly DocumentChunk[] {
  const pieces: DocumentSection[] = [];
  for (const section of sections) {
    for (let start = section.start; start < section.end; start += maxChars) pieces.push({ heading: section.heading, start, end: Math.min(section.end, start + maxChars) });
  }
  const chunks: DocumentChunk[] = [];
  let group: DocumentSection[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    chunks.push({ headings: [...new Set(group.map((piece) => piece.heading).filter((heading) => heading !== ''))], start, end, text: text.slice(start, end) });
    group = [];
  };
  for (const piece of pieces) {
    if (group.length > 0 && piece.end - group[0]!.start > maxChars) flush();
    group.push(piece);
  }
  flush();
  return chunks;
}
