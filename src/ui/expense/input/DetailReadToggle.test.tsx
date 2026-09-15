// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExtractExpenseDetailResultDto } from '../../api/expense-input-types';
import type { ExpenseCapabilitiesDto, ExpenseDetailRecordDto, ExpenseItemDraftDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import { NavigationProvider, consumePendingOpen } from '../../navigation';
import { scope } from '../../scope';
import { DETAIL_READ_STORAGE_KEY, DetailReadToggle, flagMessage } from './DetailReadToggle';

afterEach(() => { cleanup(); localStorage.clear(); consumePendingOpen('Settings'); vi.restoreAllMocks(); });

const ON: ExpenseCapabilitiesDto = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: true }, policyHearing: { enabled: false } };
const OFF: ExpenseCapabilitiesDto = { extraction: { enabled: true, vision: true }, detailExtraction: { enabled: false }, policyHearing: { enabled: false } };

const draft: ExpenseItemDraftDto = { facts: { payeeName: '喫茶 ABC', amount: 1200 }, source: { type: 'image', fileName: 'r.png' }, extraction: { method: 'llm', warnings: [] } };
const detail: ExpenseDetailRecordDto = {
  promptVersion: 'expense-detail/v1', readAt: '2026-09-15T00:00:00.000Z',
  raw: { registrationNumberText: 'T1234', payeeNameText: '喫茶 ABC 新宿店', transactionDateText: null, issueDateText: '2026/9/1', attendees: { countText: '4名', names: [] }, purposeClues: ['打合せ', 'お品代'], route: { from: null, to: null, via: [], fareType: null }, notes: [] },
  disagreements: [{ field: 'payeeName', journalValue: '喫茶 ABC', detailValue: '喫茶 ABC 新宿店' }],
};
const readDraft: ExpenseItemDraftDto = {
  ...draft, facts: { ...draft.facts, attendees: { count: 4 } },
  extraction: { method: 'llm', warnings: [], rejectedRegistrationNumber: 'T1234', flags: ['attendees-read', 'reads-disagree', 'registration-number-rejected'], detail },
};

function transportOf(handler: (path: string, init: RequestInit | undefined) => unknown) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  return { transport: { request } as unknown as ApiTransport, request };
}

function renderReader(capabilities: ExpenseCapabilitiesDto | undefined, initial = false) {
  const onDetailChange = vi.fn();
  const navigate = vi.fn();
  function Harness() {
    const [detailOn, setDetail] = useState(initial);
    return <DetailReadToggle placement="reader" transport={transportOf(() => ({})).transport} scope={scope} onOpen={vi.fn()} capabilities={capabilities}
      detail={detailOn} onDetailChange={(next) => { onDetailChange(next); setDetail(next); }} />;
  }
  render(<NavigationProvider navigate={navigate}><Harness /></NavigationProvider>);
  return { onDetailChange, navigate };
}

function renderDraft(options: { readonly capabilities?: ExpenseCapabilitiesDto | undefined; readonly draft?: ExpenseItemDraftDto; readonly handler?: (path: string, init: RequestInit | undefined) => unknown; readonly images?: readonly string[] } = {}) {
  const { transport, request } = transportOf(options.handler ?? (() => { throw new Error('unexpected'); }));
  const onDraftChange = vi.fn();
  const navigate = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(options.draft ?? draft);
    return <DetailReadToggle placement="draft" transport={transport} scope={scope} onOpen={vi.fn()} capabilities={'capabilities' in options ? options.capabilities : ON}
      draft={current} images={options.images ?? ['data:image/png;base64,AAAA']} onDraftChange={(next) => { onDraftChange(next); setCurrent(next); }} />;
  }
  render(<NavigationProvider navigate={navigate}><Harness /></NavigationProvider>);
  return { request, onDraftChange, navigate };
}

describe('DetailReadToggle (reader)', () => {
  it('正常: 既定は off。切り替えると端末に記憶し、次に開いたとき記憶した値を反映する', async () => {
    const first = renderReader(ON);
    const box = screen.getByLabelText('Also run the additional expense reading (slow, off by default)') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(first.onDetailChange).not.toHaveBeenCalled();
    await userEvent.click(box);
    expect(first.onDetailChange).toHaveBeenLastCalledWith(true);
    expect(localStorage.getItem(DETAIL_READ_STORAGE_KEY)).toBe('true');
    cleanup();

    const second = renderReader(ON);
    await waitFor(() => expect(second.onDetailChange).toHaveBeenCalledWith(true));
    expect((screen.getByLabelText('Also run the additional expense reading (slow, off by default)') as HTMLInputElement).checked).toBe(true);
    await userEvent.click(screen.getByLabelText('Also run the additional expense reading (slow, off by default)'));
    expect(localStorage.getItem(DETAIL_READ_STORAGE_KEY)).toBe('false');
  });

  it('境界: 使えないときは記憶が on でも無効化して off にし、理由と設定を開くボタンを出す（alert にしない）', async () => {
    localStorage.setItem(DETAIL_READ_STORAGE_KEY, 'true');
    const { onDetailChange, navigate } = renderReader(OFF, true);
    await waitFor(() => expect(onDetailChange).toHaveBeenCalledWith(false));
    const box = screen.getByLabelText('Also run the additional expense reading (slow, off by default)') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(screen.getByText('The additional expense reading needs a main model with structured output and vision.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Choose a model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
  });

  it('境界: 可否が未取得・古いサーバー（detailExtraction が無い）でも落ちずに使えない側へ倒す', () => {
    renderReader(undefined);
    expect(screen.getByText('The server has not reported whether the additional reading is available yet.')).toBeTruthy();
    cleanup();
    renderReader({ extraction: { enabled: false, vision: false } } as unknown as ExpenseCapabilitiesDto);
    expect((screen.getByLabelText('Also run the additional expense reading (slow, off by default)') as HTMLInputElement).disabled).toBe(true);
  });

  it('例外: 端末の保存領域が使えなくても off のまま動き、切り替えもできる', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const { onDetailChange } = renderReader(ON);
    await userEvent.click(screen.getByLabelText('Also run the additional expense reading (slow, off by default)'));
    expect(onDetailChange).toHaveBeenLastCalledWith(true);
  });
});

describe('DetailReadToggle (draft)', () => {
  it('正常: 「追加で読む」は画像と下書きを送り、結果の下書きを返して食い違い・警告・印の要約を出す', async () => {
    const result: ExtractExpenseDetailResultDto = { draft: readDraft, disagreements: detail.disagreements, warnings: ['人数は手書きです'] };
    const { request, onDraftChange } = renderDraft({ handler: () => ({ result }) });
    await userEvent.click(screen.getByRole('button', { name: 'Read more details' }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(readDraft));
    expect(request.mock.calls[0]?.[0]).toBe('/expense/receipts/extract-detail');
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ scope, images: ['data:image/png;base64,AAAA'], draft });

    const table = screen.getByRole('table', { name: 'Where the two readings disagree' });
    expect(table.textContent).toContain('Payee');
    expect(table.textContent).toContain('喫茶 ABC 新宿店');
    expect(screen.getByText('人数は手書きです')).toBeTruthy();
    expect(screen.getByText('Attendees were filled from the additional reading (not confirmed).')).toBeTruthy();
    expect(screen.getByText('The registration number was not used (read: "T1234"). Compare it with the receipt and enter it.')).toBeTruthy();
    // 食い違いの表を出すときは reads-disagree の文は重ねない。
    expect(screen.queryByText('The two readings disagree. Compare them below.')).toBeNull();
  });

  it('正常: 目的の候補は自動で入れず、チップを押すと purpose と purpose-read を足した下書きを返す', async () => {
    const { onDraftChange } = renderDraft({ draft: readDraft });
    expect(readDraft.facts.purpose).toBeUndefined();
    const chip = screen.getByRole('button', { name: '打合せ' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(chip);
    const next = onDraftChange.mock.calls[0]?.[0] as ExpenseItemDraftDto;
    expect(next.facts.purpose).toBe('打合せ');
    expect(next.extraction.flags).toEqual(['attendees-read', 'reads-disagree', 'registration-number-rejected', 'purpose-read']);
    expect(screen.getByRole('button', { name: '打合せ' }).getAttribute('aria-pressed')).toBe('true');
    // 既に purpose-read があれば重ねない。
    await userEvent.click(screen.getByRole('button', { name: 'お品代' }));
    expect((onDraftChange.mock.calls[1]?.[0] as ExpenseItemDraftDto).extraction.flags?.filter((flag) => flag === 'purpose-read')).toHaveLength(1);
  });

  it('境界: 使えないときはボタンを無効にして理由を出す。画像が無い下書きも押せない', async () => {
    const { navigate } = renderDraft({ capabilities: OFF });
    expect((screen.getByRole('button', { name: 'Read more details' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The additional expense reading needs a main model with structured output and vision.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose a model in Settings' }));
    expect(navigate).toHaveBeenCalledWith('Settings');
    cleanup();
    renderDraft({ images: [] });
    expect((screen.getByRole('button', { name: 'Read more details' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('異常: 409 EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE は「設定でモデルを選ぶと使えます」+ 設定を開くボタン', async () => {
    renderDraft({ handler: () => { throw new ApiError(409, 'EXPENSE_DETAIL_EXTRACTION_UNAVAILABLE', 'no model', undefined, { details: { missing: 'vision' } }); } });
    await userEvent.click(screen.getByRole('button', { name: 'Read more details' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The additional reading is not available');
    expect(alert.textContent).toContain('Next step: choose a model in Settings to use this.');
    expect(screen.getByRole('button', { name: 'Choose a model in Settings' })).toBeTruthy();
  });

  it('異常: その他の失敗は原因と「もう一度試す」。もう一度試すと成功を反映する', async () => {
    let calls = 0;
    const { onDraftChange } = renderDraft({ handler: () => { calls += 1; if (calls === 1) throw new Error('timeout at model'); return { result: { draft: readDraft, disagreements: [], warnings: [] } }; } });
    await userEvent.click(screen.getByRole('button', { name: 'Read more details' }));
    expect(await screen.findByText('Could not read the details: timeout at model')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(readDraft));
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    // 結果の食い違いが空なら、下書きに残る記録の食い違いを出す。
    expect(screen.getByRole('table', { name: 'Where the two readings disagree' })).toBeTruthy();
  });

  it('例外: 実行中は「中断」を出し、中断は失敗として扱わない', async () => {
    renderDraft({
      handler: (_path, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); });
      }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Read more details' }));
    expect(screen.getByText('Reading details…')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Stopped. The first reading is unchanged.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Read more details' })).toBeTruthy();
  });

  it('境界: 印の文言はすべての印に用意し、却下した登録番号が無ければ値を出さない', () => {
    const text = (english: string) => english;
    const flags = ['detail-read-failed', 'transaction-date-substituted', 'registration-number-rejected', 'attendees-read', 'route-read', 'payee-read', 'purpose-read', 'payee-from-report', 'reads-disagree'] as const;
    for (const flag of flags) expect(flagMessage(flag, draft, text)).toBeTruthy();
    expect(flagMessage('registration-number-rejected', draft, text)).toBe('The registration number was not used. Compare it with the receipt and enter it.');
  });

  it('正常: 追加読取の失敗の印・取引日の代用の印は、読取の後の下書きを開いただけで要約に出る', () => {
    renderDraft({ draft: { ...draft, extraction: { method: 'llm', warnings: [], flags: ['detail-read-failed', 'transaction-date-substituted', 'reads-disagree'] } } });
    expect(screen.getByText('The additional reading failed. The first reading can still be used as is.')).toBeTruthy();
    expect(screen.getByText('No transaction date was printed, so the issue date is used. Check the date of use.')).toBeTruthy();
    expect(screen.getByText('The two readings disagree. Compare them below.')).toBeTruthy();
    expect(screen.queryByLabelText('Purpose candidates')).toBeNull();
  });
});
