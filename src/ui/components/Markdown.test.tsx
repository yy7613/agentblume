// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

afterEach(cleanup);

describe('Markdown（チャット応答の最小限のMarkdown描画・v53 F4）', () => {
  it('正常: 見出し行＋区切り行のあるパイプ表は <table> として描く', () => {
    const text = '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |';
    render(<Markdown text={text} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['a', 'b']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3); // 見出し行 + 本体2行
    expect(within(rows[1] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['1', '2']);
    expect(within(rows[2] as HTMLElement).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['3', '4']);
  });

  it('正常: 表以外の段落は従来どおり改行を保ったプレーンテキストの<p>で出す', () => {
    const text = 'line one\nline two';
    const { container } = render(<Markdown text={text} />);
    expect(screen.queryByRole('table')).toBeNull();
    const paragraph = container.querySelector('p');
    expect(paragraph?.textContent).toBe('line one\nline two');
  });

  it('正常: 空行で区切られた段落と表が混在していても、それぞれ正しく描き分ける', () => {
    render(<Markdown text={'Here is the result:\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\nDone.'} />);
    expect(screen.getByText('Here is the result:')).toBeTruthy();
    expect(screen.getByText('Done.')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('境界: 区切り行の左右寄せ記法（:---:等）や外側パイプの省略にも対応する', () => {
    render(<Markdown text={'a | b\n:--- | ---:\n1 | 2'} />);
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['a', 'b']);
  });

  it('境界: 見出し行にパイプがあっても2行目が区切り行でなければ表にしない', () => {
    render(<Markdown text={'a | b\nnot a separator\nc | d'} />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/a \| b/)).toBeTruthy();
  });

  it('異常: 行によって列数が揃っていない崩れた表でも例外を投げず、各行そのままの列数で描く', () => {
    const text = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 | 6 |';
    render(<Markdown text={text} />);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getAllByRole('cell')).toHaveLength(2);
    expect(within(rows[2] as HTMLElement).getAllByRole('cell')).toHaveLength(4);
  });

  it('例外（安全性）: セルにHTML/スクリプトらしき文字列が入っても、実際のHTML要素にはならずテキストとして描かれる', () => {
    const text = '| name | note |\n| --- | --- |\n| x | <img src=x onerror=alert(1)> |';
    const { container } = render(<Markdown text={text} />);
    // dangerouslySetInnerHTML を使わないため、注入された文字列はテキストノードのまま。実際の<img>要素は生成されない。
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('例外（安全性）: 段落側にscriptタグらしき文字列が入ってもテキストとして描かれ、要素化されない', () => {
    const { container } = render(<Markdown text={'<script>alert(1)</script>'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
  });
});
