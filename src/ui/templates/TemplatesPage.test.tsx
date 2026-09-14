// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import { NavigationProvider } from '../navigation';
import { BUSINESS_TEMPLATES, TemplatesPage, type BusinessTemplate } from './TemplatesPage';

// 後片付けしないと描画が積み重なり、同じ名前のカードが複数見つかってしまう。
afterEach(() => { cleanup(); });

function renderPage(options: { navigate?: (screen: string) => void; templates?: readonly BusinessTemplate[]; withProvider?: boolean } = {}) {
  const navigate = options.navigate ?? vi.fn();
  const page = <TemplatesPage {...(options.templates === undefined ? {} : { templates: options.templates })} />;
  render(<I18nProvider>{options.withProvider === false ? page : <NavigationProvider navigate={navigate as never}>{page}</NavigationProvider>}</I18nProvider>);
  return navigate;
}

const sample: readonly BusinessTemplate[] = [
  { id: 'b', screen: 'Journal', title: { en: 'Second', ja: '二番目' }, summary: { en: 'later', ja: 'あと' }, order: 20 },
  { id: 'a', screen: 'Tool', title: { en: 'First', ja: '一番目' }, summary: { en: 'earlier', ja: 'さき' }, order: 10 },
];

describe('TemplatesPage', () => {
  it('正常: 業務テンプレートがカードで並び、説明が読める', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: 'Business templates' })).toBeTruthy();
    const card = screen.getByRole('button', { name: 'Journal entries' });
    expect(card.textContent).toContain('Ingest receipts');
  });

  it('正常: カードを押すと、その業務の画面へ遷移を要求する', async () => {
    const navigate = renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Journal entries' }));
    expect(navigate).toHaveBeenCalledWith('Journal');
  });

  it('正常: 一覧は order の昇順で並ぶ（登録順ではない）', () => {
    renderPage({ templates: sample });
    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(labels).toEqual(['First', 'Second']);
  });

  it('境界: 業務が 1 件も無いときは、空であることを言葉で伝える', () => {
    renderPage({ templates: [] });
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText('No business templates are available yet.')).toBeTruthy();
  });

  it('異常: 遷移の仕組みが無い場所で描画しても、押して落ちない', async () => {
    renderPage({ withProvider: false });
    await userEvent.click(screen.getByRole('button', { name: 'Journal entries' }));
    // Provider の外では遷移は no-op。画面はそのまま操作できる。
    expect(screen.getByRole('button', { name: 'Journal entries' })).toBeTruthy();
  });

  it('例外: 同じ画面を指す項目が並んでも、取り違えずそれぞれ開ける', async () => {
    // 業務が増えると、同じ画面へ別の入口を置きたくなることがある（用途別の名前で 2 枚出す等）。
    // id が違えば別カードとして扱われ、押した方の画面が開くことを固定する。
    const navigate = renderPage({
      templates: [
        { id: 'a', screen: 'Journal', title: { en: 'Daily', ja: '日次' }, summary: { en: 'x', ja: 'x' }, order: 1 },
        { id: 'b', screen: 'Journal', title: { en: 'Monthly', ja: '月次' }, summary: { en: 'y', ja: 'y' }, order: 2 },
      ],
    });
    expect(screen.getAllByRole('button')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('Journal');
  });

  it('例外: 既定のカタログは id が重複せず、並び順も一意', () => {
    const ids = BUSINESS_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    const orders = BUSINESS_TEMPLATES.map((template) => template.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
