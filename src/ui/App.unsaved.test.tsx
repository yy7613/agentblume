// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from './api/tool-api';
import { App } from './App';

// Agent画面が「未保存あり」を報告し続ける状態を作り、左ナビでの離脱確認だけを検証する。
vi.mock('./agent-builder/AgentBuilder', async () => {
  const { useReportUnsavedChanges } = await import('./unsaved-changes');
  return { AgentBuilder: () => { useReportUnsavedChanges('agent-builder', true); return <main>Agent builder</main>; } };
});
vi.mock('./skill-builder/SkillBuilder', () => ({ SkillBuilder: () => <main>Skill builder</main> }));
vi.mock('./chat/ChatPage', () => ({ ChatPage: () => <main>Chat page</main> }));
vi.mock('./tool-builder/ToolBuilder', () => ({ ToolBuilder: () => <main>Tool builder</main> }));

beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(cleanup);

describe('未保存の編集がある画面からの離脱', () => {
  it('左ナビのクリックに確認ダイアログを挟み、「とどまる」では遷移しない', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.getByText('Agent builder')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('unsaved edits');
    // 確認中はまだ遷移していない。
    expect(screen.getByText('Agent builder')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Stay' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Agent builder')).toBeTruthy();
    expect(window.location.hash).toBe('#/agent');
  });

  it('「移動する」を選ぶと遷移してURLも変わる', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }));

    expect(await screen.findByText('Skill builder')).toBeTruthy();
    expect(window.location.hash).toBe('#/skill');
  });

  it('確認ダイアログはEscapeでも閉じられ、遷移しない', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Skill' }));
    await screen.findByRole('alertdialog');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('Agent builder')).toBeTruthy();
  });

  it('未保存の間だけ beforeunload で離脱警告を出す', async () => {
    render(<App client={{} as ToolApiClient} />);
    const before = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    const during = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
  });

  it('同じ画面のナビをもう一度押しても確認は出ない', async () => {
    render(<App client={{} as ToolApiClient} />);
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Agent' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
