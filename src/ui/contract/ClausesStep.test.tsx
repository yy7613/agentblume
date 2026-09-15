// @vitest-environment jsdom
/**
 * 条項抽出と確認。抽出（成功・中断・409）、理由のボタンの振り分け、競合候補の選択、本文の選択を根拠にする手指定、
 * 値の型ごとの入力が確定の本文へ正しく載ること、締結済みで編集できないことを守る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { ClauseDto, ContractCapabilitiesDto, ContractDocumentDto, PlaybookDto } from '../api/contract-types';
import { ApiError } from '../api/tool-api';
import { consumePendingOpen } from '../navigation';
import { ClausesStep } from './ClausesStep';

afterEach(() => { cleanup(); consumePendingOpen('Settings'); vi.restoreAllMocks(); });

function fakeApi(overrides: Partial<Record<keyof ContractApi, unknown>>): ContractApi {
  const cache = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn(async () => { throw new Error(`unexpected call ${String(key)}`); }));
      return cache.get(key);
    },
  }) as ContractApi;
}

const enabled: ContractCapabilitiesDto = { extraction: { enabled: true, vision: false }, review: { llm: false } };
const disabled: ContractCapabilitiesDto = { extraction: { enabled: false, vision: false }, review: { llm: false } };

const BODY = '第2条（契約期間）\n本契約の有効期間は、2026年4月1日から2027年3月31日までとする。\n第4条（支払）\n翌々月末日に支払う。';
const fourth = BODY.indexOf('第4条');
const paymentQuote = '翌々月末日に支払う。';
const paymentAt = BODY.indexOf(paymentQuote);

const playbook = {
  id: 'pb-1', name: '業務委託', isDefault: true, ourRole: 'client', ourCompanyNames: [],
  topics: [
    { id: 'court', label: '管轄', valueKind: 'jurisdiction', keywords: [], guidance: '', enabled: true, sortOrder: 40 },
    { id: 'term', label: '契約期間', valueKind: 'term', keywords: [], guidance: '', enabled: true, sortOrder: 10 },
    { id: 'payment', label: '支払条件', valueKind: 'payment_terms', keywords: [], guidance: '', enabled: true, sortOrder: 20 },
    { id: 'notice', label: '通知期限', valueKind: 'notice', keywords: [], guidance: '', enabled: true, sortOrder: 30 },
    { id: 'hidden', label: '無効なトピック', valueKind: 'text', keywords: [], guidance: '', enabled: false, sortOrder: 5 },
  ],
  criteria: [],
} as unknown as PlaybookDto;

const clauses: ClauseDto[] = [
  { topicId: 'term', present: true, articleRef: '第2条', confidence: 0.82, evidence: [{ quote: '本契約の有効期間は', start: BODY.indexOf('本契約'), end: BODY.indexOf('本契約') + 9, verified: true }], value: { kind: 'term', startDate: '2026-04-01', startsOnSigning: false }, source: 'llm', warnings: [] },
  {
    topicId: 'payment', present: true, articleRef: '第4条第2項', evidence: [{ quote: '翌々月末日払い', verified: false }], source: 'llm',
    warnings: [
      { code: 'extraction-failed', message: 'm', origin: 'extraction' },
      { message: '自由記述の注意', origin: 'extraction' },
      { code: 'conflicting-clauses', message: 'c', origin: 'extraction' },
      { code: 'quote-not-found', message: 'q', origin: 'extraction' },
    ],
    candidates: [
      { articleRef: '第4条', evidence: [{ quote: paymentQuote, start: paymentAt, end: paymentAt + paymentQuote.length, verified: true }], value: { kind: 'payment_terms', basis: 'invoice' } },
      { evidence: [{ quote: '別紙の定めによる', verified: false }] },
    ],
  },
  { topicId: 'court', present: false, evidence: [], source: 'llm', warnings: [{ code: 'clause-missing', message: 'x', origin: 'extraction' }, { code: 'role-not-set', message: 'r', origin: 'extraction' }] },
] as ClauseDto[];

function documentOf(extra: Partial<ContractDocumentDto> = {}): ContractDocumentDto {
  return {
    id: 'doc-1', title: '保守業務委託', source: { type: 'text' }, body: BODY, pages: [],
    articles: [{ ref: '第2条', heading: '契約期間', start: 0, end: fourth, page: 1 }, { ref: '第4条', heading: '支払', start: fourth, end: BODY.length, page: 1 }],
    parties: { A: { label: '甲' }, B: { label: '乙' } }, ourParty: 'A', counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' },
    clauses, status: 'extracted', createdAt: 'c', updatedAt: 'u', ...extra,
  };
}

interface Setup {
  readonly document?: ContractDocumentDto;
  readonly capabilities?: ContractCapabilitiesDto;
  readonly playbook?: PlaybookDto | null;
  readonly focusTopic?: { readonly topicId: string; readonly seq: number };
  readonly overrides?: Partial<Record<keyof ContractApi, unknown>>;
}

function setup(options: Setup = {}) {
  const document = options.document ?? documentOf();
  const api = fakeApi({
    extract: vi.fn(async () => ({ ...document, status: 'extracted' })),
    confirmClauses: vi.fn(async () => ({ ...document, status: 'confirmed' })),
    ...options.overrides,
  });
  const onChanged = vi.fn();
  const onAction = vi.fn();
  const props = (next: ContractDocumentDto) => <ClausesStep api={api} capabilities={options.capabilities ?? enabled} document={next} {...(options.playbook === null ? {} : { playbook: options.playbook ?? playbook })} {...(options.focusTopic === undefined ? {} : { focusTopic: options.focusTopic })} onChanged={onChanged} onAction={onAction} />;
  const view = render(props(document));
  return { api, onChanged, onAction, rerender: (next: ContractDocumentDto) => view.rerender(props(next)) };
}

const card = (label: string) => screen.getByRole('heading', { name: label }).closest('article')!;
const confirmedClauses = (api: ContractApi) => vi.mocked(api.confirmClauses).mock.calls.at(-1)?.[2].clauses ?? [];
const clauseOf = (api: ContractApi, topicId: string) => confirmedClauses(api).find((clause) => clause.topicId === topicId);

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
}

/** 本文の [from, to) を選んだことにする（区間の data-start とテキストノードのオフセットで表す）。 */
function selectText(from: number, to: number): void {
  const body = screen.getByLabelText('Contract text');
  const spanAt = (position: number) => [...body.querySelectorAll<HTMLElement>('[data-start]')].filter((node) => Number(node.dataset['start']) <= position).at(-1)!;
  const start = spanAt(from);
  const end = spanAt(to - 1);
  vi.spyOn(window, 'getSelection').mockReturnValue({
    isCollapsed: false, rangeCount: 1,
    getRangeAt: () => ({ startContainer: start.firstChild, startOffset: from - Number(start.dataset['start']), endContainer: end.firstChild, endOffset: to - Number(end.dataset['start']) }),
  } as unknown as Selection);
  fireEvent.mouseUp(body);
}

describe('ClausesStep: 抽出', () => {
  it('正常: AI 抽出が使えなければ設定への導線を出し、抽出を押せない。無効なトピックは並べず並び順に従う', async () => {
    setup({ capabilities: disabled });
    expect(screen.getByText(/AI extraction is not available/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Extract clauses' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Set the main model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    expect(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual(['契約期間', '支払条件', '通知期限', '管轄']);
  });

  it('正常: 抽出は審査基準を指定して送り、結果を親へ渡して確認を促す', async () => {
    const { api, onChanged } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Extract clauses' }));
    expect(await screen.findByText('Extraction finished. Check each value and its evidence, then confirm.')).toBeTruthy();
    expect(api.extract).toHaveBeenCalledWith(expect.anything(), 'doc-1', { playbookId: 'pb-1' }, expect.any(AbortSignal));
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1' }));
  });

  it('例外: 抽出中は経過秒と中断を出し、中断すると何も保存していないと伝える', async () => {
    setup({ overrides: { extract: vi.fn((_scope: unknown, _id: unknown, _options: unknown, signal: AbortSignal) => untilAborted(signal)) } });
    await userEvent.click(screen.getByRole('button', { name: 'Extract clauses' }));
    expect(screen.getByText(/Extracting… 0s \(this can take a few minutes\)/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Extraction stopped. Nothing was saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Extract clauses' })).toBeTruthy();
  });

  it('異常: モデルが使えない 409 は設定への導線を出す', async () => {
    setup({ overrides: { extract: vi.fn(async () => { throw new ApiError(409, 'CONTRACT_EXTRACTION_UNAVAILABLE', 'no model'); }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Extract clauses' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: 'Change the model in Settings' })).toBeTruthy();
  });

  it('正常: 読んでいない条文があれば件数を出し、全条文を読ませる', async () => {
    const extraction = { playbookId: 'pb-1', promptTemplateVersion: 'v1', chunks: [], warnings: [], unscannedArticleRefs: ['第5条', '第6条'], scanAllArticles: false, extractedAt: 'e' };
    const { api } = setup({ document: documentOf({ extraction }) });
    expect(screen.getByText('2 articles were not read (no keyword matched).')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Read all articles' })[0]!);
    await waitFor(() => expect(api.extract).toHaveBeenCalledWith(expect.anything(), 'doc-1', { scanAllArticles: true, playbookId: 'pb-1' }, expect.any(AbortSignal)));
  });
});

describe('ClausesStep: 理由とカード', () => {
  it('正常: 理由のボタンは読み直し（条の項を除く）・全条文・設定・カード選択をこの画面で処理し、他は親へ渡す', async () => {
    const { api, onAction } = setup();
    const payment = card('支払条件');
    expect(within(payment).getByText('自由記述の注意')).toBeTruthy();
    expect(within(payment).getByText(/\(not found in the text\)/)).toBeTruthy();
    await userEvent.click(within(payment).getByRole('button', { name: 'Read this article again' }));
    await waitFor(() => expect(api.extract).toHaveBeenCalledWith(expect.anything(), 'doc-1', { articleRefs: ['第4条'], playbookId: 'pb-1' }, expect.any(AbortSignal)));
    await screen.findByText(/Extraction finished/);
    await userEvent.click(within(payment).getByRole('button', { name: 'Change the model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    await userEvent.click(within(payment).getByRole('button', { name: 'Select the evidence in the text' }));
    expect(payment.className).toContain('active');

    const court = card('管轄');
    expect(within(court).getByText('Not found in the contract text.')).toBeTruthy();
    await userEvent.click(within(court).getByRole('button', { name: 'Read all articles' }));
    await waitFor(() => expect(api.extract).toHaveBeenLastCalledWith(expect.anything(), 'doc-1', { scanAllArticles: true, playbookId: 'pb-1' }, expect.any(AbortSignal)));
    await screen.findByText(/Extraction finished/);
    await userEvent.click(within(court).getByRole('button', { name: 'Point to it in the clauses step' }));
    expect(court.className).toContain('active');
    expect(onAction).not.toHaveBeenCalled();
    await userEvent.click(within(court).getByRole('button', { name: 'Set our role' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step', step: 'import' }));
  });

  it('境界: 読み直しで条の参照が無ければ条を絞らずに読み直す', async () => {
    const withoutRef = clauses.map((clause) => clause.topicId === 'payment' ? { ...clause, articleRef: undefined } : clause) as ClauseDto[];
    const { api } = setup({ document: documentOf({ clauses: withoutRef }) });
    await userEvent.click(within(card('支払条件')).getByRole('button', { name: 'Read this article again' }));
    await waitFor(() => expect(api.extract).toHaveBeenCalledWith(expect.anything(), 'doc-1', { playbookId: 'pb-1' }, expect.any(AbortSignal)));
  });

  it('正常: 食い違う候補から優先する条文を選ぶと、その根拠と値を手指定として採り、競合の警告を外す', async () => {
    const { api } = setup();
    const payment = card('支払条件');
    await userEvent.click(within(payment).getByRole('button', { name: `第4条: ${paymentQuote}` }));
    expect(within(payment).queryByText('Choose the clause that prevails')).toBeNull();
    expect(within(payment).getByText(paymentQuote)).toBeTruthy();
    expect(within(payment).queryByRole('button', { name: 'Choose the clause' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    await waitFor(() => expect(api.confirmClauses).toHaveBeenCalled());
    const sent = clauseOf(api, 'payment')!;
    expect(sent).toMatchObject({ articleRef: '第4条', source: 'manual', value: { kind: 'payment_terms', basis: 'invoice' }, evidence: [{ quote: paymentQuote, verified: true }] });
    expect(sent.candidates).toBeUndefined();
    expect(sent.warnings.map((warning) => warning.code)).toEqual(['extraction-failed', undefined, 'quote-not-found']);
  });

  it('境界: 条の参照も値も無い候補を選ぶと、元の参照を残す', async () => {
    const { api } = setup();
    await userEvent.click(within(card('支払条件')).getByRole('button', { name: 'Candidate 2: 別紙の定めによる' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    await waitFor(() => expect(api.confirmClauses).toHaveBeenCalled());
    expect(clauseOf(api, 'payment')).toMatchObject({ articleRef: '第4条第2項', evidence: [{ quote: '別紙の定めによる' }] });
    expect(clauseOf(api, 'payment')?.value).toBeUndefined();
  });

  it('正常: 値の型ごとの入力（日付・数値・真偽・選択・日）と条項なしを確定の本文へ載せ、確定を親へ渡す', async () => {
    const { api, onChanged } = setup();
    const term = card('契約期間');
    expect(within(term).getByText('第2条')).toBeTruthy();
    expect(within(term).getByText('confidence 82%')).toBeTruthy();
    fireEvent.change(within(term).getByLabelText('Start date'), { target: { value: '2026-05-01' } });
    fireEvent.change(within(term).getByLabelText('Duration (months)'), { target: { value: '12' } });
    await userEvent.click(within(term).getByLabelText('Starts on signing'));

    const payment = card('支払条件');
    await userEvent.click(within(payment).getByRole('button', { name: 'Mark as not present' }));
    expect(within(payment).getByText('Not found in the contract text.')).toBeTruthy();
    expect(within(payment).queryByRole('button', { name: 'Mark as not present' })).toBeNull();
    fireEvent.change(within(payment).getByLabelText('Closing day'), { target: { value: 'month_end' } });
    fireEvent.change(within(payment).getByLabelText('Payment day'), { target: { value: '10' } });
    fireEvent.change(within(payment).getByLabelText('Payment method'), { target: { value: 'cash' } });
    fireEvent.change(within(payment).getByLabelText('Counted from'), { target: { value: 'acceptance' } });

    const notice = card('通知期限');
    fireEvent.change(within(notice).getByLabelText('Unit'), { target: { value: 'day' } });

    const court = card('管轄');
    fireEvent.change(within(court).getByLabelText('Court'), { target: { value: '東京地方裁判所' } });
    await userEvent.click(within(court).getByLabelText('Exclusive'));

    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    expect(await screen.findByText('Clauses confirmed. Run the review next.')).toBeTruthy();
    expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'confirmed' }));
    expect(vi.mocked(api.confirmClauses).mock.calls[0]?.[2]).toMatchObject({ ourParty: 'A', playbookId: 'pb-1' });
    expect(clauseOf(api, 'term')).toMatchObject({ source: 'manual', value: { kind: 'term', startDate: '2026-05-01', durationMonths: 12, startsOnSigning: true } });
    expect(clauseOf(api, 'payment')).toMatchObject({ present: true, evidence: [], value: { kind: 'payment_terms', basis: 'acceptance', closingDay: 'month_end', payDay: 10, method: 'cash' } });
    expect(clauseOf(api, 'notice')).toEqual({ topicId: 'notice', present: true, evidence: [], source: 'manual', warnings: [], value: { kind: 'notice', amount: 3, unit: 'day', anchor: 'expiry', businessDays: false } });
    expect(clauseOf(api, 'court')).toMatchObject({ present: true, value: { kind: 'jurisdiction', court: '東京地方裁判所', exclusive: true } });
  });

  it('正常: 本文を選んで「このトピックの根拠にする」と、その範囲と条を根拠にする', async () => {
    const { api } = setup();
    const payment = card('支払条件');
    const useSelection = within(payment).getByRole('button', { name: 'Use the selected text as evidence' }) as HTMLButtonElement;
    expect(useSelection.disabled).toBe(true);
    selectText(paymentAt, paymentAt + 5);
    expect(useSelection.disabled).toBe(false);
    await userEvent.click(useSelection);
    expect(within(payment).getByText('翌々月末日')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    await waitFor(() => expect(api.confirmClauses).toHaveBeenCalled());
    expect(clauseOf(api, 'payment')).toMatchObject({ articleRef: '第4条', source: 'manual', evidence: [{ quote: '翌々月末日', start: paymentAt, end: paymentAt + 5, verified: true }] });
  });

  it('境界: 空白だけの選択は根拠にせず、条項の無いトピックは空のまま', async () => {
    setup();
    const newline = BODY.indexOf('\n');
    selectText(newline, newline + 1);
    const notice = card('通知期限');
    await userEvent.click(within(notice).getByRole('button', { name: 'Use the selected text as evidence' }));
    expect(within(notice).getByText('Not found in the contract text.')).toBeTruthy();
    const term = card('契約期間');
    await userEvent.click(within(term).getByRole('button', { name: 'Use the selected text as evidence' }));
    expect(within(term).getByText('本契約の有効期間は')).toBeTruthy();
  });

  it('正常: 外からのフォーカスとカードのクリックで選択中のカードが変わり、文書が変わると条項を読み直す', async () => {
    const { rerender } = setup({ focusTopic: { topicId: 'court', seq: 1 } });
    expect(card('管轄').className).toContain('active');
    await userEvent.click(card('契約期間'));
    expect(card('契約期間').className).toContain('active');
    expect(card('管轄').className).not.toContain('active');
    rerender(documentOf({ clauses: [] }));
    expect(within(card('契約期間')).getByText('Not found in the contract text.')).toBeTruthy();
  });
});

describe('ClausesStep: 状態と失敗', () => {
  it('境界: 締結登録済みは抽出・全条文・候補・入力・確定をすべて無効にして台帳での修正を案内する', () => {
    const extraction = { promptTemplateVersion: 'v1', chunks: [], warnings: [], unscannedArticleRefs: ['第5条'], scanAllArticles: false, extractedAt: 'e' };
    setup({ document: documentOf({ status: 'signed', extraction }) });
    expect(screen.getByText(/This contract is registered as signed/)).toBeTruthy();
    for (const name of ['Extract clauses', 'Confirm the clauses']) expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByRole('button', { name: 'Read all articles' })[0] as HTMLButtonElement).disabled).toBe(true);
    const payment = card('支払条件');
    expect((within(payment).getByRole('button', { name: `第4条: ${paymentQuote}` }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(payment).getByRole('button', { name: 'Mark as not present' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(payment).getByLabelText('Closing day') as HTMLSelectElement).disabled).toBe(true);
    expect((within(card('契約期間')).getByLabelText('Starts on signing') as HTMLInputElement).disabled).toBe(true);
    expect((within(card('管轄')).getByLabelText('Court') as HTMLInputElement).disabled).toBe(true);
  });

  it('境界: 審査基準が無ければトピックの案内を出し、抽出と確定は審査基準・自社の甲乙を指定せずに送る', async () => {
    const document = documentOf();
    delete (document as { ourParty?: unknown }).ourParty;
    const { api } = setup({ document, playbook: null });
    expect(screen.getByText(/The playbook has no enabled clause types/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Extract clauses' }));
    await waitFor(() => expect(api.extract).toHaveBeenCalledWith(expect.anything(), 'doc-1', {}, expect.any(AbortSignal)));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    await waitFor(() => expect(api.confirmClauses).toHaveBeenCalledWith(expect.anything(), 'doc-1', { clauses }));
  });

  it('異常: 確定の失敗は案内を出す', async () => {
    setup({ overrides: { confirmClauses: vi.fn(async () => { throw new Error('confirm failed'); }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the clauses' }));
    expect((await screen.findByRole('alert')).textContent).toContain('confirm failed');
  });
});
