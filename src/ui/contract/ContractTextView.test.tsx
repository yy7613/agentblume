// @vitest-environment jsdom
/**
 * 本文ビューア。目次のジャンプ・根拠のハイライト・focus のスクロール・選択範囲 → 本文中の位置の変換を確かめる。
 * jsdom は scrollIntoView も選択 API の実体も持たないので、スタブで呼ばれ方を見る。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContractTextView } from './ContractTextView';

const BODY = '第1条（目的）\n本契約は委託を定める。\n第2条（期間）\n1年間とする。';
const second = BODY.indexOf('第2条');
const document = {
  body: BODY,
  articles: [{ ref: '第1条', heading: '目的', start: 0, end: second, page: 1 }, { ref: '第2条', start: second, end: BODY.length, page: 1 }],
};
const ranges = [{ start: BODY.indexOf('本契約'), end: BODY.indexOf('本契約') + 3, topicId: 'purpose' }];

let scrolled: HTMLElement[];

beforeEach(() => {
  scrolled = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, writable: true, value(this: HTMLElement) { scrolled.push(this); } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

function selectionOf(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Selection {
  return { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: startNode, startOffset, endContainer: endNode, endOffset }) } as unknown as Selection;
}

describe('ContractTextView', () => {
  it('正常: 目次を出し、見出しの無い条も ref だけで並べ、押すとその位置以降の区間へスクロールする', async () => {
    render(<ContractTextView document={document} ranges={ranges} />);
    expect(screen.getByRole('button', { name: '第1条 目的' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '第2条' }));
    expect(scrolled.at(-1)?.textContent).toContain('第2条');
  });

  it('境界: 条文が無ければ目次を出さない', () => {
    render(<ContractTextView document={{ body: 'x', articles: [] }} ranges={[]} />);
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('正常: 根拠をトピック id つきでハイライトし、focus が来るとそのハイライトへスクロールする', () => {
    const { rerender } = render(<ContractTextView document={document} ranges={ranges} />);
    const mark = window.document.querySelector('mark');
    expect(mark?.textContent).toBe('本契約');
    expect(mark?.getAttribute('data-topic')).toBe('purpose');
    expect(scrolled).toEqual([]);
    rerender(<ContractTextView document={document} ranges={ranges} focus={{ topicId: 'purpose', seq: 1 }} />);
    expect(scrolled).toEqual([mark]);
  });

  it('例外: scrollIntoView が無い環境でも目次・focus で落ちない', async () => {
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    render(<ContractTextView document={document} ranges={ranges} focus={{ topicId: 'purpose', seq: 1 }} />);
    await userEvent.click(screen.getByRole('button', { name: '第2条' }));
    expect(screen.getByLabelText('Contract text')).toBeTruthy();
  });

  it('正常: 選択を本文中の位置（区間の data-start + オフセット）に直し、逆向きの選択も昇順で返す', () => {
    const onSelect = vi.fn();
    render(<ContractTextView document={document} ranges={ranges} onSelect={onSelect} />);
    const body = screen.getByLabelText('Contract text');
    const mark = body.querySelector('mark')!;
    const tail = [...body.querySelectorAll('span')].at(-1)!;
    const tailStart = Number(tail.dataset['start']);
    // 後ろ（テキストノード）から前（要素）へ選んだ逆向きの選択。
    vi.spyOn(window, 'getSelection').mockReturnValue(selectionOf(tail.firstChild!, 2, mark, 0));
    fireEvent.mouseUp(body);
    expect(onSelect).toHaveBeenLastCalledWith({ start: Number(mark.dataset['start']), end: tailStart + 2 });
  });

  it('境界: 選択が無い・潰れている・本文の外にかかるときは undefined を返す', () => {
    const onSelect = vi.fn();
    render(<><p>外の文</p><ContractTextView document={document} ranges={ranges} onSelect={onSelect} /></>);
    const body = screen.getByLabelText('Contract text');
    const spy = vi.spyOn(window, 'getSelection');
    spy.mockReturnValue(null);
    fireEvent.mouseUp(body);
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
    spy.mockReturnValue({ isCollapsed: true, rangeCount: 1 } as unknown as Selection);
    fireEvent.keyUp(body);
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
    const outside = screen.getByText('外の文');
    spy.mockReturnValue(selectionOf(outside.firstChild!, 0, body.querySelector('mark')!, 1));
    fireEvent.mouseUp(body);
    expect(onSelect).toHaveBeenCalledTimes(3);
    expect(onSelect).toHaveBeenLastCalledWith(undefined);
  });

  it('境界: onSelect が無ければ選択を読まない（レビューでは手指定しない）', () => {
    render(<ContractTextView document={document} ranges={ranges} />);
    const spy = vi.spyOn(window, 'getSelection');
    fireEvent.mouseUp(screen.getByLabelText('Contract text'));
    expect(spy).not.toHaveBeenCalled();
  });
});
