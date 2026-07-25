// @vitest-environment jsdom
import { cleanup, render, screen, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineFeedback } from './InlineFeedback';

afterEach(cleanup);

describe('InlineFeedback', () => {
  it('成功はrole=status、エラーはrole=alertで描画する', () => {
    render(<InlineFeedback kind="success">保存しました</InlineFeedback>);
    expect(screen.getByRole('status').textContent).toBe('保存しました');
    render(<InlineFeedback kind="error">失敗しました</InlineFeedback>);
    expect(screen.getByRole('alert').textContent).toBe('失敗しました');
  });

  it('autoHideMs経過後にonDismissを呼ぶ', () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<InlineFeedback kind="success" autoHideMs={3000} onDismiss={onDismiss}>保存しました</InlineFeedback>);
      act(() => { vi.advanceTimersByTime(2999); });
      expect(onDismiss).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(1); });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
