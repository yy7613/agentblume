// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExpenseCategoryDto, SaveExpensePolicyDto } from '../../api/expense-types';
import { scope } from '../../scope';
import { DEFAULT_TRANSPORT_SETTINGS, TransportSettingsSection, withRouteFlag } from './TransportSettingsSection';

afterEach(() => { cleanup(); });

const category = (id: string, name: string, extra: Partial<ExpenseCategoryDto> = {}) => ({
  id, name, enabled: true, sortOrder: 1, aliases: [], defaultTaxRate: 10, taxCodeByRate: {}, receipt: { required: true }, invoice: { required: true },
  requires: { purpose: false, attendees: false, attendeeDetails: false }, limits: { perPersonBasis: 'tax-included' }, ...extra,
}) as unknown as ExpenseCategoryDto;

const baseDraft = {
  categories: [category('transport', '旅費交通費', { route: { required: true, commuterPass: false, fareTable: false } }), category('misc', '', { enabled: false })],
  claimRules: { nonReimbursablePaymentMethods: [], attendeesIncludeClaimant: true, forbidSelfApproval: false }, preApprovalRules: [], severityOverrides: {},
  journal: { creditAccountId: 'payables', creditTaxCode: 'JP-NA', partnerFrom: 'claimant', descriptionTemplate: '' },
} as unknown as SaveExpensePolicyDto;

function renderSection(draft: SaveExpensePolicyDto = baseDraft) {
  const onChange = vi.fn();
  const onOpen = vi.fn();
  let setOuter: (next: SaveExpensePolicyDto) => void = () => undefined;
  function Harness() {
    const [current, setCurrent] = useState(draft);
    setOuter = setCurrent;
    return <TransportSettingsSection transport={{ request: vi.fn() } as unknown as ApiTransport} scope={scope} onOpen={onOpen} draft={current} saved chart={undefined} focus={undefined}
      onChange={(next) => { onChange(next); setCurrent(next); }} />;
  }
  render(<Harness />);
  return { onChange, onOpen, setDraft: (next: SaveExpensePolicyDto) => setOuter(next) };
}

const last = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[mock.mock.calls.length - 1]?.[0] as SaveExpensePolicyDto;

describe('TransportSettingsSection', () => {
  it('正常: transport が無ければ既定値を出し、定期の控除を外すと既定値を補った transport で onChange する', async () => {
    const { onChange } = renderSection();
    const deduction = screen.getByLabelText('Deduct commuter pass sections') as HTMLInputElement;
    expect(deduction.checked).toBe(true);
    expect((screen.getByLabelText('Allowed fare excess in yen') as HTMLInputElement).value).toBe('0');
    await userEvent.click(deduction);
    expect(last(onChange).transport).toEqual({ ...DEFAULT_TRANSPORT_SETTINGS, commuterPassDeduction: false });
    expect(last(onChange).categories).toBe(baseDraft.categories);
    await userEvent.selectOptions(screen.getByLabelText('Default fare type'), 'ticket');
    expect(last(onChange).transport).toEqual({ commuterPassDeduction: false, fareToleranceYen: 0, defaultFareType: 'ticket' });
  });

  it('境界: 許容差は 0〜10000 の整数だけを反映し、範囲外や数字以外は案内を出して最後の正しい値のまま', async () => {
    const { onChange } = renderSection();
    const input = screen.getByLabelText('Allowed fare excess in yen');
    await userEvent.clear(input);
    await userEvent.type(input, '10000');
    expect(last(onChange).transport?.fareToleranceYen).toBe(10000);
    const count = onChange.mock.calls.length;
    await userEvent.type(input, '1');
    expect(onChange.mock.calls.length).toBe(count);
    expect(screen.getByText('Enter a whole number from 0 to 10000. The last valid value is kept.')).toBeTruthy();
    await userEvent.clear(input);
    await userEvent.type(input, 'abc');
    expect(onChange.mock.calls.length).toBe(count);
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('正常: 規程の読み直しで許容差が変わったら入力欄も追従する', () => {
    const { setDraft } = renderSection({ ...baseDraft, transport: { commuterPassDeduction: false, fareToleranceYen: 30, defaultFareType: 'ticket' } });
    const input = screen.getByLabelText('Allowed fare excess in yen') as HTMLInputElement;
    expect(input.value).toBe('30');
    expect((screen.getByLabelText('Deduct commuter pass sections') as HTMLInputElement).checked).toBe(false);
    setDraft({ ...baseDraft, transport: { commuterPassDeduction: false, fareToleranceYen: 120, defaultFareType: 'ticket' } });
    return screen.findByDisplayValue('120').then((element) => expect(element).toBe(input));
  });

  it('正常: 費目の route を 3 つとも外すと route を消し（区間を使わない費目）、付けると route を作る', async () => {
    const { onChange } = renderSection();
    await userEvent.click(screen.getByLabelText('旅費交通費: route required'));
    const transport = last(onChange).categories[0];
    expect(transport !== undefined && 'route' in transport).toBe(false);
    expect(last(onChange).transport).toEqual(DEFAULT_TRANSPORT_SETTINGS);

    await userEvent.click(screen.getByLabelText('misc: check commuter pass'));
    expect(last(onChange).categories[1]?.route).toEqual({ required: false, commuterPass: true, fareTable: false });
    await userEvent.click(screen.getByLabelText('misc: check fare table'));
    expect(last(onChange).categories[1]?.route).toEqual({ required: false, commuterPass: true, fareTable: true });
    expect(screen.getByText('(disabled)')).toBeTruthy();
  });

  it('正常: 照合の限界を明記し、「運賃マスタを開く」は台帳の fares を開く', async () => {
    const { onOpen } = renderSection();
    expect(screen.getByText(/only when the fare table has a route or the claimant has a commuter pass/)).toBeTruthy();
    expect(screen.getByText(/A > D > C/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the fare table' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: '', section: 'fares' });
  });

  it('境界: withRouteFlag は他の項目を保ち、route が無い費目で false を付けても route を作らない', () => {
    const plain = category('meal', '会議費');
    expect('route' in withRouteFlag(plain, 'required', false)).toBe(false);
    expect(withRouteFlag(plain, 'fareTable', true).route).toEqual({ required: false, commuterPass: false, fareTable: true });
    expect(withRouteFlag(category('t', 't', { route: { required: true, commuterPass: true, fareTable: false } }), 'required', false).route).toEqual({ required: false, commuterPass: true, fareTable: false });
  });
});
