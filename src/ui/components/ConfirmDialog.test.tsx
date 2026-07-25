// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
});
