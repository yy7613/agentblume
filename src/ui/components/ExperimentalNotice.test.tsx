// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../navigation';
import { ExperimentalBadge, ExperimentalBanner, ExperimentalDisabledPage } from './ExperimentalNotice';

afterEach(() => { cleanup(); });

describe('ExperimentalNotice', () => {
  it('正常: 印は「実験的」と言葉で示し、何が変わりうるかを title で補う', () => {
    render(<I18nProvider><ExperimentalBadge /></I18nProvider>);
    const badge = screen.getByText('Experimental');
    expect(badge.getAttribute('title')).toContain('may change');
  });

  it('境界: 幅の狭い左ナビ用は「β」だけを見せ、置いた側のボタンの名前を変えないよう読み上げから外す', () => {
    render(<I18nProvider><button type="button">Templates<ExperimentalBadge compact /></button></I18nProvider>);
    expect(screen.getByRole('button', { name: 'Templates' })).toBeTruthy();
    const badge = screen.getByText('β');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.getAttribute('title')).toContain('may change');
  });

  it('正常: 非表示のときの案内は、理由と有効にする場所を示し、設定へ一手で行ける', async () => {
    const navigate = vi.fn();
    render(<I18nProvider><NavigationProvider navigate={navigate as never}><ExperimentalDisabledPage /></NavigationProvider></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Experimental features are hidden' })).toBeTruthy();
    expect(screen.getByText(/Show experimental features/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
  });

  it('正常: 注意書きは note として、変わりうることと人が確認すべきことを伝える', () => {
    render(<I18nProvider><ExperimentalBanner /></I18nProvider>);
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('experimental feature');
    expect(note.textContent).toContain('have a person review the results');
  });
});
