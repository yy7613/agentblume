// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ExpenseCardDto, ExpenseCardImportDto, ExpenseCardStatementPreviewDto, ExpenseCardStatementProfileDto, ExpenseCardTransactionDto,
} from '../../api/expense-money-types';
import type { ExpenseClaimSummaryDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import { NavigationProvider } from '../../navigation';
import type { ExpenseLedgerSlotProps } from '../expense-slots';
import { CardsLedger, sortTransactions } from './CardsLedger';
import { mappingFrom } from './CardStatementImport';
import { fakeTransport, ledgerProps, transitionError, type FakeHandler, type FakeTransport } from './money-test-helpers';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const card: ExpenseCardDto = { id: 'card-a', label: '経費用カード', issuerName: 'Aカード', last4: '1234', enabled: true };
const profile: ExpenseCardStatementProfileDto = {
  id: 'prof1', name: 'A社', headerSignature: ['利用日', 'ご利用店名', '金額'], columns: { usedOn: '利用日', merchant: 'ご利用店名', amount: '金額', memo: '備考' }, amountSign: 'charge-negative', skipLinesBefore: 1,
};
const importEntry: ExpenseCardImportDto = {
  id: 'imp1', fileName: 'sept.csv', fileSha256: 'abc', mapping: { columns: { usedOn: '利用日', merchant: '加盟店', amount: '金額' }, amountSign: 'charge-positive', skipLinesBefore: 0 },
  rowCount: 3, importedCount: 3, duplicateCount: 0, skippedRows: [], periodFrom: '2026-09-01', periodTo: '2026-09-30', by: 'u1', createdAt: '2026-09-10T10:00:00.000Z',
};
const claim: ExpenseClaimSummaryDto = {
  id: 'c1', claimant: { name: '山田 太郎' }, period: { from: '2026-09-01', to: '2026-09-30' }, status: 'checked', stale: false, itemCount: 1, totalAmount: 3300, corporatePaymentAmount: 0,
  reasonCounts: { return: 0, review: 0, acknowledged: 0 }, journalLinked: 'none', topReasons: [], submittedBy: 'u1', createdAt: 'x', updatedAt: 'x',
};

function tx(overrides: Partial<ExpenseCardTransactionDto> = {}): ExpenseCardTransactionDto {
  return {
    id: 'tx1', importId: 'imp1', cardId: 'card-a', usedOn: '2026-09-03', merchantRaw: 'JR東日本', merchantKey: 'jr東日本', amount: 1200, row: {}, dedupeKey: 'k1', status: 'unmatched',
    createdAt: 'x', updatedAt: 'x', cardLabel: '経費用カード', cardLast4: '1234', importFile: 'sept.csv', ...overrides,
  };
}

const matchedCorporate = tx({ id: 'tx1', status: 'matched', match: { claimId: 'c1', itemId: 'i1', kind: 'corporate-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: false, at: 'x' }, claimant: '山田 太郎', claimStatus: 'approved' });
const unmatched = tx({ id: 'tx2', usedOn: '2026-09-04', merchantRaw: 'タクシー', amount: 2500, memo: '深夜' });
const suspect = tx({ id: 'tx3', usedOn: '2026-09-05', merchantRaw: 'ホテル', amount: 9800, status: 'matched', match: { claimId: 'c2', itemId: 'i9', kind: 'reimbursement-item', strength: 'weak', dateDiffDays: 1, amountDiff: 0, manual: true, at: 'x' }, holder: '佐藤 花子' });
const excluded = tx({ id: 'tx4', usedOn: '2026-09-06', merchantRaw: '年会費', amount: 1100, status: 'excluded', exclusion: { reason: '会社の年会費', by: 'u1', at: 'x' } });

interface CardState { cards: ExpenseCardDto[]; profiles: ExpenseCardStatementProfileDto[]; imports: ExpenseCardImportDto[]; transactions: ExpenseCardTransactionDto[] }

function cardServer(initial: Partial<CardState> = {}, overrides: Readonly<Record<string, FakeHandler>> = {}): FakeTransport {
  const state: CardState = { cards: [], profiles: [], imports: [], transactions: [], ...initial };
  const replace = (id: string | undefined, patch: Partial<ExpenseCardTransactionDto>) => {
    const next = { ...(state.transactions.find((entry) => entry.id === id) ?? tx()), ...patch };
    state.transactions = state.transactions.map((entry) => (entry.id === id ? next : entry));
    return { transaction: next };
  };
  return fakeTransport({
    'GET /expense/card-settings': () => ({ settings: { cards: state.cards, profiles: state.profiles, updatedAt: 'x' }, saved: state.cards.length > 0 }),
    'PUT /expense/card-settings': ({ body }) => {
      state.cards = body['cards'] as ExpenseCardDto[];
      state.profiles = body['profiles'] as ExpenseCardStatementProfileDto[];
      return { settings: { cards: state.cards, profiles: state.profiles, updatedAt: 'y' } };
    },
    'GET /expense/card-statements': () => ({ imports: state.imports }),
    'DELETE /expense/card-statements/:id': ({ params }) => { state.imports = state.imports.filter((entry) => entry.id !== params[0]); state.transactions = []; return {}; },
    'GET /expense/card-transactions': ({ query }) => ({ transactions: state.transactions.filter((entry) => query.get('status') === null || entry.status === query.get('status')) }),
    'POST /expense/card-transactions/match': () => ({ result: { matched: 3, reimbursementMatches: 1, unmatched: 2, kept: 0 } }),
    'POST /expense/card-transactions/:id/exclude': ({ params, body }) => replace(params[0], { status: 'excluded', exclusion: { reason: String(body['reason']), by: 'u1', at: 'x' } }),
    'POST /expense/card-transactions/:id/include': ({ params }) => replace(params[0], { status: 'unmatched' }),
    'POST /expense/card-transactions/:id/link': ({ params, body }) => replace(params[0], { status: 'matched', match: { claimId: String(body['claimId']), itemId: String(body['itemId']), kind: 'corporate-item', strength: 'strong', dateDiffDays: 0, amountDiff: 0, manual: true, at: 'x' } }),
    'POST /expense/card-transactions/:id/unlink': ({ params }) => replace(params[0], { status: 'unmatched' }),
    'GET /expense/claims/:id': ({ params }) => ({ claim: { id: params[0], items: [{ id: 'i1', facts: { transactionDate: '2026-09-04', payeeName: '日本交通', amount: 2500 } }, { id: 'i2', facts: {} }] } }),
    ...overrides,
  });
}

function renderLedger(transport: FakeTransport, overrides: Partial<ExpenseLedgerSlotProps> = {}) {
  const props = ledgerProps(transport, overrides);
  render(<NavigationProvider navigate={vi.fn()}><CardsLedger {...props} /></NavigationProvider>);
  return props;
}

const headers = ['利用日', 'ご利用店名', '金額'];
function previewResult(overrides: Partial<ExpenseCardStatementPreviewDto> = {}): ExpenseCardStatementPreviewDto {
  return { headers, suggestedMapping: { usedOn: '利用日', merchant: 'ご利用店名', amount: '金額' }, rows: [], rowCount: 2, skippedRows: [], problems: [], ...overrides };
}

async function uploadCsv() {
  await userEvent.upload(screen.getByLabelText('Statement CSV'), new File(['利用日,ご利用店名,金額\n2026/09/03,JR東日本,1200\n'], 'sept.csv', { type: 'text/csv' }));
}

describe('CardsLedger', () => {
  it('正常: カードも明細も無ければ赤くせず「カードを追加」と明細 CSV の取込を案内する', async () => {
    renderLedger(cardServer());
    expect(await screen.findByText('No cards are registered.')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Import a card statement CSV from the card company.')).toHaveLength(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('正常: カードを追加（下 4 桁を確かめる）・編集して保存し、保存済みの対応を削除する', async () => {
    const transport = cardServer({ profiles: [profile] });
    renderLedger(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Add a card' }));
    const form = screen.getByRole('form', { name: 'Add a card' });
    await userEvent.type(within(form).getByLabelText('Label'), '経費用カード');
    await userEvent.type(within(form).getByLabelText('Last 4 digits'), '12');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the card' }));
    expect(within(form).getByText('Enter the last 4 digits of the card number.')).toBeTruthy();
    expect(transport.callsTo('PUT', '/expense/card-settings')).toHaveLength(0);
    await userEvent.type(within(form).getByLabelText('Last 4 digits'), '34');
    await userEvent.type(within(form).getByLabelText('Issuer'), 'Aカード');
    await userEvent.type(within(form).getByLabelText('Holder employee ID'), 'e1');
    await userEvent.click(within(form).getByRole('button', { name: 'Save the card' }));
    const saved = transport.callsTo('PUT', '/expense/card-settings')[0]?.body;
    expect(saved?.['cards']).toEqual([expect.objectContaining({ label: '経費用カード', last4: '1234', issuerName: 'Aカード', holderEmployeeId: 'e1', enabled: true, id: expect.stringMatching(/^card-/u) })]);
    expect(saved?.['profiles']).toEqual([profile]);
    expect(await screen.findByText('Saved the card 経費用カード.')).toBeTruthy();
    expect(screen.getByText('••1234')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Edit the card 経費用カード' }));
    const edit = screen.getByRole('form', { name: 'Edit the card' });
    await userEvent.click(within(edit).getByLabelText('Enabled'));
    await userEvent.click(within(edit).getByRole('button', { name: 'Save the card' }));
    await waitFor(() => expect(transport.callsTo('PUT', '/expense/card-settings')).toHaveLength(2));
    expect(transport.callsTo('PUT', '/expense/card-settings')[1]?.body['cards']).toEqual([expect.objectContaining({ enabled: false })]);

    await userEvent.click(screen.getByRole('button', { name: 'Remove the mapping A社' }));
    await waitFor(() => expect(transport.callsTo('PUT', '/expense/card-settings')[2]?.body['profiles']).toEqual([]));
  });

  it('正常: 明細 CSV を選ぶとプレビューし、足りない列を選んで再プレビュー → 対応を保存して取り込む', async () => {
    const preview = vi.fn(({ body }: { body: Record<string, unknown> }) => ({ result: body['mapping'] === undefined
      ? previewResult({ suggestedMapping: { usedOn: '利用日', amount: '金額' }, problems: [{ code: 'mapping-missing', message: '列の対応を選んでください（見つからない項目: merchant）', missingColumns: ['merchant'] }] })
      : previewResult({ rows: [{ row: 2, cardId: 'card-a', usedOn: '2026-09-03', merchantRaw: 'JR東日本', merchantKey: 'jr', amount: 1200 }], skippedRows: [{ row: 3, reason: '金額が読めません' }], periodFrom: '2026-09-03', periodTo: '2026-09-03' }) }));
    const importCall = vi.fn(() => ({ result: { importId: 'imp2', imported: 1, duplicates: 0, skippedRows: [{ row: 3, reason: '金額が読めません' }], warnings: ['1 行を取り込めませんでした'], periodFrom: '2026-09-03', periodTo: '2026-09-03', profileId: 'profile-x' } }));
    const transport = cardServer({ cards: [card] }, { 'POST /expense/card-statements/preview': preview as FakeHandler, 'POST /expense/card-statements': importCall });
    const props = renderLedger(transport);
    await screen.findByText('••1234');
    await userEvent.selectOptions(screen.getByLabelText('Card'), 'card-a');
    await uploadCsv();
    expect(await screen.findByText('列の対応を選んでください（見つからない項目: merchant）')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/card-statements/preview')[0]?.body).toMatchObject({ content: expect.stringContaining('JR東日本'), cardId: 'card-a' });
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose the columns for the date, merchant, and amount.')).toBeTruthy();

    await userEvent.selectOptions(screen.getByLabelText('Column for Merchant'), 'ご利用店名');
    await userEvent.selectOptions(screen.getByLabelText('Column for Memo'), '金額');
    await userEvent.selectOptions(screen.getByLabelText('Column for Memo'), '');
    await userEvent.selectOptions(screen.getByLabelText('Amount sign'), 'charge-negative');
    fireEvent.change(screen.getByLabelText('Lines before the header'), { target: { value: '2' } });
    await userEvent.click(screen.getByRole('button', { name: 'Preview with this mapping' }));
    const mapping = { columns: { usedOn: '利用日', merchant: 'ご利用店名', amount: '金額' }, amountSign: 'charge-negative', skipLinesBefore: 2 };
    await waitFor(() => expect(transport.callsTo('POST', '/expense/card-statements/preview')[1]?.body).toMatchObject({ mapping }));
    expect(await screen.findByText('Row 3: 金額が読めません')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Statement preview' })).toBeTruthy();

    await userEvent.type(screen.getByLabelText('Save this mapping as (optional)'), 'A社');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(importCall).toHaveBeenCalled();
    expect(transport.callsTo('POST', '/expense/card-statements')[0]?.body).toMatchObject({ fileName: 'sept.csv', mapping, cardId: 'card-a', saveProfileAs: 'A社' });
    expect(await screen.findByText('Imported 1 transactions (2026-09-03〜2026-09-03). 0 duplicates were skipped.')).toBeTruthy();
    expect(screen.getByText('1 行を取り込めませんでした')).toBeTruthy();
    expect(props.onClaimsChanged).not.toHaveBeenCalled();
  });

  it('正常: 見出しで保存済みの対応が見つかればその対応で埋め、取込に profileId を付ける', async () => {
    const transport = cardServer({ cards: [card], profiles: [profile] }, {
      'POST /expense/card-statements/preview': () => ({ result: previewResult({ detectedProfileId: 'prof1', headers: [...headers, '備考'] }) }),
      'POST /expense/card-statements': () => ({ result: { importId: 'imp2', imported: 2, duplicates: 1, skippedRows: [], warnings: [], periodFrom: '2026-09-01', periodTo: '2026-09-02' } }),
    });
    renderLedger(transport);
    await screen.findByText('••1234');
    await uploadCsv();
    await waitFor(() => expect((screen.getByLabelText('Column for Memo') as HTMLSelectElement).value).toBe('備考'));
    expect((screen.getByLabelText('Saved mapping') as HTMLSelectElement).value).toBe('prof1');
    await userEvent.click(screen.getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(transport.callsTo('POST', '/expense/card-statements')[0]?.body).toMatchObject({ profileId: 'prof1', mapping: { columns: profile.columns, amountSign: 'charge-negative', skipLinesBefore: 1 } }));
    // 保存済みの対応を選び直すと、その対応で埋め直す。
    await userEvent.selectOptions(screen.getByLabelText('Saved mapping'), '');
    await userEvent.selectOptions(screen.getByLabelText('Saved mapping'), 'prof1');
    expect((screen.getByLabelText('Lines before the header') as HTMLInputElement).value).toBe('1');
  });

  it('異常: 同じファイルの取込（409）は取込済みと取込 id を出し、取込の一覧でその行を示す', async () => {
    const transport = cardServer({ cards: [card], imports: [importEntry] }, {
      'POST /expense/card-statements/preview': () => ({ result: previewResult() }),
      'POST /expense/card-statements': () => { throw new ApiError(409, 'EXPENSE_CARD_DUPLICATE_IMPORT', 'duplicate', undefined, { details: { importId: 'imp1', importedAt: '2026-09-10T10:00:00.000Z' } }); },
    });
    renderLedger(transport);
    await screen.findByText('sept.csv');
    await uploadCsv();
    await userEvent.click(await screen.findByRole('button', { name: 'Import' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/This file has already been imported \(import imp1, 2026-09-10\)/)).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Show the import' }));
    expect(screen.getByRole('button', { name: 'Delete the import sept.csv' }).closest('tr')?.className).toContain('expense-focused');
  });

  it('異常: 列が足りない 400 は足りない列を出す', async () => {
    const transport = cardServer({ cards: [card] }, {
      'POST /expense/card-statements/preview': () => ({ result: previewResult() }),
      'POST /expense/card-statements': () => { throw new ApiError(400, 'EXPENSE_CARD_IMPORT', 'card statement: choose which columns hold the date, merchant, and amount', undefined, { details: { missingColumns: ['merchant'] } }); },
    });
    renderLedger(transport);
    await screen.findByText('••1234');
    await uploadCsv();
    await userEvent.click(await screen.findByRole('button', { name: 'Import' }));
    expect(await screen.findByText('Choose the columns for: merchant')).toBeTruthy();
  });

  it('正常: 取込の削除は対象外の印・手動の紐付けも消えることを確認してから消す', async () => {
    const transport = cardServer({ imports: [importEntry], transactions: [unmatched] });
    const props = renderLedger(transport);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete the import sept.csv' }));
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Exclusion marks and manual links on them are also removed/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(transport.callsTo('DELETE', '/expense/card-statements/imp1')).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Delete the import sept.csv' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Deleted the import sept.csv.')).toBeTruthy();
    expect(transport.callsTo('DELETE', '/expense/card-statements/imp1')).toHaveLength(1);
    expect(props.onClaimsChanged).toHaveBeenCalled();
    await waitFor(() => expect(screen.getAllByText('Import a card statement CSV from the card company.').length).toBeGreaterThan(0));
  });

  it('正常: 照合を実行して件数を出し、期間が逆なら押せない', async () => {
    const transport = cardServer();
    const props = renderLedger(transport);
    fireEvent.change(await screen.findByLabelText('From (optional)'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('To (optional)'), { target: { value: '2026-09-01' } });
    expect((screen.getByRole('button', { name: 'Run matching' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The start date must not be after the end date.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('To (optional)'), { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'Run matching' }));
    expect(await screen.findByText('Matched 3 (possible double payments: 1), unmatched 2, kept 0.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/card-transactions/match')[0]?.body).toEqual({ scope: expect.anything(), from: '2026-09-30' });
    expect(props.onClaimsChanged).toHaveBeenCalled();
  });

  it('正常: 立替と一致した利用は「二重払いの疑い」として先頭に出す', async () => {
    renderLedger(cardServer({ transactions: [matchedCorporate, unmatched, suspect] }));
    const table = await screen.findByRole('table', { name: 'Card transactions' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('Possible double payment')).toBeTruthy();
    expect(rows[1]!.className).toContain('expense-money-row-suspect');
    expect(within(rows[1]!).getByText(/weak match · manual/)).toBeTruthy();
    expect(within(rows[2]!).getByText(/山田 太郎 · Approved · strong match/)).toBeTruthy();
  });

  it('正常: 対象外は理由が必須、対象外の取消・紐付け解除・申請の明細を開くができる', async () => {
    const transport = cardServer({ transactions: [matchedCorporate, unmatched, excluded] });
    const props = renderLedger(transport);
    const row = await screen.findByRole('row', { name: '2026-09-04 タクシー' });
    await userEvent.click(within(row).getByRole('button', { name: 'Exclude' }));
    const form = screen.getByRole('form', { name: 'Reason for excluding' });
    expect((within(form).getByRole('button', { name: 'Exclude' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(within(form).getByLabelText('Reason for excluding'), '私用の立替で精算済み');
    await userEvent.click(within(form).getByRole('button', { name: 'Exclude' }));
    expect(await screen.findByText('Marked the transaction as excluded.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/card-transactions/tx2/exclude')[0]?.body).toMatchObject({ reason: '私用の立替で精算済み' });
    expect(screen.queryByRole('form', { name: 'Reason for excluding' })).toBeNull();

    const excludedRow = screen.getByRole('row', { name: '2026-09-06 年会費' });
    expect(within(excludedRow).getByText(/会社の年会費/)).toBeTruthy();
    await userEvent.click(within(excludedRow).getByRole('button', { name: 'Include again' }));
    expect(await screen.findByText('Removed the exclusion.')).toBeTruthy();

    const matchedRow = screen.getByRole('row', { name: '2026-09-03 JR東日本' });
    await userEvent.click(within(matchedRow).getByRole('button', { name: 'Open the claim item' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'c1', section: 'item:i1' });
    await userEvent.click(within(matchedRow).getByRole('button', { name: 'Unlink' }));
    expect(await screen.findByText('Removed the link.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/card-transactions/tx1/unlink')).toHaveLength(1);
    expect(props.onClaimsChanged).toHaveBeenCalled();
  });

  it('正常: 手動の紐付けは申請を選ぶとその明細を選べ、送ると照合済みになる', async () => {
    const transport = cardServer({ transactions: [unmatched] });
    renderLedger(transport, { claims: [claim] });
    const row = await screen.findByRole('row', { name: '2026-09-04 タクシー' });
    await userEvent.click(within(row).getByRole('button', { name: 'Link manually' }));
    const form = screen.getByRole('form', { name: 'Link manually' });
    expect((within(form).getByRole('button', { name: 'Link' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.selectOptions(within(form).getByLabelText('Claim'), 'c1');
    await waitFor(() => expect(within(form).getByLabelText('Item')).toBeTruthy());
    expect(within(form).getByText('2026-09-04 · 日本交通 · ¥2,500')).toBeTruthy();
    await userEvent.click(within(form).getByRole('button', { name: 'Link' }));
    expect(await screen.findByText('Linked the transaction to the item.')).toBeTruthy();
    expect(transport.callsTo('POST', '/expense/card-transactions/tx2/link')[0]?.body).toMatchObject({ claimId: 'c1', itemId: 'i1' });
  });

  it('異常: 申請が無く明細が読めなければ id を手入力でき、409 は次の一手と導線を出す', async () => {
    const transport = cardServer({ transactions: [unmatched] }, {
      'GET /expense/claims/:id': () => { throw new Error('not found'); },
      'POST /expense/card-transactions/:id/link': () => { throw transitionError('この明細は別のカード利用に照合済みです。そちらの紐付けを外してから操作してください', [{ code: 'card-item-matched', params: { cardTransactionId: 'tx9', claimId: 'c7', itemId: 'i7' } }]); },
    });
    const props = renderLedger(transport);
    const row = await screen.findByRole('row', { name: '2026-09-04 タクシー' });
    await userEvent.click(within(row).getByRole('button', { name: 'Link manually' }));
    const form = screen.getByRole('form', { name: 'Link manually' });
    await userEvent.type(within(form).getByLabelText('Claim ID'), 'c7');
    await userEvent.type(within(form).getByLabelText('Item ID'), 'i7');
    await userEvent.click(within(form).getByRole('button', { name: 'Link' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('この明細は別のカード利用に照合済みです。そちらの紐付けを外してから操作してください')).toBeTruthy();
    expect(within(alert).getByText('The item is already matched to another card transaction.')).toBeTruthy();
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the item' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'c7', section: 'item:i7' });
    await userEvent.click(within(alert).getByRole('button', { name: 'Open the card transaction' }));
    expect(props.onOpen).toHaveBeenCalledWith({ internalId: 'tx9', section: 'card' });
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Link manually' })).toBeNull();
  });

  it('正常: 導線 cards は未照合の一覧を、card はその利用を強調して開く', async () => {
    const transport = cardServer({ transactions: [matchedCorporate, unmatched] });
    const { rerender } = render(<NavigationProvider navigate={vi.fn()}><CardsLedger {...ledgerProps(transport, { focus: { tab: 'cards', section: 'cards', id: '', seq: 1 } })} /></NavigationProvider>);
    await waitFor(() => expect(transport.calls.some((call) => call.path === '/expense/card-transactions' && call.query.get('status') === 'unmatched')).toBe(true));
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('unmatched');
    rerender(<NavigationProvider navigate={vi.fn()}><CardsLedger {...ledgerProps(transport, { focus: { tab: 'cards', section: 'card', id: 'tx1', seq: 2 } })} /></NavigationProvider>);
    await waitFor(() => expect(screen.getByRole('row', { name: '2026-09-03 JR東日本' }).className).toContain('expense-focused'));
  });

  it('正常: 絞り込みで該当が無ければ「すべての状態を表示」で戻せ、読み込みの失敗は文言を出す', async () => {
    const transport = cardServer({ transactions: [unmatched], imports: [importEntry] }, { 'GET /expense/card-settings': () => { throw new Error('settings down'); } });
    renderLedger(transport);
    expect(await screen.findByText('settings down')).toBeTruthy();
    await screen.findByRole('row', { name: '2026-09-04 タクシー' });
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'excluded');
    expect(await screen.findByText('There are no card transactions in this status.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Show all statuses' }));
    expect(await screen.findByRole('row', { name: '2026-09-04 タクシー' })).toBeTruthy();
  });

  it('sortTransactions / mappingFrom: 疑いを先頭へ、必須の列が揃わなければ undefined', () => {
    expect(sortTransactions([unmatched, suspect, matchedCorporate]).map((entry) => entry.id)).toEqual(['tx3', 'tx2', 'tx1']);
    expect(mappingFrom({ usedOn: 'a', merchant: 'b' }, 'charge-positive', 0)).toBeUndefined();
    expect(mappingFrom({ usedOn: 'a', merchant: 'b', amount: 'c', postedOn: 'd', cardLast4: 'e', memo: 'f' }, 'charge-positive', 0)).toEqual({ columns: { usedOn: 'a', merchant: 'b', amount: 'c', postedOn: 'd', cardLast4: 'e', memo: 'f' }, amountSign: 'charge-positive', skipLinesBefore: 0 });
  });
});
