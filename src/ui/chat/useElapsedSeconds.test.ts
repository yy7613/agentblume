// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useElapsedSeconds } from './useElapsedSeconds';

describe('useElapsedSeconds', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('busy=falseの間は0を返す', () => {
    const { result } = renderHook(() => useElapsedSeconds(false));
    expect(result.current).toBe(0);
  });

  it('busy=trueの間、1秒毎にインクリメントする', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useElapsedSeconds(true));
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(999); });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(1);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBe(3);
  });

  it('busyがtrueへ切り替わるたびに0から数え直す', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ busy }) => useElapsedSeconds(busy), { initialProps: { busy: true } });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(result.current).toBe(2);
    rerender({ busy: false });
    expect(result.current).toBe(0);
    rerender({ busy: true });
    expect(result.current).toBe(0);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(result.current).toBe(1);
  });

  it('unmount時にタイマーを止める', () => {
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useElapsedSeconds(true));
    unmount();
    // unmount後にタイマーを進めても例外にならない（interval破棄済み）ことを確認する。
    expect(() => act(() => { vi.advanceTimersByTime(5000); })).not.toThrow();
  });
});
