// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExperimentalFeaturesProvider, useExperimentalFeatures } from './experimental-features';

const KEY = 'agentcontext.experimentalFeatures';

function Probe() {
  const { enabled, setEnabled } = useExperimentalFeatures();
  return <button type="button" onClick={() => setEnabled(!enabled)}>{enabled ? 'on' : 'off'}</button>;
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ExperimentalFeaturesProvider', () => {
  it('正常: 初期値は非表示で、切り替えるとこのブラウザに保存される', () => {
    render(<ExperimentalFeaturesProvider><Probe /></ExperimentalFeaturesProvider>);
    expect(screen.getByRole('button').textContent).toBe('off');
    act(() => { screen.getByRole('button').click(); });
    expect(screen.getByRole('button').textContent).toBe('on');
    expect(localStorage.getItem(KEY)).toBe('on');
  });

  it('正常: 保存済みの「表示する」を次に開いたときも引き継ぐ', () => {
    localStorage.setItem(KEY, 'on');
    render(<ExperimentalFeaturesProvider><Probe /></ExperimentalFeaturesProvider>);
    expect(screen.getByRole('button').textContent).toBe('on');
  });

  it('境界: 保存値が壊れていたら非表示へ倒す', () => {
    localStorage.setItem(KEY, 'yes');
    render(<ExperimentalFeaturesProvider><Probe /></ExperimentalFeaturesProvider>);
    expect(screen.getByRole('button').textContent).toBe('off');
  });

  it('例外: Storage が使えない環境でも非表示で描け、切り替えも落ちない', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    render(<ExperimentalFeaturesProvider><Probe /></ExperimentalFeaturesProvider>);
    expect(screen.getByRole('button').textContent).toBe('off');
    act(() => { screen.getByRole('button').click(); });
    expect(screen.getByRole('button').textContent).toBe('on');
  });

  it('異常: Provider の外では非表示として振る舞う（入口を誤って見せない）', () => {
    render(<Probe />);
    expect(screen.getByRole('button').textContent).toBe('off');
  });
});
