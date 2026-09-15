import { useEffect, useMemo, useRef } from 'react';
import type { ContractDocumentDto } from '../api/contract-types';
import { useI18n } from '../i18n';
import { highlightSegments, type HighlightRange } from './contract-model';

type Segment = ReturnType<typeof highlightSegments>[number];

/** 区間を指定位置（区間の内側に落ちるものだけ）で割る。強調とトピックは割った両側に引き継ぐ。 */
function splitAt(segments: readonly Segment[], positions: readonly number[]): readonly Segment[] {
  return segments.flatMap((segment) => {
    const cuts = [...new Set(positions.filter((position) => position > segment.start && position < segment.end))].sort((left, right) => left - right);
    if (cuts.length === 0) return [segment];
    const bounds = [segment.start, ...cuts, segment.end];
    return bounds.slice(0, -1).map((start, index) => ({ ...segment, start, end: bounds[index + 1]!, text: segment.text.slice(start - segment.start, bounds[index + 1]! - segment.start) }));
  });
}

/**
 * 契約書の本文ビューア（条項抽出とレビューで共有）。条文目次・根拠のハイライト・選択範囲の取得。
 * 選択は本文中の文字位置で親へ返す（「このトピックの根拠にする」で手指定に使う）。
 */
export function ContractTextView({ document, ranges, focus, onSelect }: {
  readonly document: Pick<ContractDocumentDto, 'body' | 'articles'>;
  readonly ranges: readonly HighlightRange[];
  /** 表示中のトピック。そのハイライトへスクロールする。 */
  readonly focus?: { readonly topicId: string; readonly seq: number };
  readonly onSelect?: (range: { readonly start: number; readonly end: number } | undefined) => void;
}) {
  const { text } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  // 条文の始まりでも区間を割る。区間はハイライトでしか割れないので、そのままだと条の先頭に data-start が無く、
  // 目次を押しても条へ飛べない（次のハイライトまで飛ぶか、何も起きない）。
  const segments = useMemo(() => splitAt(highlightSegments(document.body, ranges), document.articles.map((article) => article.start)), [document.body, document.articles, ranges]);

  useEffect(() => {
    if (focus === undefined) return;
    // CSS.escape が無い環境（古いブラウザ・jsdom）ではトピック id をそのまま使う（id は英小文字・数字・_- に限られる）。
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(focus.topicId) : focus.topicId;
    const target = containerRef.current?.querySelector(`[data-topic="${escaped}"]`);
    if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
  }, [focus]);

  const jumpTo = (start: number) => {
    const target = containerRef.current?.querySelector(`[data-start="${start}"]`) ??[...(containerRef.current?.querySelectorAll('[data-start]') ?? [])].find((node) => Number((node as HTMLElement).dataset['start']) >= start);
    if (target instanceof HTMLElement && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  };

  /** DOM の選択 → 本文中の位置（区間ごとの data-start から数える）。 */
  const captureSelection = () => {
    if (onSelect === undefined) return;
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) { onSelect(undefined); return; }
    const positionOf = (node: Node | null, offset: number): number | undefined => {
      const element = node instanceof HTMLElement ? node : node?.parentElement;
      const span = element?.closest('[data-start]');
      if (!(span instanceof HTMLElement) || !containerRef.current?.contains(span)) return undefined;
      return Number(span.dataset['start']) + offset;
    };
    const range = selection.getRangeAt(0);
    const start = positionOf(range.startContainer, range.startOffset);
    const end = positionOf(range.endContainer, range.endOffset);
    onSelect(start === undefined || end === undefined ? undefined : { start: Math.min(start, end), end: Math.max(start, end) });
  };

  return <div className="contract-text-view">
    {document.articles.length > 0 && <nav className="contract-toc" aria-label={text('Articles', '条文目次')}>
      {document.articles.map((article) => <button type="button" key={`${article.ref}:${article.start}`} className="ghost" onClick={() => jumpTo(article.start)}>{article.ref}{article.heading === undefined ? '' : ` ${article.heading}`}</button>)}
    </nav>}
    <div ref={containerRef} className="contract-body" onMouseUp={captureSelection} onKeyUp={captureSelection} tabIndex={0} aria-label={text('Contract text', '契約書の本文')}>
      {segments.map((segment) => segment.highlighted
        ? <mark key={segment.start} data-start={segment.start} data-topic={segment.topicId}>{segment.text}</mark>
        : <span key={segment.start} data-start={segment.start}>{segment.text}</span>)}
    </div>
  </div>;
}
