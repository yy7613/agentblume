// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { focusableElements, nextTrapTarget, useModalBehavior } from './useModalBehavior';

afterEach(cleanup);

function Dialog({ onClose, empty = false }: { readonly onClose: () => void; readonly empty?: boolean }) {
  const ref = useModalBehavior<HTMLDivElement>({ onClose });
  return <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Test dialog">
    {!empty && <>
      <input aria-label="First field" />
      <button type="button">Middle</button>
      <button type="button" onClick={onClose}>Close</button>
    </>}
  </div>;
}

function Host({ empty = false }: { readonly empty?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div>
    <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
    {open && <Dialog empty={empty} onClose={() => setOpen(false)} />}
  </div>;
}

describe('focusableElements', () => {
  it('無効・hidden・aria-hidden・tabindex=-1 を除く要素をDOM順で返す', () => {
    const container = document.createElement('div');
    container.innerHTML = '<input id="a" /><input id="b" disabled /><button id="c" hidden></button>'
      + '<button id="d" aria-hidden="true"></button><span id="e" tabindex="-1"></span><span id="f" tabindex="0"></span><a id="g" href="#x"></a>';
    expect(focusableElements(container).map((element) => element.id)).toEqual(['a', 'f', 'g']);
  });
});

describe('nextTrapTarget', () => {
  const first = document.createElement('button');
  const middle = document.createElement('button');
  const last = document.createElement('button');
  const items = [first, middle, last];

  it('末尾でTabなら先頭へ、先頭でShift+Tabなら末尾へ折り返す', () => {
    expect(nextTrapTarget(items, last, false)).toBe(first);
    expect(nextTrapTarget(items, first, true)).toBe(last);
  });

  it('中間ではブラウザ既定に任せる', () => {
    expect(nextTrapTarget(items, middle, false)).toBeUndefined();
    expect(nextTrapTarget(items, middle, true)).toBeUndefined();
  });

  it('ダイアログ外にフォーカスがあれば端へ引き戻す', () => {
    expect(nextTrapTarget(items, null, false)).toBe(first);
    expect(nextTrapTarget(items, document.createElement('button'), true)).toBe(last);
  });

  it('フォーカス可能要素が無ければundefined', () => {
    expect(nextTrapTarget([], null, false)).toBeUndefined();
  });
});

describe('useModalBehavior', () => {
  it('開いたら最初のフォーカス可能要素へフォーカスする', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(document.activeElement).toBe(screen.getByLabelText('First field'));
  });

  it('Escapeで閉じ、呼び出し元のボタンへフォーカスを戻す', async () => {
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    await userEvent.click(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Tabは末尾から先頭へ、Shift+Tabは先頭から末尾へ折り返す（フォーカストラップ）', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    const field = screen.getByLabelText('First field');
    const close = screen.getByRole('button', { name: 'Close' });

    close.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(field);

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(close);
  });

  it('中間要素のTabはブラウザ既定のまま次の要素へ進む', async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    screen.getByLabelText('First field').focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Middle' }));
  });

  it('フォーカス可能要素が無いダイアログではダイアログ本体を保持する', async () => {
    render(<Host empty />);
    await userEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    await userEvent.tab();
    expect(document.activeElement).toBe(dialog);
  });

  it('open=falseの間はEscapeを拾わない', async () => {
    const onClose = vi.fn();
    function Closed() {
      const ref = useModalBehavior<HTMLDivElement>({ open: false, onClose });
      return <div ref={ref} tabIndex={-1} />;
    }
    render(<Closed />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });
});
