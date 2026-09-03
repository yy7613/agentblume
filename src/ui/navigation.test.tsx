// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NavigationProvider, ScreenLink, consumePendingOpen, useNavigateScreen, useOpenInScreen, usePendingOpen, type OpenTarget } from './navigation';

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

function Opener({ target }: { readonly target: OpenTarget }) {
  const open = useOpenInScreen();
  return <button type="button" onClick={() => open('Tool', target)}>open</button>;
}

function Receiver({ onOpen }: { readonly onOpen: (target: OpenTarget) => void }) {
  usePendingOpen('Tool', onOpen);
  return <span>tool screen</span>;
}

describe('useOpenInScreen / usePendingOpen', () => {
  afterEach(() => { consumePendingOpen('Tool'); consumePendingOpen('Agent'); });

  it('遷移を要求しつつ開く対象を預け、遷移先画面は mount 時に受け取る', async () => {
    const navigate = vi.fn();
    render(<NavigationProvider navigate={navigate}><Opener target={{ internalId: 'sales-lookup', version: '1.2.0' }} /></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(navigate).toHaveBeenCalledWith('Tool');

    const onOpen = vi.fn();
    render(<Receiver onOpen={onOpen} />);
    expect(onOpen).toHaveBeenCalledWith({ internalId: 'sales-lookup', version: '1.2.0' });
    // 取り出したら消える（次回 mount で同じ項目を勝手に開き直さない）。
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('既に表示中の画面には window イベントで届く（同じ画面内で別の項目を開く）', async () => {
    const onOpen = vi.fn();
    render(<NavigationProvider navigate={vi.fn()}><Receiver onOpen={onOpen} /><Opener target={{ internalId: 'other-tool' }} /></NavigationProvider>);
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: 'other-tool' });
  });

  it('detail の無いイベント・預かりの無い受け手は何もしない（落ちない）', () => {
    const onOpen = vi.fn();
    render(<Receiver onOpen={onOpen} />);
    window.dispatchEvent(new CustomEvent('agentblume:open-target'));
    window.dispatchEvent(new CustomEvent('agentblume:open-target', { detail: { screen: 'Tool' } }));
    expect(onOpen).not.toHaveBeenCalled();
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('受け手の handler は最新のものが呼ばれる（再レンダー後の差し替えが効く）', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<NavigationProvider navigate={vi.fn()}><Receiver onOpen={first} /><Opener target={{ internalId: 't' }} /></NavigationProvider>);
    rerender(<NavigationProvider navigate={vi.fn()}><Receiver onOpen={second} /><Opener target={{ internalId: 't' }} /></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ internalId: 't' });
  });

  it('nodeId / section を含む対象をそのまま受け渡す', async () => {
    const onOpen = vi.fn();
    render(<NavigationProvider navigate={vi.fn()}><Receiver onOpen={onOpen} /><Opener target={{ internalId: 't', version: '2.0.0', nodeId: 'filter-1', section: 'agent-context' }} /></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: 't', version: '2.0.0', nodeId: 'filter-1', section: 'agent-context' });
  });

  it('別画面あての依頼は受け取らない', async () => {
    // Tool あての依頼は、表示中の Agent 画面の受け手には届かない（画面ごとに独立した受け渡し）。
    const agentOpen = vi.fn();
    function AgentReceiver() { usePendingOpen('Agent', agentOpen); return null; }
    render(<NavigationProvider navigate={vi.fn()}><AgentReceiver /><Opener target={{ internalId: 'x' }} /></NavigationProvider>);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(agentOpen).not.toHaveBeenCalled();
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'x' });
  });

  it('同じ画面への依頼は後勝ちで、nodeId / section も含めてそのまま渡る', async () => {
    render(
      <NavigationProvider navigate={vi.fn()}>
        <Opener target={{ internalId: 'first' }} />
        <Opener target={{ internalId: 'second', version: '2.0.0', nodeId: 'filter-1', section: 'output' }} />
      </NavigationProvider>,
    );
    const [first, second] = screen.getAllByRole('button', { name: 'open' });
    await userEvent.click(first as HTMLElement);
    await userEvent.click(second as HTMLElement);
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'second', version: '2.0.0', nodeId: 'filter-1', section: 'output' });
    // 取り出したら消える（1回限り）。
    expect(consumePendingOpen('Tool')).toBeUndefined();
  });

  it('Provider の外でも開く対象は預けられる（遷移だけが no-op）', async () => {
    render(<Opener target={{ internalId: 'x', version: '1.0.0' }} />);
    await userEvent.click(screen.getByRole('button', { name: 'open' }));
    expect(consumePendingOpen('Tool')).toEqual({ internalId: 'x', version: '1.0.0' });
  });
});
