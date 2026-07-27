// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { routeOf, screenFromHash, slugFromHash, useHashScreen } from './routing';

const SCREENS = ['Chat', 'Tool', 'Agent', 'Harness', 'MCP'] as const;
type Screen = (typeof SCREENS)[number];

afterEach(() => { window.history.replaceState(null, '', '/'); });

describe('routing helpers', () => {
  it('画面idの小文字をroute slugにする', () => {
    expect(routeOf('Harness')).toBe('harness');
    expect(routeOf('MCP')).toBe('mcp');
  });

  it('hashからslugだけを取り出す（#/・クエリ・入れ子パスを無視）', () => {
    expect(slugFromHash('#/agent')).toBe('agent');
    expect(slugFromHash('#agent')).toBe('agent');
    expect(slugFromHash('#/agent?tab=1')).toBe('agent');
    expect(slugFromHash('#/agent/list')).toBe('agent');
    expect(slugFromHash('#/AGENT')).toBe('agent');
    expect(slugFromHash('')).toBe('');
  });

  it('未知・空のhashはfallback画面へ落とす', () => {
    expect(screenFromHash('#/tool', SCREENS, 'Chat')).toBe('Tool');
    expect(screenFromHash('#/nope', SCREENS, 'Chat')).toBe('Chat');
    expect(screenFromHash('', SCREENS, 'Chat')).toBe('Chat');
  });
});

describe('useHashScreen', () => {
  it('起動時のhashから画面を復元する（リロードで同じ画面に戻る）', () => {
    window.history.replaceState(null, '', '#/agent');
    const { result } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    expect(result.current[0]).toBe('Agent');
  });

  it('hashが無ければfallbackを表示し、URLを正規化する', () => {
    const { result } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    expect(result.current[0]).toBe('Chat');
    expect(window.location.hash).toBe('#/chat');
  });

  it('不正なhashはfallbackへ落としつつURLも揃える', () => {
    window.history.replaceState(null, '', '#/does-not-exist');
    const { result } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    expect(result.current[0]).toBe('Chat');
    expect(window.location.hash).toBe('#/chat');
  });

  it('navigateでhashを書き換え、hashchangeで戻ってこられる（往復）', () => {
    const { result } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    act(() => { result.current[1]('Tool'); });
    expect(result.current[0]).toBe('Tool');
    expect(window.location.hash).toBe('#/tool');

    // ブラウザの「戻る」相当: hashを書き換えて hashchange を通知する。
    act(() => {
      window.history.replaceState(null, '', '#/chat');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current[0]).toBe('Chat');
  });

  it('popstateにも反応する', () => {
    const { result } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    act(() => {
      window.history.replaceState(null, '', '#/mcp');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(result.current[0]).toBe('MCP');
  });

  it('unmount後のhash変化では更新しない（リスナーを外す）', () => {
    const { result, unmount } = renderHook(() => useHashScreen<Screen>(SCREENS, 'Chat'));
    unmount();
    act(() => {
      window.history.replaceState(null, '', '#/harness');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(result.current[0]).toBe('Chat');
  });
});
