// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExpenseFareLookupResultDto } from '../../api/expense-input-types';
import type { ExpenseCategoryDto, ExpenseClaimDto, ExpenseReceiptRouteDto } from '../../api/expense-types';
import { scope } from '../../scope';
import { RouteFields, routeOf } from './RouteFields';

afterEach(() => { cleanup(); });

const claim = { id: 'c1', claimant: { name: '山田 太郎', employeeId: 'e1' }, period: { from: '2026-09-01', to: '2026-09-30' }, items: [] } as unknown as ExpenseClaimDto;
const routed = { id: 'transport', name: '旅費交通費', route: { required: true, commuterPass: true, fareTable: true } } as unknown as ExpenseCategoryDto;
const plain = { id: 'meal', name: '会議費' } as unknown as ExpenseCategoryDto;

const found: ExpenseFareLookupResultDto = {
  fareType: 'ic', routeCount: 3, maxFare: 220,
  candidates: [{ id: 'r1', stations: ['中野', '新宿'], fareType: 'ic', fare: 200, bidirectional: true }, { id: 'r2', stations: ['中野', '代々木', '新宿'], fareType: 'ic', fare: 220, bidirectional: true }],
  commuterHint: { kind: 'full', passRoute: '中野 > 新宿 > 東京', validTo: '2026-12-31' },
};

interface Options {
  readonly category?: ExpenseCategoryDto | undefined;
  readonly route?: ExpenseReceiptRouteDto;
  readonly transactionDate?: string;
  readonly lookup?: (body: Record<string, unknown>) => unknown;
  readonly claim?: ExpenseClaimDto;
}

function renderFields(options: Options = {}) {
  const request = vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== '/expense/fares/lookup') throw new Error(`unexpected ${path}`);
    return { result: await (options.lookup ?? (() => found))(JSON.parse(String(init?.body)) as Record<string, unknown>) };
  });
  const onChange = vi.fn();
  const onOpen = vi.fn();
  let setRoute: (next: ExpenseReceiptRouteDto | undefined) => void = () => undefined;
  function Harness() {
    const [route, set] = useState(options.route);
    setRoute = set;
    return <RouteFields transport={{ request } as unknown as ApiTransport} scope={scope} onOpen={onOpen} claim={options.claim ?? claim}
      category={'category' in options ? options.category : routed} transportSettings={{ commuterPassDeduction: true, fareToleranceYen: 0, defaultFareType: 'ticket' }}
      transactionDate={options.transactionDate ?? '2026-09-10'} route={route} onChange={(next) => { onChange(next); set(next); }} inputId="expense-item-route" />;
  }
  const view = render(<Harness />);
  return { request, onChange, onOpen, view, setRoute: (next: ExpenseReceiptRouteDto | undefined) => setRoute(next) };
}

const lastCall = (mock: ReturnType<typeof vi.fn>) => mock.mock.calls[mock.mock.calls.length - 1]?.[0] as unknown;

describe('RouteFields', () => {
  it('境界: 費目に route が無い（費目未選択を含む）なら何も描かず、運賃も調べない', () => {
    const { view, request } = renderFields({ category: plain });
    expect(view.container.innerHTML).toBe('');
    cleanup();
    const second = renderFields({ category: undefined });
    expect(second.view.container.innerHTML).toBe('');
    expect(request).not.toHaveBeenCalled();
  });

  it('正常: 出発と到着を入れると区間を返し、少し待ってから申請者・取引日つきで運賃を調べて候補と定期のヒントを出す', async () => {
    const { request, onChange } = renderFields();
    const from = screen.getByLabelText('From');
    expect(from.id).toBe('expense-item-route');
    expect(screen.getByRole('option', { name: 'Policy default (Ticket)' })).toBeTruthy();
    await userEvent.type(from, '中野');
    expect(lastCall(onChange)).toEqual({ stations: ['中野'], trips: 1 });
    expect(screen.getByText('Enter the arrival station to look up the fare.')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('To'), '新宿');
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '新宿'], trips: 1 });
    expect(request).not.toHaveBeenCalled();

    expect(await screen.findByText('Fare table: 2 candidate(s) (IC), highest ¥220 × 1 = ¥220', {}, { timeout: 3000 })).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({ scope, stations: ['中野', '新宿'], date: '2026-09-10', trips: 1, employeeId: 'e1' });
    expect(screen.getByText('中野 > 代々木 > 新宿: ¥220')).toBeTruthy();
    expect(screen.getByText('Within the commuter pass (中野 > 新宿 > 東京, valid to 2026-12-31). This cannot be reimbursed.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('正常: 経由駅の追加・並べ替え・削除、回数、券種を区間に反映し、出発と到着を消すと undefined', async () => {
    const { onChange } = renderFields({ route: { stations: ['中野', '新宿'], trips: 1 }, lookup: () => ({ fareType: 'ticket', candidates: [], routeCount: 0 }) });
    await userEvent.click(screen.getByRole('button', { name: 'Add a via station' }));
    await userEvent.type(screen.getByLabelText('Via 1'), '高円寺');
    await userEvent.click(screen.getByRole('button', { name: 'Add a via station' }));
    await userEvent.type(screen.getByLabelText('Via 2'), '阿佐ケ谷');
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '高円寺', '阿佐ケ谷', '新宿'], trips: 1 });
    expect((screen.getByRole('button', { name: 'Move via 1 earlier' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Move via 2 earlier' }));
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '阿佐ケ谷', '高円寺', '新宿'], trips: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Remove via 1' }));
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '高円寺', '新宿'], trips: 1 });

    const trips = screen.getByLabelText('Trips (1–40)');
    await userEvent.clear(trips);
    await userEvent.type(trips, '2');
    await userEvent.selectOptions(screen.getByLabelText('Fare type'), 'ic');
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '高円寺', '新宿'], trips: 2, fareType: 'ic' });
    expect(screen.getByText('A round trip is 2 trips.')).toBeTruthy();

    await userEvent.clear(screen.getByLabelText('From'));
    await userEvent.clear(screen.getByLabelText('To'));
    expect(lastCall(onChange)).toBeUndefined();
  });

  it('境界: 回数が 0 や 41、数字以外なら案内を出して区間を送らない', async () => {
    const { onChange } = renderFields({ route: { stations: ['中野', '新宿'], trips: 1 }, lookup: () => found });
    const trips = screen.getByLabelText('Trips (1–40)');
    await userEvent.clear(trips);
    const count = onChange.mock.calls.length;
    await userEvent.type(trips, '41');
    expect(screen.getByText('Enter a whole number of trips from 1 to 40.')).toBeTruthy();
    // 「4」は範囲内なので送り、「41」は送らない。
    expect(onChange.mock.calls.length).toBe(count + 1);
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '新宿'], trips: 4 });
    await userEvent.clear(trips);
    await userEvent.type(trips, '0');
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '新宿'], trips: 4 });
    expect(routeOf({ from: 'a', via: [' '], to: 'b', tripsText: 'x', fareType: '' })).toBeNull();
    expect(routeOf({ from: ' ', via: ['x'], to: '', tripsText: '1', fareType: '' })).toBeUndefined();
  });

  it('正常: 運賃マスタが空なら「登録すると照合できます」と運賃マスタを開くボタン。取引日が日付でなければ date を送らない', async () => {
    const bodies: Record<string, unknown>[] = [];
    const noClaimant = { ...claim, claimant: { name: '佐藤' } } as ExpenseClaimDto;
    const { onOpen } = renderFields({ route: { stations: ['中野', '新宿'], trips: 1, fareType: 'ticket' }, transactionDate: '', claim: noClaimant, lookup: (body) => { bodies.push(body); return { fareType: 'ticket', candidates: [], routeCount: 0 }; } });
    expect(await screen.findByText('Register routes in the fare table to check the fare.', {}, { timeout: 3000 })).toBeTruthy();
    expect(bodies[0]).toEqual({ scope, stations: ['中野', '新宿'], fareType: 'ticket', trips: 1 });
    await userEvent.click(screen.getByRole('button', { name: 'Open the fare table' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: '', section: 'fares' });
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('正常: 経路はあるが候補が無いときの案内と、定期の一部重なり（残りの区間・金額の候補）を出す', async () => {
    const { onOpen } = renderFields({
      route: { stations: ['新宿', '渋谷'], trips: 2 },
      lookup: () => ({ fareType: 'ic', candidates: [], routeCount: 5, commuterHint: { kind: 'partial', passRoute: '中野 > 新宿', overlapFrom: '中野', overlapTo: '新宿', restRoute: '新宿 > 渋谷', suggestedAmount: 356 } }),
    });
    expect(await screen.findByText('No route in the fare table matches these stations.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Overlaps the commuter pass \(中野 > 新宿\) between 中野 and 新宿\./).textContent).toContain('Amount candidate: ¥356 (the amount is not changed automatically).');
    expect(screen.getByText(/Remaining section: 新宿 > 渋谷/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Open the fare table' }));
    expect(onOpen).toHaveBeenCalledWith({ internalId: '', section: 'fares' });
  });

  it('境界: 候補 1 件なら一覧を出さず、有効期限の無い定期・残りの区間や金額の無い一部重なりも文が崩れない', async () => {
    renderFields({
      route: { stations: ['中野', '新宿'], trips: 3 },
      lookup: () => ({ fareType: 'ic', candidates: [{ id: 'r1', stations: ['中野', '新宿'], fareType: 'ic', fare: 1000, bidirectional: true }], routeCount: 1, maxFare: 1000, commuterHint: { kind: 'partial', passRoute: 'A > B', overlapFrom: 'A', overlapTo: 'B' } }),
    });
    expect(await screen.findByText('Fare table: 1 candidate(s) (IC), highest ¥1,000 × 3 = ¥3,000', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(screen.getByText('Overlaps the commuter pass (A > B) between A and B.')).toBeTruthy();
    cleanup();
    renderFields({ route: { stations: ['中野', '新宿'], trips: 1 }, lookup: () => ({ fareType: 'ticket', candidates: [{ id: 'r1', stations: ['中野', '新宿'], fareType: 'ticket', fare: 210, bidirectional: true }], routeCount: 1, commuterHint: { kind: 'full', passRoute: 'X > Y' } }) });
    expect(await screen.findByText('Within the commuter pass (X > Y). This cannot be reimbursed.', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText('Fare table: 1 candidate(s) (Ticket), highest — × 1 = —')).toBeTruthy();
  });

  it('異常: 運賃を調べる失敗は小さな注意に留め、フォームは止めない（alert にしない）', async () => {
    const { onChange } = renderFields({ route: { stations: ['中野', '新宿'], trips: 1 }, lookup: () => { throw new Error('lookup is down'); } });
    expect(await screen.findByText('Could not look up the fare (you can keep entering the item): lookup is down', {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    await userEvent.type(screen.getByLabelText('To'), '三丁目');
    expect(lastCall(onChange)).toEqual({ stations: ['中野', '新宿三丁目'], trips: 1 });
  });

  it('正常: 親が別の区間に差し替えたら入力欄も差し替える（読取の反映・別の明細）', async () => {
    const { setRoute } = renderFields({ route: { stations: ['中野', '新宿'], trips: 1 }, lookup: () => found });
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('中野');
    setRoute({ stations: ['東京', '神田', '秋葉原'], trips: 2, fareType: 'ic' });
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('東京'));
    expect((screen.getByLabelText('Via 1') as HTMLInputElement).value).toBe('神田');
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('秋葉原');
    expect((screen.getByLabelText('Trips (1–40)') as HTMLInputElement).value).toBe('2');
    setRoute(undefined);
    await waitFor(() => expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe(''));
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('');
  });
});
