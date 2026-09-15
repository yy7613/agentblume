// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpensePayoutBatchDto, ExpensePayoutPreviewDto, ExpensePayoutSettingsResultDto } from '../../api/expense-money-types';
import { ApiError } from '../../api/tool-api';
import type { ExpenseSettlePayoutSlotProps } from '../expense-slots';
import { fakeTransport, testScope, type FakeHandler, type FakeTransport } from './money-test-helpers';
import { PayoutPanel, payoutBlockedDetails, problemAction } from './PayoutPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const format = { lineEnding: 'crlf', eofMark: false, includeBankNames: false, clearingHouse: 'zeros', transferKind: '7', newCode: '0', customerCode1: 'none', charset: 'strict', maxRecords: 9999 } as const;
const unset: ExpensePayoutSettingsResultDto = { saved: false, settings: { format, journal: { createPaymentEntry: false, sourceAccountId: 'asset.ordinary_deposit' }, updatedAt: 'x' } };
const configured: ExpensePayoutSettingsResultDto = {
  saved: true,
  settings: { ...unset.settings, source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumberLast4: '0009' }, requesterCode: '0000000001', requesterNameKana: 'ｻﾝﾌﾟﾙｼﾖｳｼﾞ' },
};
const line = { employeeId: 'emp-taro', name: 'テスト太郎', holderKanaConverted: 'ﾃｽﾄ ﾀﾛｳ', bank: { bankCode: '9999', branchCode: '999', accountType: 'ordinary', holderKana: 'テスト タロウ', accountNumberLast4: '0001' }, amount: 3200, sources: [{ kind: 'claim', id: 'c1', amount: 3200 }] } as const;
const cleanPreview: ExpensePayoutPreviewDto = { candidates: { claims: [], advancePayments: [], advanceAdditionals: [] }, lines: [line], totalAmount: 3200, recordCount: 1, problems: [], warnings: [] };
const batch: ExpensePayoutBatchDto = {
  id: 'b1', status: 'exported', transferDate: '2026-10-02', lines: [line], recordCount: 1, totalAmount: 3200, fileName: 'zengin-sofuri-20261002-b1.txt', fileSha256: 'a'.repeat(64),
  settingsSnapshot: configured.settings, acknowledgedWarnings: [], by: 'u', createdAt: 'x',
};
const file = { fileName: batch.fileName, contentBase64: Buffer.from('1210').toString('base64'), byteLength: 4, sha256: batch.fileSha256 };

function server(overrides: Readonly<Record<string, FakeHandler>> = {}): FakeTransport {
  return fakeTransport({
    'GET /expense/payout-settings': () => configured,
    'PUT /expense/payout-settings': ({ body }) => ({ settings: { ...configured.settings, requesterNameKana: String(body['requesterNameKana']) } }),
    'GET /expense/payouts': () => ({ batches: [] }),
    'POST /expense/payouts/preview': () => ({ result: cleanPreview }),
    'POST /expense/payouts': () => ({ batch, file }),
    'GET /expense/payouts/:id/file': () => ({ file }),
    'POST /expense/payouts/:id/confirm': () => ({ batch: { ...batch, status: 'confirmed' }, claims: [], advances: [], warnings: ['支払の仕訳下書きを作れませんでした'] }),
    'POST /expense/payouts/:id/cancel': () => ({ batch: { ...batch, status: 'cancelled' } }),
    ...overrides,
  });
}

function renderPanel(transport: FakeTransport) {
  const props: ExpenseSettlePayoutSlotProps = { transport, scope: testScope, onOpen: vi.fn(), claims: [], onClaimsChanged: vi.fn().mockResolvedValue(undefined) };
  render(<PayoutPanel {...props} />);
  return props;
}

function mockDownload(): ReturnType<typeof vi.fn> {
  const create = vi.fn(() => 'blob:x');
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  return create;
}

describe('PayoutPanel: 振込元の設定', () => {
  it('正常: 未設定は赤くせず設定を開く導線を出し、口座番号を入れて保存すると末尾 4 桁の表示に変わる', async () => {
    const transport = server({ 'GET /expense/payout-settings': () => unset, 'PUT /expense/payout-settings': () => ({ settings: configured.settings }) });
    renderPanel(transport);
    expect(await screen.findByText('Set the payout source account to create transfer files.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open the payout source settings' }));
    const form = screen.getByRole('form', { name: 'Payout source settings' });
    expect(within(form).getByText(/Check your bank's upload specification/u)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Bank code (4 digits)'), { target: { value: '9999' } });
    fireEvent.change(within(form).getByLabelText('Branch code (3 digits)'), { target: { value: '998' } });
    fireEvent.change(within(form).getByLabelText('Account number (up to 7 digits)'), { target: { value: '9' } });
    fireEvent.change(within(form).getByLabelText('Requester code (10 digits from the bank)'), { target: { value: '0000000001' } });
    fireEvent.change(within(form).getByLabelText('Requester name (kana)'), { target: { value: 'サンプルシヨウジ' } });
    await userEvent.click(within(form).getByLabelText('Write bank and branch names'));
    fireEvent.change(within(form).getByLabelText('Bank name (kana)'), { target: { value: 'サンプル' } });
    await userEvent.click(within(form).getByLabelText('Create a payment journal draft when confirmed'));
    await userEvent.click(within(form).getByRole('button', { name: 'Save the payout source' }));
    expect(await screen.findByText('Saved the payout source settings.')).toBeTruthy();
    expect(transport.callsTo('PUT', '/expense/payout-settings')[0]?.body).toMatchObject({
      source: { bankCode: '9999', branchCode: '998', accountType: 'ordinary', accountNumber: '9', bankNameKana: 'サンプル' }, requesterCode: '0000000001',
      format: { includeBankNames: true, lineEnding: 'crlf', charset: 'strict', eofMark: false }, journal: { createPaymentEntry: true },
    });
    expect(screen.getByText(/9999-998 \*\*\*\*0009/u)).toBeTruthy();
  });

  it('正常: 設定済みの口座番号は「変更する」を押すまで送らない。キャンセルで元に戻す。保存の 400 は欄の説明を出す', async () => {
    const transport = server({ 'PUT /expense/payout-settings': () => { throw new ApiError(400, 'EXPENSE_DOMAIN', 'requesterCode must be 10 digits', undefined, { details: { field: 'requesterCode' } }); } });
    renderPanel(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit the payout source' }));
    const form = screen.getByRole('form', { name: 'Payout source settings' });
    expect(within(form).queryByLabelText('Account number (up to 7 digits)')).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Change' }));
    expect(within(form).getByLabelText('Account number (up to 7 digits)')).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Save the payout source' }));
    // 保存に失敗したら赤い失敗の枠を出し、入力はそのまま残す（直してもう一度保存できる）。
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('form', { name: 'Payout source settings' })).toBeTruthy();
    expect(transport.callsTo('PUT', '/expense/payout-settings')[0]?.body['source']).not.toHaveProperty('accountNumber');
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Payout source settings' })).toBeNull();
  });
});

describe('PayoutPanel: 点検 → 作成 → バッチ', () => {
  it('正常: 点検で明細（変換後の名義・伏せ字の口座）を出し、作成するとダウンロードして申請一覧を読み直す', async () => {
    const transport = server({ 'GET /expense/payouts': () => ({ batches: transport.callsTo('POST', '/expense/payouts').length > 0 ? [batch] : [] }) });
    const props = renderPanel(transport);
    const download = mockDownload();
    fireEvent.change(await screen.findByLabelText('Transfer date'), { target: { value: '2026-10-02' } });
    await userEvent.click(screen.getByRole('button', { name: 'Check before creating' }));
    const table = await screen.findByRole('table', { name: 'Transfer lines' });
    expect(within(table).getByText('ﾃｽﾄ ﾀﾛｳ')).toBeTruthy();
    expect(within(table).getByText('9999-999 ****0001')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/payouts/preview')[0]?.body).toMatchObject({ transferDate: '2026-10-02' });
    await userEvent.click(screen.getByRole('button', { name: 'Create the transfer file' }));
    expect(await screen.findByText(/Created zengin-sofuri-20261002-b1\.txt\. Upload it to your bank/u)).toBeTruthy();
    expect(download).toHaveBeenCalledTimes(1);
    expect(transport.callsTo('POST', '/expense/payouts')[0]?.body).toMatchObject({ transferDate: '2026-10-02', acknowledgedWarnings: [] });
    expect(props.onClaimsChanged).toHaveBeenCalled();
    expect(await screen.findByText(/zengin-sofuri-20261002-b1\.txt · 2026-10-02/u)).toBeTruthy();
  });

  it('異常: 止める理由は導線つきで並べて作成を押せない。警告は全部確認するまで押せない', async () => {
    const preview: ExpensePayoutPreviewDto = {
      ...cleanPreview,
      problems: [
        { code: 'payout-holder-kana-too-long', employeeId: 'emp-taro', field: 'bankAccount.holderKana', message: 'テスト太郎 さんの名義カナが変換後 31 バイトで、上限 30 バイトを超えています。30 バイト以内にしてください', fixTarget: 'employee-bank-account' },
        { code: 'payout-source-missing', message: '振込元の口座が設定されていません', fixTarget: 'payout-settings' },
      ],
      warnings: [{ code: 'payout-transfer-date-weekend', message: '振込日は土日です', fixTarget: 'transfer-date' }],
    };
    const props = renderPanel(server({ 'POST /expense/payouts/preview': () => ({ result: preview }) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check before creating' }));
    const box = await screen.findByLabelText('Problems to fix');
    expect(within(box).getByText(/31 バイト/u)).toBeTruthy();
    await userEvent.click(within(box).getByRole('button', { name: 'Open the bank account' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'emp-taro', section: 'employee' });
    await userEvent.click(within(box).getByRole('button', { name: 'Open the payout source settings' }));
    expect(screen.getByRole('form', { name: 'Payout source settings' })).toBeTruthy();
    const warnings = screen.getByLabelText('Warnings to confirm');
    await userEvent.click(within(warnings).getByRole('button', { name: 'Change the transfer date' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Transfer date'));
    expect((screen.getByRole('button', { name: 'Create the transfer file' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('正常→異常: 警告を確認すると作成を押せ、確認コードを送る。作成の 409 EXPENSE_PAYOUT_BLOCKED は本文の問題を表示し直す', async () => {
    const warned: ExpensePayoutPreviewDto = { ...cleanPreview, warnings: [{ code: 'payout-no-journal', message: '仕訳下書きを作っていない申請が 1 件あります', fixTarget: 'settle' }] };
    const transport = server({
      'POST /expense/payouts/preview': () => ({ result: warned }),
      'POST /expense/payouts': () => { throw new ApiError(409, 'EXPENSE_PAYOUT_BLOCKED', 'blocked', undefined, { details: { problems: [{ code: 'payout-already-exported', claimId: 'c1', message: '申請 c1 は振込データ b0 に既に入っています', fixTarget: 'payout-batch' }], warnings: [] } }); },
    });
    renderPanel(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Check before creating' }));
    const create = await screen.findByRole('button', { name: 'Create the transfer file' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    await userEvent.click(screen.getByLabelText('Confirmed: payout-no-journal'));
    expect(create.disabled).toBe(false);
    await userEvent.click(create);
    expect(await screen.findByText('申請 c1 は振込データ b0 に既に入っています')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/payouts')[0]?.body).toMatchObject({ acknowledgedWarnings: ['payout-no-journal'] });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('正常: 対象が無ければそう伝える。ダウンロードできない環境では再ダウンロードの案内を出す', async () => {
    renderPanel(server({ 'POST /expense/payouts/preview': () => ({ result: { ...cleanPreview, lines: [], totalAmount: 0, recordCount: 0 } }) }));
    await userEvent.click(await screen.findByRole('button', { name: 'Check before creating' }));
    expect(await screen.findByText(/There is nothing to transfer/u)).toBeTruthy();
    cleanup();
    Object.assign(URL, { createObjectURL: undefined });
    renderPanel(server());
    await userEvent.click(await screen.findByRole('button', { name: 'Check before creating' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create the transfer file' }));
    expect(await screen.findByText(/could not download it\. Use "Download again"/u)).toBeTruthy();
  });

  it('正常: バッチの再ダウンロード・確定（警告を出して申請一覧を読み直す）・理由つきの取消', async () => {
    let listed: readonly ExpensePayoutBatchDto[] = [batch];
    const transport = server({ 'GET /expense/payouts': () => ({ batches: listed }) });
    const props = renderPanel(transport);
    const download = mockDownload();
    await userEvent.click(await screen.findByRole('button', { name: 'Download again' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(transport.callsTo('GET', '/expense/payouts/b1/file')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel the file' }));
    const cancelForm = screen.getByRole('form', { name: 'Reason for cancelling' });
    expect((within(cancelForm).getByRole('button', { name: 'Cancel this file' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(cancelForm).getByLabelText('Reason for cancelling'), { target: { value: '振込日を変える' } });
    listed = [{ ...batch, status: 'cancelled' }];
    await userEvent.click(within(cancelForm).getByRole('button', { name: 'Cancel this file' }));
    expect(await screen.findByText(/Cancelled zengin-sofuri-20261002-b1\.txt/u)).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/payouts/b1/cancel')[0]?.body).toMatchObject({ note: '振込日を変える' });
    expect(screen.queryByRole('button', { name: 'Download again' })).toBeNull();

    listed = [batch];
    cleanup();
    renderPanel(transport);
    listed = [{ ...batch, status: 'confirmed' }];
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Confirmed zengin-sofuri-20261002-b1\.txt\. The claims are settled\. 支払の仕訳下書きを作れませんでした/u)).toBeTruthy();
    expect(props.onClaimsChanged).toHaveBeenCalled();
  });

  it('異常: 設定・一覧の読み込みに失敗したら理由を出す', async () => {
    renderPanel(server({ 'GET /expense/payout-settings': () => { throw new Error('server down'); } }));
    expect(await screen.findByText('server down')).toBeTruthy();
  });
});

describe('PayoutPanel の小物', () => {
  it('正常: 導線は直す場所ごとに開く先を決め、開けない問題は undefined', () => {
    const onOpen = vi.fn();
    const actions = { onOpen, openSettings: vi.fn(), focusDate: vi.fn() };
    const text = (en: string) => en;
    const run = (problem: Parameters<typeof problemAction>[0]) => problemAction(problem, text, actions)?.run();
    run({ code: 'x', message: '', fixTarget: 'claim-claimant', claimId: 'c1' });
    run({ code: 'x', message: '', fixTarget: 'approve', claimId: 'c2' });
    run({ code: 'x', message: '', fixTarget: 'approve', advanceId: 'a1' });
    run({ code: 'x', message: '', fixTarget: 'employee-history', employeeId: 'e1' });
    run({ code: 'x', message: '', fixTarget: 'employee-links' });
    expect(onOpen.mock.calls.map((call) => call[0])).toEqual([
      { internalId: 'c1', section: 'claimant' }, { internalId: 'c2', section: 'claim' }, { internalId: 'a1', section: 'advance' }, { internalId: 'e1', section: 'employee' }, { internalId: '', section: 'employee' },
    ]);
    for (const fixTarget of ['none', 'settle', 'payout-batch'] as const) expect(problemAction({ code: 'x', message: '', fixTarget }, text, actions)).toBeUndefined();
    expect(problemAction({ code: 'x', message: '', fixTarget: 'employee-bank-account' }, text, actions)).toBeUndefined();
    expect(problemAction({ code: 'x', message: '', fixTarget: 'claim-claimant' }, text, actions)).toBeUndefined();
    expect(problemAction({ code: 'x', message: '', fixTarget: 'approve' }, text, actions)).toBeUndefined();
    expect(problemAction({ code: 'x', message: '', fixTarget: 'employee-history' }, text, actions)).toBeUndefined();
  });

  it('正常: 409 の本文から形の合う問題だけを取り出し、他の失敗は undefined', () => {
    const error = new ApiError(409, 'EXPENSE_PAYOUT_BLOCKED', 'blocked', undefined, { details: { problems: [{ code: 'a', message: 'm', fixTarget: 'none' }, { nope: true }], warnings: 'bad' } });
    expect(payoutBlockedDetails(error)).toEqual({ problems: [{ code: 'a', message: 'm', fixTarget: 'none' }], warnings: [] });
    expect(payoutBlockedDetails(new Error('x'))).toBeUndefined();
    expect(payoutBlockedDetails(new ApiError(409, 'EXPENSE_TRANSITION', 'x'))).toBeUndefined();
  });
});
