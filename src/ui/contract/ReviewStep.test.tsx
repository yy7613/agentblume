// @vitest-environment jsdom
/**
 * レビュー。実行（成功・中断・失敗）、件数と判定の表示、理由のボタンの振り分け（コピー・再レビュー・設定・カード選択・親へ）、
 * 人の判断の保存と確定、確定済み・stale の扱いを守る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { ContractCapabilitiesDto, ContractDocumentDto, ReviewEnvelopeDto } from '../api/contract-types';
import { consumePendingOpen } from '../navigation';
import { ReviewStep } from './ReviewStep';

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

const llmOn: ContractCapabilitiesDto = { extraction: { enabled: true, vision: false }, review: { llm: true } };
const llmOff: ContractCapabilitiesDto = { extraction: { enabled: true, vision: false }, review: { llm: false } };

const BODY = '第4条（支払）\n翌々月末日に支払う。';

function documentOf(extra: Partial<ContractDocumentDto> = {}): ContractDocumentDto {
  return {
    id: 'doc-1', title: '保守業務委託', source: { type: 'text' }, body: BODY, pages: [], articles: [{ ref: '第4条', start: 0, end: BODY.length, page: 1 }],
    parties: { A: { label: '甲' }, B: { label: '乙' } }, counterpartyProfile: { toriteki: 'yes', freelance: 'no' },
    clauses: [{ topicId: 'payment', present: true, evidence: [{ quote: '翌々月末日', start: 9, end: 14, verified: true }], source: 'llm', warnings: [] }],
    extraction: { playbookId: 'pb-1', promptTemplateVersion: 'v1', chunks: [], warnings: [], unscannedArticleRefs: [], scanAllArticles: false, extractedAt: 'e' },
    status: 'confirmed', createdAt: 'c', updatedAt: 'u', ...extra,
  };
}

function reviewOf(extra: Partial<ReviewEnvelopeDto['review']> = {}): ReviewEnvelopeDto {
  return {
    notice: 'この結果は審査基準との照合です。法的な判断ではありません。',
    review: {
      id: 'rev-1', documentId: 'doc-1', playbookId: 'pb-1', playbookName: '業務委託（発注者側）',
      playbookSnapshot: {} as ReviewEnvelopeDto['review']['playbookSnapshot'], playbookSnapshotAt: 'u',
      results: [
        { topicId: 'term', topicLabel: '契約期間', verdict: 'accept', present: true, reasons: [], criteria: [{ criterionId: 'term-llm', outcome: 'pass', llm: { answer: 'yes', evidenceQuote: null, reasoning: '期間は明確' } }], recommendedTexts: [], humanDecision: 'negotiate', humanNote: '既存メモ' },
        {
          topicId: 'payment', topicLabel: '支払条件', verdict: 'reject', present: true,
          reasons: [
            { code: 'payment-over-limit', criterionId: 'payment-max-days', topicId: 'payment', detail: { maxDays: 92, limit: 60, worstCase: '7/1 → 9/30' } },
            { code: 'llm-unavailable', topicId: 'payment' },
            { code: 'review-stale', topicId: 'payment' },
          ],
          criteria: [{ criterionId: 'payment-llm', outcome: 'fail', llm: { answer: 'no', evidenceQuote: '翌々月末日', reasoning: '長すぎる' } }, { criterionId: 'payment-max-days', outcome: 'fail' }],
          recommendedTexts: ['当社は60日以内に支払う。'],
        },
        { topicId: 'ip', topicLabel: '知的財産', verdict: 'unresolved', present: false, reasons: [{ code: 'unmapped-code' }], criteria: [], recommendedTexts: [] },
      ],
      documentFindings: [{ code: 'stamp-duty-candidate', detail: { name: '第7号文書', nature: 'basic_transaction', amount: 4000 } }],
      overall: 'reject', status: 'draft', stale: false, createdAt: 'c', updatedAt: 'u', ...extra,
    },
  };
}

interface Setup {
  readonly document?: ContractDocumentDto;
  readonly review?: ReviewEnvelopeDto;
  readonly capabilities?: ContractCapabilitiesDto;
  readonly overrides?: Partial<Record<keyof ContractApi, unknown>>;
}

function setup(options: Setup = {}) {
  const api = fakeApi({
    runReview: vi.fn(async () => reviewOf()),
    saveDecisions: vi.fn(async () => reviewOf()),
    finalizeReview: vi.fn(async () => reviewOf({ status: 'finalized' })),
    ...options.overrides,
  });
  const onReview = vi.fn();
  const onDocumentChanged = vi.fn();
  const onAction = vi.fn();
  const element = (review: ReviewEnvelopeDto | undefined) => <ReviewStep api={api} capabilities={options.capabilities ?? llmOn} document={options.document ?? documentOf()} {...(review === undefined ? {} : { review })} onReview={onReview} onDocumentChanged={onDocumentChanged} onAction={onAction} />;
  const view = render(element(options.review));
  return { api, onReview, onDocumentChanged, onAction, rerender: (review: ReviewEnvelopeDto) => view.rerender(element(review)) };
}

const card = (label: string) => screen.getByRole('heading', { name: label }).closest('article')!;

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
}

/** user-event はクリップボードを自前のスタブに差し替えるので、押す直前に置き直して呼ばれ方を見る。 */
function stubClipboard() {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  return writeText;
}

describe('ReviewStep: 実行', () => {
  it('境界: 条項を確定していなければレビューを出さず、条項抽出へ案内する', async () => {
    const { onAction } = setup({ document: documentOf({ status: 'extracted' }) });
    expect(screen.getByText('Confirm the clauses first.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the clauses step' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'step', step: 'clauses', label: '' });
  });

  it('正常: 未実行なら固定文言と空状態を出し、抽出時の審査基準でレビューして親へ渡す', async () => {
    const { api, onReview, onDocumentChanged } = setup({ capabilities: llmOff });
    expect(screen.getByRole('note').textContent).toContain('It is not legal advice');
    expect(screen.getByText(/No review yet/)).toBeTruthy();
    expect(screen.getByText(/AI yes\/no criteria need a model/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Run the review' }));
    await waitFor(() => expect(onDocumentChanged).toHaveBeenCalled());
    expect(api.runReview).toHaveBeenCalledWith(expect.anything(), 'doc-1', 'pb-1', expect.any(AbortSignal));
    expect(onReview).toHaveBeenCalledWith(reviewOf());
  });

  it('例外: レビュー中は経過秒と中断を出し、中断すると何も保存していないと伝える', async () => {
    const document = documentOf();
    delete (document as { extraction?: unknown }).extraction;
    const { api, onReview } = setup({ document, overrides: { runReview: vi.fn((_scope: unknown, _id: unknown, _playbookId: unknown, signal: AbortSignal) => untilAborted(signal)) } });
    await userEvent.click(screen.getByRole('button', { name: 'Run the review' }));
    expect(screen.getByText('Reviewing… 0s')).toBeTruthy();
    expect(api.runReview).toHaveBeenCalledWith(expect.anything(), 'doc-1', undefined, expect.any(AbortSignal));
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByText('Review stopped. Nothing was saved.')).toBeTruthy();
    expect(onReview).not.toHaveBeenCalled();
  });

  it('異常: レビューの失敗は案内を出す', async () => {
    setup({ overrides: { runReview: vi.fn(async () => { throw new Error('review failed'); }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Run the review' }));
    expect((await screen.findByRole('alert')).textContent).toContain('review failed');
  });
});

describe('ReviewStep: 結果', () => {
  it('正常: サーバーの固定文言・総合判定・人の判断を優先した件数・文書全体の所見・AI の回答と引用を出す', async () => {
    const { onAction } = setup({ review: reviewOf() });
    expect(screen.getByRole('note').textContent).toBe('この結果は審査基準との照合です。法的な判断ではありません。');
    expect(screen.queryByText(/AI yes\/no criteria need a model/)).toBeNull();
    for (const label of ['Not acceptable 1', 'Negotiate 1', 'Needs a decision 1', 'Acceptable 0']) expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('Playbook: 業務委託（発注者側）')).toBeTruthy();
    // 実行済みなら上部のボタンは「再レビュー」になる（先頭がツールバー。カード内の stale 理由にも同名がある）。
    expect((screen.getAllByRole('button', { name: 'Run the review again' })[0] as HTMLButtonElement).closest('.contract-toolbar')).not.toBeNull();

    const term = card('契約期間');
    expect(within(term).getByText(/期間は明確/).textContent).toContain('AI answer: yes');
    expect((within(term).getByLabelText('Negotiate') as HTMLInputElement).checked).toBe(true);
    expect((within(term).getByLabelText('Note') as HTMLInputElement).value).toBe('既存メモ');
    expect(within(card('支払条件')).getByText('翌々月末日', { selector: 'q' })).toBeTruthy();
    expect(within(card('知的財産')).getByText('clause not present')).toBeTruthy();

    expect(screen.getByText(/This may be a taxable document \(第7号文書/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Record the stamp on the sign step' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step', step: 'sign' }));
  });

  it('正常: 推奨文案はコピーでき、審査基準へのボタンは親へ、設定はその場で、再レビューは実行、レビュー内の移動はカード選択にする', async () => {
    const { api, onAction } = setup({ review: reviewOf() });
    const payment = card('支払条件');
    expect(within(payment).getByText(/Payment can fall up to day 92 after receipt/)).toBeTruthy();

    let writeText = stubClipboard();
    fireEvent.click(within(payment).getByRole('button', { name: 'Copy the suggested wording' }));
    expect(writeText).toHaveBeenCalledWith('当社は60日以内に支払う。');
    expect(screen.getByText('Copied the suggested wording.')).toBeTruthy();
    writeText = stubClipboard();
    fireEvent.click(within(payment).getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('当社は60日以内に支払う。');

    await userEvent.click(within(payment).getByRole('button', { name: 'Open the legal settings' }));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'step', step: 'playbook', nodeId: 'legal' }));
    await userEvent.click(within(payment).getByRole('button', { name: 'Change the model in Settings' }));
    expect(consumePendingOpen('Settings')).toEqual({ internalId: 'main', section: 'model-slot' });
    await userEvent.click(within(payment).getByRole('button', { name: 'Run the review again' }));
    await waitFor(() => expect(api.runReview).toHaveBeenCalledTimes(1));

    onAction.mockClear();
    const ip = card('知的財産');
    await userEvent.click(within(ip).getByRole('button', { name: 'Open the review' }));
    expect(ip.className).toContain('active');
    await userEvent.click(within(payment).getByRole('button', { name: 'Enter the decision' }));
    expect(payment.className).toContain('active');
    expect(ip.className).not.toContain('active');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('例外: クリップボードが使えない環境でもコピーで落ちない', () => {
    setup({ review: reviewOf() });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    fireEvent.click(within(card('支払条件')).getByRole('button', { name: 'Copy' }));
    expect(screen.getByText('Copied the suggested wording.')).toBeTruthy();
  });
});

describe('ReviewStep: 人の判断と確定', () => {
  it('正常: 判断とメモを保存すると変更したトピックだけを送り、保存ボタンを戻す', async () => {
    const { api, onReview } = setup({ review: reviewOf() });
    const save = screen.getByRole('button', { name: 'Save decisions' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const payment = card('支払条件');
    await userEvent.click(within(payment).getByLabelText('Acceptable'));
    fireEvent.change(within(payment).getByLabelText('Note'), { target: { value: '社内で合意済み' } });
    expect(save.disabled).toBe(false);
    await userEvent.click(save);
    expect(await screen.findByText('Decisions saved.')).toBeTruthy();
    expect(api.saveDecisions).toHaveBeenCalledWith(expect.anything(), 'rev-1', [{ topicId: 'payment', decision: 'accept', note: '社内で合意済み' }]);
    expect(onReview).toHaveBeenCalled();
    expect(save.disabled).toBe(true);
  });

  it('正常: 未保存の判断があれば先に保存してから確定し、確定を親へ知らせる', async () => {
    const { api, onDocumentChanged } = setup({ review: reviewOf() });
    fireEvent.change(within(card('知的財産')).getByLabelText('Note'), { target: { value: 'メモだけ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Finalize the review' }));
    expect(await screen.findByText('Review finalized. Register the contract once it is signed.')).toBeTruthy();
    expect(api.saveDecisions).toHaveBeenCalledWith(expect.anything(), 'rev-1', [{ topicId: 'ip', note: 'メモだけ' }]);
    expect(api.finalizeReview).toHaveBeenCalledWith(expect.anything(), 'rev-1');
    expect(onDocumentChanged).toHaveBeenCalled();
  });

  it('境界: 判断を変えていなければ保存せずに確定する', async () => {
    const { api } = setup({ review: reviewOf() });
    await userEvent.click(screen.getByRole('button', { name: 'Finalize the review' }));
    await waitFor(() => expect(api.finalizeReview).toHaveBeenCalled());
    expect(api.saveDecisions).not.toHaveBeenCalled();
  });

  it('異常: 判断の保存・確定の失敗は案内を出す', async () => {
    setup({ review: reviewOf(), overrides: { saveDecisions: vi.fn(async () => { throw new Error('save failed'); }), finalizeReview: vi.fn(async () => { throw new Error('finalize failed'); }) } });
    await userEvent.click(within(card('支払条件')).getByLabelText('Negotiate'));
    await userEvent.click(screen.getByRole('button', { name: 'Save decisions' }));
    expect((await screen.findByRole('alert')).textContent).toContain('save failed');
    cleanup();
    setup({ review: reviewOf(), overrides: { finalizeReview: vi.fn(async () => { throw new Error('finalize failed'); }) } });
    await userEvent.click(screen.getByRole('button', { name: 'Finalize the review' }));
    expect((await screen.findByRole('alert')).textContent).toContain('finalize failed');
  });

  it('境界: 確定済みは判断を入力できず、保存・確定ボタンを出さず、再レビューも押せない', () => {
    setup({ review: reviewOf({ status: 'finalized' }) });
    expect(screen.getByText('Finalized')).toBeTruthy();
    expect((within(card('支払条件')).getByLabelText('Acceptable').closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save decisions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Finalize the review' })).toBeNull();
    expect((screen.getAllByRole('button', { name: 'Run the review again' })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('正常: 確定後に条項や基準が変わった（stale）なら理由を出し、再レビューできる', async () => {
    const { api } = setup({ review: reviewOf({ status: 'finalized', stale: true }) });
    // 上部の stale 理由（カードの外）と、支払条件カード内の同じ理由の 2 つ。
    const stale = screen.getAllByText('The clauses or the playbook changed after the review.');
    expect(stale.filter((node) => node.closest('article') === null)).toHaveLength(1);
    const [toolbar, staleCard] = screen.getAllByRole('button', { name: 'Run the review again' });
    expect((toolbar as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(staleCard!);
    await waitFor(() => expect(api.runReview).toHaveBeenCalledTimes(1));
  });

  it('境界: 別のレビューに切り替わったら未保存の判断を捨てる', async () => {
    const { rerender } = setup({ review: reviewOf() });
    await userEvent.click(within(card('支払条件')).getByLabelText('Negotiate'));
    expect((screen.getByRole('button', { name: 'Save decisions' }) as HTMLButtonElement).disabled).toBe(false);
    rerender(reviewOf({ id: 'rev-2' }));
    expect((screen.getByRole('button', { name: 'Save decisions' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
