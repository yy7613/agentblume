// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SaveExpensePolicyDto } from '../../api/expense-types';
import type { JournalChartOfAccountsDto } from '../../api/types';
import type { ExpensePolicySectionSlotProps } from '../expense-slots';
import { DEFAULT_ADVANCE_POLICY, DEFAULT_CARD_POLICY, MoneySettingsSection } from './MoneySettingsSection';
import { fakeTransport, testScope } from './money-test-helpers';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const baseDraft = { categories: [], preApprovalRules: [], severityOverrides: {} } as unknown as SaveExpensePolicyDto;

const chart = {
  accounts: [
    { id: 'asset.suspense_paid', code: '1150', name: '仮払金', category: 'asset', aliases: [], enabled: true, sortOrder: 1 },
    { id: 'asset.cash', name: '現金', category: 'asset', aliases: [], enabled: true, sortOrder: 2 },
    { id: 'asset.ordinary_deposit', code: '1120', name: '普通預金', category: 'asset', aliases: [], enabled: true, sortOrder: 3 },
    { id: 'liability.other_payables', code: '2150', name: '未払金', category: 'liability', aliases: [], enabled: true, sortOrder: 4 },
    { id: 'asset.disabled', name: '使わない', category: 'asset', aliases: [], enabled: false, sortOrder: 5 },
  ],
  dimensions: [],
  taxCategories: [{ code: 'JP-NA', name: '対象外', side: 'none', enabled: true }, { code: 'JP-P10', name: '課税仕入 10%', side: 'in', rate: 10, enabled: true }],
  updatedAt: 'x',
} as unknown as JournalChartOfAccountsDto;

function renderSection(overrides: Partial<ExpensePolicySectionSlotProps> = {}) {
  const onChange = vi.fn();
  const props: ExpensePolicySectionSlotProps = { transport: fakeTransport({}), scope: testScope, onOpen: vi.fn(), draft: baseDraft, saved: true, onChange, chart: undefined, focus: undefined, ...overrides };
  const view = render(<MoneySettingsSection {...props} />);
  return { onChange, props, view };
}

const lastCall = (onChange: ReturnType<typeof vi.fn>): SaveExpensePolicyDto => onChange.mock.calls.at(-1)?.[0] as SaveExpensePolicyDto;

describe('MoneySettingsSection', () => {
  it('正常: card / advance が無ければ既定値で表示し、変えたときに両方を書き込む', async () => {
    const { onChange } = renderSection();
    expect(screen.getByText('Showing the default values. They are written into the policy when you change them.')).toBeTruthy();
    expect((screen.getByLabelText('Date tolerance (days, 0–10)') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Payment account') as HTMLInputElement).value).toBe('asset.ordinary_deposit');
    expect(screen.queryByRole('button', { name: /save/iu })).toBeNull();

    fireEvent.change(screen.getByLabelText('Date tolerance (days, 0–10)'), { target: { value: '5' } });
    expect(lastCall(onChange)).toMatchObject({ categories: [], card: { ...DEFAULT_CARD_POLICY, dateToleranceDays: 5 }, advance: DEFAULT_ADVANCE_POLICY });

    fireEvent.change(screen.getByLabelText('Payment account'), { target: { value: 'asset.cash' } });
    expect(lastCall(onChange).advance).toEqual({ ...DEFAULT_ADVANCE_POLICY, paymentAccountId: 'asset.cash' });

    fireEvent.change(screen.getByLabelText('Tax category for company-paid items'), { target: { value: 'JP-P10' } });
    expect(lastCall(onChange).card?.creditTaxCode).toBe('JP-P10');

    await userEvent.click(screen.getByLabelText(/Include company-paid card items in claims/u));
    expect(lastCall(onChange).card?.acceptCorporatePaymentItems).toBe(true);
  });

  it('境界: 範囲外・整数でない値は書き戻さず直し方を出し、範囲の端は受け付ける', () => {
    const { onChange } = renderSection();
    fireEvent.change(screen.getByLabelText('Date tolerance (days, 0–10)'), { target: { value: '11' } });
    expect(screen.getByText('Enter a whole number from 0 to 10.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Amount tolerance (yen, 0–1,000)'), { target: { value: '1.5' } });
    expect(screen.getByText('Enter a whole number from 0 to 1,000.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Minimum amount for a weak match (yen)'), { target: { value: '0' } });
    expect(screen.getByText('Enter a whole number from 1 to 1,000,000.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Date tolerance (days, 0–10)'), { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();

    // onChange は親の下書きを差し替えるだけ（このテストでは draft が変わらない）ので、1 回ごとの呼び出しで端の値を確かめる。
    fireEvent.change(screen.getByLabelText('Date tolerance (days, 0–10)'), { target: { value: '10' } });
    expect(lastCall(onChange).card?.dateToleranceDays).toBe(10);
    fireEvent.change(screen.getByLabelText('Amount tolerance (yen, 0–1,000)'), { target: { value: '1000' } });
    expect(lastCall(onChange).card?.amountToleranceYen).toBe(1000);
    fireEvent.change(screen.getByLabelText('Minimum amount for a weak match (yen)'), { target: { value: '1' } });
    expect(lastCall(onChange).card?.weakMatchMinAmount).toBe(1);
    expect(screen.queryByText('Enter a whole number from 0 to 10.')).toBeNull();
  });

  it('正常: 精算の目安日数は任意（空で消す）', () => {
    const { onChange } = renderSection({ draft: { ...baseDraft, advance: { ...DEFAULT_ADVANCE_POLICY, settleWithinDays: 30 } } });
    const input = screen.getByLabelText('Settle within (days after payment, optional)') as HTMLInputElement;
    expect(input.value).toBe('30');
    fireEvent.change(input, { target: { value: '45' } });
    expect(lastCall(onChange).advance?.settleWithinDays).toBe(45);
    fireEvent.change(input, { target: { value: '' } });
    expect(lastCall(onChange).advance).not.toHaveProperty('settleWithinDays');
    fireEvent.change(input, { target: { value: '366' } });
    expect(screen.getByText('Enter a whole number from 1 to 365.')).toBeTruthy();
  });

  it('正常: 科目マスタがあれば有効な科目から選び、マスタに無い値はその旨を出す', () => {
    const draft = { ...baseDraft, card: { ...DEFAULT_CARD_POLICY, creditAccountId: 'liability.unknown', creditTaxCode: 'JP-OLD' }, advance: DEFAULT_ADVANCE_POLICY };
    const { onChange } = renderSection({ draft, chart });
    expect(screen.queryByText(/Showing the default values/u)).toBeNull();
    const credit = screen.getByLabelText('Credit account for company-paid items') as HTMLSelectElement;
    expect(credit.value).toBe('liability.unknown');
    expect(screen.getByText('liability.unknown (not in the chart)')).toBeTruthy();
    expect(screen.getByText('JP-OLD (not in the chart)')).toBeTruthy();
    expect(screen.getAllByText('Not in the journal chart of accounts')).toHaveLength(1);
    expect(screen.queryByText('使わない')).toBeNull();
    fireEvent.change(screen.getByLabelText('Advance account'), { target: { value: 'asset.cash' } });
    expect(lastCall(onChange)).toMatchObject({ card: draft.card, advance: { ...DEFAULT_ADVANCE_POLICY, advanceAccountId: 'asset.cash' } });
    fireEvent.change(screen.getByLabelText('Refund account'), { target: { value: 'asset.cash' } });
    expect(lastCall(onChange).advance?.refundAccountId).toBe('asset.cash');
    fireEvent.change(credit, { target: { value: 'liability.other_payables' } });
    expect(lastCall(onChange).card?.creditAccountId).toBe('liability.other_payables');
    // 会社払いの貸方・仮払金・支払・返金の 4 つの選択肢に同じ科目が並ぶ。
    expect(screen.getAllByText('1150 仮払金')).toHaveLength(4);
  });

  it('正常: 下書きが外から変わったら入力欄も追従する', () => {
    const { view, props } = renderSection();
    view.rerender(<MoneySettingsSection {...props} draft={{ ...baseDraft, card: { ...DEFAULT_CARD_POLICY, dateToleranceDays: 7 } }} />);
    expect((screen.getByLabelText('Date tolerance (days, 0–10)') as HTMLInputElement).value).toBe('7');
    fireEvent.change(screen.getByLabelText('Credit account for company-paid items'), { target: { value: 'liability.x' } });
    expect(lastCall(props.onChange as ReturnType<typeof vi.fn>).card?.creditAccountId).toBe('liability.x');
  });
});
