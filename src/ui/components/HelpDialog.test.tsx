// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { SCREENS } from '../screens';
import { screenHelp } from '../help-content';
import { HelpDialog } from './HelpDialog';

afterEach(cleanup);

describe('HelpDialog', () => {
  it('表示中の画面の説明と手順を出す', () => {
    render(<HelpDialog screen="Data" onClose={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Data sources' })).toBeTruthy();
    expect(screen.getByText(/Register the CSV\/JSON files/)).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBe(screenHelp('Data').steps.length);
  });

  it('ドキュメントはリンクではなくリポジトリ内パスとして示す（ブラウザから開けないため）', () => {
    render(<HelpDialog screen="Factory" onClose={vi.fn()} />);
    expect(screen.getByText('docs/16-agent-factory.md')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('日本語表示に切り替わる', () => {
    render(<I18nProvider initialLanguage="ja"><HelpDialog screen="Settings" onClose={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('heading', { name: '設定' })).toBeTruthy();
  });

  it('Escapeで閉じる', async () => {
    const onClose = vi.fn();
    render(<HelpDialog screen="Chat" onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('閉じるボタンで閉じる', async () => {
    const onClose = vi.fn();
    render(<HelpDialog screen="Chat" onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('全画面ぶんのヘルプが定義されている（未定義の画面で空ダイアログにならない）', () => {
    for (const name of SCREENS) {
      const help = screenHelp(name);
      expect(help.title.ja).not.toBe('');
      expect(help.summary.ja).not.toBe('');
      expect(help.steps.length).toBeGreaterThan(0);
    }
  });
});
