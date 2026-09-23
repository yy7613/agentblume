/**
 * チャット応答（LLM が書く自由文）を安全に描画する、最小限のMarkdown表示（v53 F4）。
 *
 * 対応するのは次の2つだけ:
 * - 空行区切りの段落（改行はそのまま保持。従来の `<p>` 表示と同じ見た目）。
 * - GFMのパイプ表（見出し行 + `| --- | --- |` の区切り行があるブロック）を `<table>` として描く。
 *
 * それ以外の記法（強調・リンク・リスト・見出し等）は対象外で、記法の文字ごとプレーンテキストのまま出す
 * （誤検出で崩すより、対応外は素通しにする方が安全）。セルや段落の中身は React の子要素としてそのまま渡すため、
 * 応答に HTML タグや `<script>` が含まれていてもテキストとして表示されるだけで実行されない
 * （`dangerouslySetInnerHTML` は使わない＝ XSS を作らない）。
 */

interface TableBlock { readonly kind: 'table'; readonly header: readonly string[]; readonly rows: readonly (readonly string[])[] }
interface ParagraphBlock { readonly kind: 'paragraph'; readonly text: string }
type Block = TableBlock | ParagraphBlock;

/** `| --- | :--: | ---: |` のような区切り行。パイプの有無・空白・左右寄せの `:` を許す。 */
const TABLE_SEPARATOR_ROW = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;

function splitRow(line: string): readonly string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function parseBlock(text: string): Block {
  const lines = text.split('\n');
  const second = lines[1];
  if (lines.length >= 2 && lines[0]!.includes('|') && second !== undefined && TABLE_SEPARATOR_ROW.test(second.trim())) {
    return {
      kind: 'table',
      header: splitRow(lines[0]!),
      rows: lines.slice(2).filter((line) => line.trim() !== '').map(splitRow),
    };
  }
  return { kind: 'paragraph', text };
}

/** 空行（改行だけの行を含む）で段落ブロックに分ける。 */
function parseBlocks(text: string): readonly Block[] {
  return text.split(/\n\s*\n/).map(parseBlock);
}

export function Markdown({ text }: { readonly text: string }) {
  const blocks = parseBlocks(text);
  return <>{blocks.map((block, index) => block.kind === 'table'
    ? <div className="table-wrap md-table" key={index}>
      <table>
        <thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}>{cell}</th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
      </table>
    </div>
    : <p key={index}>{block.text}</p>)}</>;
}
