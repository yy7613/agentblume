// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  const baseProps = { title: '削除の確認', message: '本当に削除しますか？', confirmLabel: '削除', cancelLabel: 'キャンセル', onConfirm: vi.fn(), onCancel: vi.fn() };

  it('open=falseでは何も描画しない', () => {
    render(<ConfirmDialog {...baseProps} open={false} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('確認ボタンでonConfirm、キャンセルでonCancelを呼ぶ', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onConfirm={onConfirm} onCancel={onCancel} danger />);
    await userEvent.click(screen.getByRole('button', { name: '削除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('背景クリックでonCancelを呼び、ダイアログ内クリックでは呼ばない', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onCancel={onCancel} />);
    await userEvent.click(screen.getByRole('alertdialog'));
    expect(onCancel).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('presentation'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('busy中は両ボタンをdisabledにする', () => {
    render(<ConfirmDialog {...baseProps} open busy />);
    expect(screen.getByRole('button', { name: '削除' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'キャンセル' })).toHaveProperty('disabled', true);
  });

  it('Escapeで閉じる（キーボードだけで脱出できる）', async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...baseProps} open onCancel={onCancel} />);
    await userEvent.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('開いたら最初のボタンへフォーカスし、Tabをダイアログ内に閉じ込める', async () => {
    render(<ConfirmDialog {...baseProps} open />);
    const cancel = screen.getByRole('button', { name: 'キャンセル' });
    const confirm = screen.getByRole('button', { name: '削除' });
    expect(document.activeElement).toBe(cancel);

    await userEvent.tab();
    expect(document.activeElement).toBe(confirm);
    // 末尾から先頭へ折り返す（背後の画面へ抜けない）。
    await userEvent.tab();
    expect(document.activeElement).toBe(cancel);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('閉じたら開く前の要素へフォーカスを戻す', async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>開く</button>
        <ConfirmDialog {...baseProps} open={open} onCancel={() => setOpen(false)} />
      </>;
    }
    render(<Host />);
    const opener = screen.getByRole('button', { name: '開く' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
