// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { DraftRestoreBanner } from './DraftRestoreBanner';

afterEach(cleanup);

describe('DraftRestoreBanner', () => {
  it('保存日時つきで復元を促し、復元/破棄を選ばせる', async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    render(<DraftRestoreBanner savedAt="2026-07-27T09:30:00.000Z" onRestore={onRestore} onDiscard={onDiscard} />);
    expect(screen.getByRole('status').textContent).toMatch(/Unsaved edits from \d{4}-\d{2}-\d{2} \d{2}:\d{2} were found/);

    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('日本語設定では日本語で表示する', () => {
    render(<I18nProvider initialLanguage="ja"><DraftRestoreBanner savedAt="2026-07-27T09:30:00.000Z" onRestore={vi.fn()} onDiscard={vi.fn()} /></I18nProvider>);
    expect(screen.getByRole('status').textContent).toContain('未保存の編集内容があります');
    expect(screen.getByRole('button', { name: '復元' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '破棄' })).toBeTruthy();
  });

  it('保存日時が壊れていてもそのまま表示して落ちない', () => {
    render(<DraftRestoreBanner savedAt="not-a-date" onRestore={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('not-a-date');
  });
});
