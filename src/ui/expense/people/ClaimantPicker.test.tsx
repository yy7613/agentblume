// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { ApiTransport } from '../../api/business-api';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExpenseEmployeeDto } from '../../api/expense-people-types';
import { emptyClaimDraft, type ClaimFormDraft } from '../expense-model';
import { ClaimantPicker } from './ClaimantPicker';

afterEach(cleanup);

const scope = { tenantId: 't', workspaceId: 'w' };
const taro: ExpenseEmployeeDto = {
  id: 'e1', code: 'E001', name: 'テスト太郎', nameKana: 'テストタロウ', departmentId: 'd1', departmentName: '営業部', loginSubjects: [], commuterPasses: [], enabled: true, history: [],
  createdAt: 'x', updatedAt: 'x', payoutReadiness: { problems: [], warnings: [] },
};

function renderPicker(employees: Promise<readonly ExpenseEmployeeDto[]>, initial: Partial<ClaimFormDraft> = {}) {
  const request = vi.fn(async (path: string) => {
    if (path.startsWith('/expense/employees?')) return { employees: await employees };
    throw new Error(`unexpected ${path}`);
  });
  const onChange = vi.fn();
  const onOpen = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState<ClaimFormDraft>({ ...emptyClaimDraft(new Date(2026, 8, 1)), ...initial });
    return <div>
      <input id="expense-claim-name" aria-label="Claimant name" value={draft.name} readOnly />
      <ClaimantPicker transport={{ request: request as unknown as ApiTransport['request'] }} scope={scope} onOpen={onOpen} mode="new" claim={undefined} draft={draft} inputId="expense-claim-name"
        onChange={(next) => { onChange(next); setDraft(next); }} />
    </div>;
  }
  render(<Harness />);
  return { request, onChange, onOpen };
}

describe('ClaimantPicker', () => {
  it('正常: 有効な従業員を検索して選ぶと紐付けと写しを下書きに入れ、紐付き中の表示に変わる', async () => {
    const { request, onChange } = renderPicker(Promise.resolve([taro]));
    await userEvent.type(await screen.findByLabelText('Search the employee master'), 'テスト');
    expect(screen.getByText(/the server fills in the name, employee code, and department/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose テスト太郎' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ employeeId: 'e1', name: 'テスト太郎', employeeCode: 'E001', department: '営業部' }));
    expect(screen.getByText('Linked to the employee master (テスト太郎 · E001)')).toBeTruthy();
    const query = new URLSearchParams(String(request.mock.calls[0]?.[0]).split('?')[1]);
    expect(query.get('enabled')).toBe('true');
  });

  it('正常: 紐付けを外すと employeeId を空にして氏名の入力欄へ戻す', async () => {
    const { onChange } = renderPicker(Promise.resolve([taro]), { employeeId: 'e1', name: 'テスト太郎', employeeCode: 'E001' });
    await userEvent.click(await screen.findByRole('button', { name: 'Unlink' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ employeeId: '', name: 'テスト太郎' }));
    expect(document.activeElement?.id).toBe('expense-claim-name');
    expect(await screen.findByLabelText('Search the employee master')).toBeTruthy();
  });

  it('境界: 紐付いた従業員が一覧に無くても、下書きの写しで紐付きを見せる', async () => {
    renderPicker(Promise.resolve([taro]), { employeeId: 'e404', name: '退職者', employeeCode: '' });
    expect(await screen.findByText('Linked to the employee master (退職者)')).toBeTruthy();
  });

  it('正常: 入力済みの氏名から候補を出し、一致しなければ入力のままでよいと伝える', async () => {
    renderPicker(Promise.resolve([taro]), { name: 'テスト' });
    expect(await screen.findByRole('button', { name: 'Choose テスト太郎' })).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Search the employee master'), '存在しない');
    expect(screen.getByText('No employee matches. You can keep the name as typed.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose テスト太郎' })).toBeNull();
  });

  it('境界: マスタが空なら従来の氏名入力のまま、マスタを使う利点と開くボタンを出す', async () => {
    const { onOpen } = renderPicker(Promise.resolve([]));
    expect(await screen.findByText('Use the employee master to enable approval routes and payout files.')).toBeTruthy();
    expect(screen.queryByLabelText('Search the employee master')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Open the employee master' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: '', section: 'employee' });
  });

  it('異常: 読めなければ小さく出すだけで、赤くせず入力を妨げない', async () => {
    renderPicker(Promise.reject(new Error('network down')));
    expect(await screen.findByText(/Could not load the employee master, so enter the claimant by hand \(network down\)/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(() => expect((screen.getByLabelText('Claimant name') as HTMLInputElement).disabled).toBe(false));
  });
});
