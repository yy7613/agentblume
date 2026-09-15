// @vitest-environment jsdom
/**
 * チャットの PDF 添付（docs/23 §9.4 C5）。PDF はブラウザでテキスト層を抜いてテキスト添付として送る。
 * テキスト層の無い（スキャン）PDF は送らず、契約画面での文字起こしへ案内する。既存の画像添付は変えない。
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolApiClient } from '../api/tool-api';
import { consumePendingOpen } from '../navigation';
import { ChatPage } from './ChatPage';

const pdf = vi.hoisted(() => ({ result: undefined as unknown as () => Promise<unknown> }));

vi.mock('../contract/pdf-text', () => ({
  extractPdfText: () => pdf.result(),
  joinPages: (pages: readonly { text: string }[]) => ({ body: pages.map((page) => page.text).join('\n'), pages: [] }),
}));

afterEach(cleanup);

const oneAgent = [{ internalId: 'agent', displayName: 'Agent', publishName: 'agent', latestVersion: '1.0.0', kind: 'normal', state: 'draft' }];

function pdfFile(name: string, bytes = 16): File {
  const buffer = new ArrayBuffer(bytes);
  const file = new File([buffer], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => buffer });
  return file;
}

function page(pageNumber: number, text: string, hasTextLayer = true) {
  return { page: pageNumber, text, hasTextLayer };
}

async function setup() {
  const client = {
    listAgents: vi.fn().mockResolvedValue(oneAgent),
    runSavedAgent: vi.fn().mockResolvedValue({ runId: 'run-pdf', response: 'reviewed', trace: [], usage: {}, mode: 'preview' }),
  } as unknown as ToolApiClient;
  render(<ChatPage client={client} />);
  await screen.findByRole('option', { name: /Agent/ });
  return client;
}

async function attach(...files: File[]) {
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, files);
}

describe('ChatPage: PDF のテキスト添付', () => {
  it('正常: テキスト層を抜いて documents として送り、本文は画面の吹き出しに出さない', async () => {
    pdf.result = async () => ({ totalPages: 2, pages: [page(1, '第1条（目的）'), page(2, '第2条（期間）')] });
    const client = await setup();
    await attach(pdfFile('contract.pdf'));
    expect(await screen.findByText(/PDF contract\.pdf · 2 pages/)).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Chat message'), 'review this');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(client.runSavedAgent).toHaveBeenCalledWith(expect.objectContaining({ documents: [{ name: 'contract.pdf', text: '第1条（目的）\n第2条（期間）', pageCount: 2 }] }), expect.any(AbortSignal)));
    expect(await screen.findByText('Attached PDF: contract.pdf (2 pages)')).toBeTruthy();
    expect(screen.queryByText(/第2条（期間）/)).toBeNull();
    expect(client.runSavedAgent).toHaveBeenCalledWith(expect.not.objectContaining({ images: expect.anything() }), expect.any(AbortSignal));
  });

  it('異常: テキスト層の無い PDF は送らず、契約画面での文字起こしへ案内する（ボタンで契約画面の取込を開く）', async () => {
    pdf.result = async () => ({ totalPages: 1, pages: [page(1, '', false)] });
    const client = await setup();
    await attach(pdfFile('scan.pdf'));
    expect(await screen.findByText(/scan\.pdf has no text layer/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open contract review' }));
    expect(consumePendingOpen('Contract')).toEqual({ internalId: '', section: 'import' });
    expect(screen.queryByText(/PDF scan\.pdf/)).toBeNull();
    expect(client.runSavedAgent).not.toHaveBeenCalled();
  });

  it('境界: 一部のページだけテキスト層が無ければ、文字のあるページだけを添付してその旨を出す', async () => {
    pdf.result = async () => ({ totalPages: 3, pages: [page(1, '第1条'), page(2, '', false), page(3, '第3条')] });
    await setup();
    await attach(pdfFile('mixed.pdf'));
    expect(await screen.findByText(/1 of 3 pages of mixed\.pdf have no text layer/)).toBeTruthy();
    expect(screen.getByText(/PDF mixed\.pdf · 3 pages/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/have no text layer/)).toBeNull();
  });

  it('例外: パスワード付き・壊れた PDF は種類ごとに直し方を出す', async () => {
    pdf.result = async () => { throw Object.assign(new Error('locked'), { kind: 'password' }); };
    await setup();
    await attach(pdfFile('locked.pdf'));
    expect(await screen.findByText(/locked\.pdf is password-protected/)).toBeTruthy();
    pdf.result = async () => { throw new Error('bad'); };
    await attach(pdfFile('broken.pdf'));
    expect(await screen.findByText(/broken\.pdf could not be read as a PDF/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open contract review' })).toBeNull();
  });

  it('境界: PDF は 2 件まで、1 件 30 MiB まで、1 件 30 万文字まで', async () => {
    pdf.result = async () => ({ totalPages: 1, pages: [page(1, 'x'.repeat(300_001))] });
    await setup();
    await attach(pdfFile('huge-text.pdf'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('more than 300,000 characters');

    const big = pdfFile('big.pdf');
    Object.defineProperty(big, 'size', { value: 31 * 1024 * 1024 });
    await attach(big);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('larger than 30 MiB'));

    await attach(pdfFile('a.pdf'), pdfFile('b.pdf'), pdfFile('c.pdf'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('up to two PDFs'));
  });

  it('境界: 合計 40 万文字を超える添付は受け付けない', async () => {
    pdf.result = async () => ({ totalPages: 1, pages: [page(1, 'x'.repeat(250_000))] });
    await setup();
    await attach(pdfFile('one.pdf'));
    expect(await screen.findByText(/PDF one\.pdf/)).toBeTruthy();
    await attach(pdfFile('two.pdf'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('exceed 400,000 characters'));
  });
});
