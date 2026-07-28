// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider, ScreenLink, useNavigateScreen } from './navigation';

afterEach(cleanup);

function Probe() {
  const navigate = useNavigateScreen();
  return <button type="button" onClick={() => navigate('Agent')}>go</button>;
}

describe('useNavigateScreen', () => {
  it('Provider が渡した遷移関数を画面IDつきで呼ぶ', async () => {
    const navigate = vi.fn();
    render(<NavigationProvider navigate={navigate}><Probe /></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(navigate).toHaveBeenCalledWith('Agent');
  });

  it('Provider の外では遷移せず、描画も落ちない（画面単体テスト向け）', async () => {
    render(<Probe />);
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByRole('button', { name: 'go' })).toBeTruthy();
  });
});

describe('ScreenLink', () => {
  it('クリックで指定画面への遷移を要求する', async () => {
    const navigate = vi.fn();
    render(<NavigationProvider navigate={navigate}><ScreenLink to="Data">データソース画面へ</ScreenLink></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'データソース画面へ' }));
    expect(navigate).toHaveBeenCalledWith('Data');
  });

  it('hashを直接書き換えないので未保存確認を飛び越えない（buttonでありlinkではない）', () => {
    render(<NavigationProvider navigate={vi.fn()}><ScreenLink to="Tool">tool</ScreenLink></NavigationProvider>);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: 'tool' }).getAttribute('type')).toBe('button');
  });
});
