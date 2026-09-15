// @vitest-environment jsdom
/**
 * 期限台帳。絞り込みの送信値・状態チップ・行の操作（通知済み・契約を開く）・終了と削除・空状態の導線を守る。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractApi } from '../api/contract-api';
import type { LedgerDto, SignedContractDto } from '../api/contract-types';
import { LedgerStep } from './LedgerStep';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fakeApi(overrides: Partial<Record<keyof ContractApi, unknown>>): ContractApi {
  const cache = new Map<PropertyKey, unknown>(Object.entries(overrides));
  return new Proxy({}, {
    get: (_target, key) => {
      if (!cache.has(key)) cache.set(key, vi.fn(async () => { throw new Error(`unexpected call ${String(key)}`); }));
      return cache.get(key);
    },
  }) as ContractApi;
}

const ledger: LedgerDto = {
  today: '2026-09-15', dueSoonDays: 60,
  rows: [
    { contractId: 'con-1', title: '保守業務委託', counterpartyName: '架空テック合同会社', deadline: { id: 'renewal_notice-1', kind: 'renewal_notice', dueDate: '2026-10-31', basis: '第3条', status: 'open' }, daysLeft: 46, state: 'due-soon', autoRenewal: true, contractStatus: 'active' },
    { contractId: 'con-2', title: '清掃委託', counterpartyName: '架空清掃', deadline: { id: 'expiry-1', kind: 'expiry', dueDate: '2026-09-12', basis: '第2条', status: 'open' }, daysLeft: -3, state: 'overdue', autoRenewal: false, contractStatus: 'active' },
  ],
};

const contract: SignedContractDto = {
  id: 'con-1', documentId: 'doc-1', title: '保守業務委託', counterpartyName: '架空テック合同会社', signedDate: '2026-03-20', signingMethod: 'paper',
  clauses: [
    { topicId: 'term', topicLabel: '契約期間', valueKind: 'term', present: true, articleRef: '第2条', quoteVerified: true },
    { topicId: 'payment', topicLabel: '支払条件', valueKind: 'payment_terms', present: true, quoteVerified: false },
    { topicId: 'ip', topicLabel: '知的財産', valueKind: 'ip_ownership', present: false, quoteVerified: false },
  ],
  deadlines: [ledger.rows[0]!.deadline], status: 'active', displayStatus: 'expired', reviewVerdicts: {}, warnings: [{ message: '通知期限を過ぎています' }], createdAt: 'c', updatedAt: 'u',
};

function setup(options: { ledger?: LedgerDto; focus?: string; overrides?: Partial<Record<keyof ContractApi, unknown>> } = {}) {
  const api = fakeApi({
    listDeadlines: vi.fn(async () => options.ledger ?? ledger),
    getSigned: vi.fn(async () => contract),
    completeDeadline: vi.fn(async () => contract),
    terminateSigned: vi.fn(async () => ({ ...contract, status: 'terminated', displayStatus: undefined })),
    deleteSigned: vi.fn(async () => undefined),
    ...options.overrides,
  });
  const onImport = vi.fn();
  const onChanged = vi.fn();
  render(<LedgerStep api={api} {...(options.focus === undefined ? {} : { focusContractId: options.focus })} onImport={onImport} onChanged={onChanged} />);
  return { api, onImport, onChanged };
}

const lastQuery = (api: ContractApi) => vi.mocked(api.listDeadlines).mock.calls.at(-1)?.[1];

describe('LedgerStep', () => {
  it('正常: 90 日以内（期限切れを含む）で読み、状態チップ・残り日数を出す', async () => {
    const { api } = setup();
    const table = await screen.findByRole('table');
    expect(lastQuery(api)).toEqual({ withinDays: 90, includeOverdue: true });
    expect(within(table).getByText('Due soon')).toBeTruthy();
    expect(within(table).getByText('3 days overdue')).toBeTruthy();
    expect(within(table).getByText('Renewal notice deadline')).toBeTruthy();
    expect(screen.getByText('Today: 2026-09-15')).toBeTruthy();
  });

  it('正常: 期間・種類はサーバーへ送り、状態は画面で絞る。0 行になると空状態を出す', async () => {
    const { api, onImport } = setup();
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Within'), { target: { value: '30' } });
    await waitFor(() => expect(lastQuery(api)).toEqual({ withinDays: 30, includeOverdue: true }));
    fireEvent.change(screen.getByLabelText('Within'), { target: { value: '' } });
    await waitFor(() => expect(lastQuery(api)).toEqual({ includeOverdue: true }));
    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'expiry' } });
    await waitFor(() => expect(lastQuery(api)).toEqual({ includeOverdue: true, kind: 'expiry' }));
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'overdue' } });
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByText('清掃委託')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'upcoming' } });
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Import a contract' }));
    expect(onImport).toHaveBeenCalled();
  });

  it('境界: 期限が 1 件も無ければ空状態から取込へ案内する', async () => {
    const { onImport } = setup({ ledger: { ...ledger, rows: [] } });
    expect(await screen.findByText('Deadlines of the contracts you register as signed appear here.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Import a contract' }));
    expect(onImport).toHaveBeenCalled();
  });

  it('正常: 契約を開くと詳細（警告・期限・条項の有無）を出し、開いている契約の通知済みは詳細も読み直す', async () => {
    const { api } = setup();
    await screen.findByRole('table');
    await userEvent.click(screen.getAllByRole('button', { name: 'Open contract' })[0]!);
    expect(await screen.findByText('架空テック合同会社 · signed 2026-03-20')).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.getByText('通知期限を過ぎています')).toBeTruthy();
    expect(screen.getByText('契約期間: 第2条')).toBeTruthy();
    expect(screen.getByText('知的財産: not present')).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as notified' })[0]!);
    await waitFor(() => expect(api.getSigned).toHaveBeenCalledTimes(2));
    expect(api.completeDeadline).toHaveBeenCalledWith(expect.anything(), 'con-1', 'renewal_notice-1');
    expect(screen.getByText('Marked as notified.')).toBeTruthy();
  });

  it('境界: 開いていない契約の通知済みは詳細を読み直さない', async () => {
    const { api } = setup();
    await screen.findByRole('table');
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as notified' })[1]!);
    await screen.findByText('Marked as notified.');
    expect(api.getSigned).not.toHaveBeenCalled();
  });

  it('正常: ディープリンクで契約を開き、終了日と理由を入れて終了にすると終了フォームを消す', async () => {
    const { api, onChanged } = setup({ focus: 'con-1' });
    const terminate = await screen.findByRole('button', { name: 'Terminate' });
    expect((terminate as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Terminated on'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: '合意解約' } });
    await userEvent.click(terminate);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.terminateSigned).toHaveBeenCalledWith(expect.anything(), 'con-1', '2026-09-30', '合意解約');
    expect(screen.getByText('The contract is terminated. Its open deadlines were closed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Terminate' })).toBeNull();
    expect(screen.getByText('Terminated')).toBeTruthy();
  });

  it('正常: 確認して台帳から削除すると詳細を閉じ、取り消すと何もしない', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { api, onChanged } = setup({ focus: 'con-1' });
    const remove = await screen.findByRole('button', { name: 'Delete from the ledger' });
    await userEvent.click(remove);
    expect(api.deleteSigned).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    await userEvent.click(remove);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(api.deleteSigned).toHaveBeenCalledWith(expect.anything(), 'con-1');
    expect(screen.queryByRole('button', { name: 'Delete from the ledger' })).toBeNull();
  });

  it('異常: 読み込み・契約の取得・通知済み・終了・削除の失敗はそれぞれ案内を出す', async () => {
    const fail = (message: string) => vi.fn(async () => { throw new Error(message); });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { api } = setup({ focus: 'con-1', overrides: { completeDeadline: fail('complete failed'), terminateSigned: fail('terminate failed'), deleteSigned: fail('delete failed') } });
    await screen.findByRole('button', { name: 'Terminate' });
    await userEvent.click(screen.getAllByRole('button', { name: 'Mark as notified' })[0]!);
    expect((await screen.findByRole('alert')).textContent).toContain('complete failed');
    fireEvent.change(screen.getByLabelText('Terminated on'), { target: { value: '2026-09-30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Terminate' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('terminate failed'));
    expect(api.terminateSigned).toHaveBeenCalledWith(expect.anything(), 'con-1', '2026-09-30', '');
    await userEvent.click(screen.getByRole('button', { name: 'Delete from the ledger' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('delete failed'));
  });

  it('異常: 台帳と契約の取得に失敗したら案内を出す', async () => {
    setup({ focus: 'con-x', overrides: { listDeadlines: vi.fn(async () => { throw new Error('list failed'); }), getSigned: vi.fn(async () => { throw new Error('get failed'); }) } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/list failed|get failed/));
  });
});
