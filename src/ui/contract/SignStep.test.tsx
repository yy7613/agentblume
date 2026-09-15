// @vitest-environment jsdom
/**
 * 締結登録。期限プレビューの表示・印紙の選択と送信値・電子契約の扱い・409（登録済み）で台帳の該当契約へ行けることを守る。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { ContractDocumentDto, DeadlinePreviewDto } from '../api/contract-types';
import { ApiError } from '../api/tool-api';
import { SignStep } from './SignStep';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** 呼ばれていないメソッドは「想定外の呼び出し」として失敗させる。 */
function fakeApi(overrides: Partial<Record<keyof ContractApi, unknown>>): ContractApi {
  const cache = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn(async () => { throw new Error(`unexpected call ${String(key)}`); }));
      return cache.get(key);
    },
  }) as ContractApi;
}

const BODY = '第2条（契約期間）\n本契約の有効期間は1年とする。';

function documentOf(extra: Partial<ContractDocumentDto> = {}): ContractDocumentDto {
  return {
    id: 'doc-1', title: '保守業務委託', source: { type: 'text' }, body: BODY, pages: [], articles: [],
    parties: { A: { label: '甲' }, B: { label: '乙' } }, counterpartyProfile: { toriteki: 'unknown', freelance: 'unknown' },
    clauses: [], status: 'reviewed', createdAt: 'c', updatedAt: 'u', ...extra,
  };
}

const preview: DeadlinePreviewDto = {
  deadlines: [{ id: 'expiry-1', kind: 'expiry', dueDate: '2027-03-31', basis: '第2条: 満了日', status: 'open' }],
  warnings: [{ code: 'notice-deadline-passed', message: '2026-12-31' }, { message: '自由記述の注意' }],
  autoRenewal: true,
  stampDutyCandidates: [
    { code: 'stamp-duty-candidate', documentTypeCode: 'no7', name: '第7号文書', amount: 4000, nature: 'basic_transaction', electronic: false, sourceUrl: 'https://www.nta.go.jp/' },
    { code: 'stamp-duty-amount-unknown', documentTypeCode: 'no2', name: '第2号文書', amount: null, nature: 'ukeoi', electronic: false, sourceUrl: '' },
  ],
  review: 'draft', counterpartyName: '架空テック合同会社',
};

function setup(options: { document?: ContractDocumentDto; preview?: DeadlinePreviewDto | Error; register?: () => Promise<unknown> } = {}) {
  const api = fakeApi({
    previewDeadlines: vi.fn(async () => { if (options.preview instanceof Error) throw options.preview; return options.preview ?? preview; }),
    registerSigned: vi.fn(options.register ?? (async () => ({ contract: { id: 'con-1' }, warnings: [] }))),
  });
  const onRegistered = vi.fn();
  const onAction = vi.fn();
  render(<SignStep api={api} document={options.document ?? documentOf()} onRegistered={onRegistered} onAction={onAction} />);
  return { api, onRegistered, onAction };
}

const registered = (api: ContractApi) => vi.mocked(api.registerSigned).mock.calls.at(-1)?.[1];

describe('SignStep', () => {
  it('正常: 期限プレビュー・未確定の警告・理由カード・自由記述の注意を出し、相手方を初期値に入れる', async () => {
    const { onAction } = setup();
    expect(screen.getByText('Calculating…')).toBeTruthy();
    expect(await screen.findByText('2027-03-31')).toBeTruthy();
    expect(screen.getByText('The review is not finalized yet.')).toBeTruthy();
    expect(screen.getByText(/The renewal notice deadline has already passed at registration \(2026-12-31\)/)).toBeTruthy();
    expect(screen.getByText('自由記述の注意')).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText('Counterparty') as HTMLInputElement).value).toBe('架空テック合同会社'));
    await userEvent.click(screen.getByRole('button', { name: 'Open the deadline ledger' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: 'step', step: 'ledger' }));
  });

  it('正常: 紙の契約で印紙の候補を選び、貼付済みにして登録すると区分と金額を送る', async () => {
    const { api, onRegistered } = setup();
    await screen.findByText('2027-03-31');
    expect(screen.getByLabelText(/第7号文書/).parentElement?.textContent).toContain('4,000 円');
    expect(screen.getByRole('link', { name: /source/ }).getAttribute('href')).toBe('https://www.nta.go.jp/');
    await userEvent.click(screen.getByLabelText(/第7号文書/));
    fireEvent.change(screen.getByLabelText('Stamp affixed?'), { target: { value: 'yes' } });
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await waitFor(() => expect(onRegistered).toHaveBeenCalledWith('con-1'));
    expect(registered(api)).toMatchObject({ documentId: 'doc-1', signingMethod: 'paper', title: '保守業務委託', counterpartyName: '架空テック合同会社', stampDuty: { affixed: true, documentTypeCode: 'no7', amount: 4000 } });
  });

  it('境界: 金額不明の候補は税額を送らず、未貼付は false で送る', async () => {
    const { api } = setup();
    await screen.findByText('2027-03-31');
    expect(screen.getByLabelText(/第2号文書/).parentElement?.textContent).toContain('enter the contract amount to decide the tax');
    await userEvent.click(screen.getByLabelText(/第2号文書/));
    fireEvent.change(screen.getByLabelText('Stamp affixed?'), { target: { value: 'no' } });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '  ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await waitFor(() => expect(api.registerSigned).toHaveBeenCalled());
    const sent = registered(api)!;
    expect(sent.stampDuty).toEqual({ affixed: false, documentTypeCode: 'no2' });
    expect(sent).not.toHaveProperty('title');
  });

  it('正常: 電子契約は印紙を選べず、課税文書に当たらない旨を出し、印紙の情報を送らない', async () => {
    const electronic: DeadlinePreviewDto = { ...preview, review: 'none', stampDutyCandidates: [{ ...preview.stampDutyCandidates[0]!, electronic: true, sourceUrl: '' }] };
    const { api } = setup({ preview: electronic });
    expect(await screen.findByText(/has not been reviewed/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Signing method'), { target: { value: 'electronic' } });
    await waitFor(() => expect(vi.mocked(api.previewDeadlines).mock.calls.at(-1)?.[1]).toMatchObject({ signingMethod: 'electronic' }));
    expect(screen.getByLabelText(/第7号文書/).parentElement?.textContent).toContain('electronic contracts are generally not taxable documents');
    expect((screen.getByLabelText(/第7号文書/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('Stamp affixed?')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await waitFor(() => expect(api.registerSigned).toHaveBeenCalled());
    expect(registered(api)).not.toHaveProperty('stampDuty');
  });

  it('境界: 金額は数値のときだけプレビューへ送り、締結日が空なら日付を送らず登録できない', async () => {
    const { api } = setup({ document: documentOf({ contractAmount: 500000 }) });
    await screen.findByText('2027-03-31');
    expect(vi.mocked(api.previewDeadlines).mock.calls[0]?.[1]).toMatchObject({ contractAmount: 500000 });
    fireEvent.change(screen.getByLabelText('Contract amount (JPY)'), { target: { value: 'abc' } });
    await waitFor(() => expect(vi.mocked(api.previewDeadlines).mock.calls.at(-1)?.[1]).not.toHaveProperty('contractAmount'));
    fireEvent.change(screen.getByLabelText('Signed on'), { target: { value: '' } });
    await waitFor(() => expect(vi.mocked(api.previewDeadlines).mock.calls.at(-1)?.[1]).not.toHaveProperty('signedDate'));
    expect((screen.getByRole('button', { name: 'Register as signed' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('境界: 候補も期限も無ければその旨を出し、相手方が空なら入力を促して登録できない', async () => {
    setup({ preview: { ...preview, deadlines: [], warnings: [], stampDutyCandidates: [], review: 'finalized', counterpartyName: undefined } as unknown as DeadlinePreviewDto });
    expect(await screen.findByText('No deadlines can be calculated yet.')).toBeTruthy();
    expect(screen.getByText('No stamp duty candidate for this contract nature.')).toBeTruthy();
    expect(screen.getByText('Enter the counterparty.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Register as signed' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Counterparty'), { target: { value: '手入力の相手方' } });
    expect(screen.queryByText('Enter the counterparty.')).toBeNull();
    expect((screen.getByRole('button', { name: 'Register as signed' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('異常: プレビューの失敗は案内を出す', async () => {
    setup({ preview: new Error('preview failed') });
    expect((await screen.findByRole('alert')).textContent).toContain('preview failed');
  });

  it('異常: 登録済みの 409 は「台帳で開く」でその契約を台帳に開く', async () => {
    const { onRegistered, onAction } = setup({ register: async () => { throw new ApiError(409, 'CONTRACT_STATE', 'already signed', undefined, { details: { contractId: 'con-7' } }); } });
    await screen.findByText('2027-03-31');
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Open it in the ledger' }));
    // 契約 id を捨てると台帳を開いても該当契約が選ばれない（§7.2「台帳で開く」）。
    expect(onRegistered).toHaveBeenCalledWith('con-7');
    expect(onAction).not.toHaveBeenCalled();
  });

  it('異常: 409 でモデル以外の手順を示すボタンは手順へ振り分ける', async () => {
    const { onAction } = setup({ register: async () => { throw new ApiError(409, 'CONTRACT_EXTRACTION_UNAVAILABLE', 'no model'); } });
    await screen.findByText('2027-03-31');
    await userEvent.click(screen.getByRole('button', { name: 'Register as signed' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Paste the text and import it' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'step', step: 'import', label: '' });
  });

  it('正常: 締結登録済みの文書は登録フォームを出さず、台帳の該当契約へ案内する', async () => {
    const { api, onRegistered, onAction } = setup({ document: documentOf({ status: 'signed', signedContractId: 'con-3' }) });
    expect(screen.getByText('This contract is already registered as signed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open it in the ledger' }));
    expect(onRegistered).toHaveBeenCalledWith('con-3');
    expect(onAction).not.toHaveBeenCalled();
    expect(api.previewDeadlines).toHaveBeenCalled();
  });

  it('境界: 締結登録済みでも契約 id が分からなければ台帳の手順だけを開く', async () => {
    const { onAction } = setup({ document: documentOf({ status: 'signed' }) });
    await userEvent.click(screen.getByRole('button', { name: 'Open it in the ledger' }));
    expect(onAction).toHaveBeenCalledWith({ kind: 'step', step: 'ledger', label: '' });
  });
});
