// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExpenseFareTableDto } from '../../api/expense-input-types';
import { ApiError } from '../../api/tool-api';
import { NavigationProvider } from '../../navigation';
import { scope } from '../../scope';
import type { ExpenseFocusRequest } from '../expense-shared';
import { FaresLedger, splitAliases, splitStations } from './FaresLedger';

const download = vi.hoisted(() => ({ result: true, calls: [] as (readonly [string, string])[] }));
vi.mock('../../journal/journal-model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../journal/journal-model')>()),
  triggerDownload: (fileName: string, content: string) => { download.calls.push([fileName, content]); return download.result; },
}));

afterEach(() => { cleanup(); download.result = true; download.calls = []; });

const table: ExpenseFareTableDto = {
  routes: [{ id: 'r1', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ic', fare: 199, bidirectional: true, validFrom: '2026-04-01', note: '本社' }],
  stationAliases: [{ name: '霞ケ関', aliases: ['霞が関', '霞ヶ関'] }],
  updatedAt: '2026-09-01T00:00:00.000Z',
};
const emptyTable: ExpenseFareTableDto = { routes: [], stationAliases: [], updatedAt: '2026-09-01T00:00:00.000Z' };

type Handler = (path: string, init: RequestInit | undefined) => unknown;

function renderLedger(handler: Handler, focus?: ExpenseFocusRequest) {
  const request = vi.fn(async (path: string, init?: RequestInit) => handler(path, init));
  const transport = { request } as unknown as ApiTransport;
  const onReloadPolicy = vi.fn().mockResolvedValue(undefined);
  render(<NavigationProvider navigate={vi.fn()}>
    <FaresLedger transport={transport} scope={scope} onOpen={vi.fn()} policy={undefined} claims={[]} chart={undefined} capabilities={undefined}
      onClaimsChanged={vi.fn()} onReloadPolicy={onReloadPolicy} onTab={vi.fn()} focus={focus} />
  </NavigationProvider>);
  return { request, onReloadPolicy };
}

const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>;
const csvFile = (content: string, name = 'fares.csv') => {
  const file = new File([content], name, { type: 'text/csv' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return file;
};

describe('FaresLedger', () => {
  it('正常: 読み込んだ経路を「 > 」区切りで出し、運賃を直して行を足して保存すると本文に載る（規程の読み直しはしない）', async () => {
    const { request, onReloadPolicy } = renderLedger((path, init) => {
      if (path.startsWith('/expense/fares?')) return { table, saved: true };
      if (path === '/expense/fares' && init?.method === 'PUT') return { table: { ...table, routes: (bodyOf(init)['routes'] as ExpenseFareTableDto['routes']), updatedAt: 'y' } };
      throw new Error(`unexpected ${path}`);
    });
    const stations = await screen.findByLabelText('Stations of route 1');
    expect((stations as HTMLInputElement).value).toBe('中野 > 新宿 > 霞ケ関');
    expect(screen.getByText(/cannot be detected/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    const fare = screen.getByLabelText('Fare of 中野 > 新宿 > 霞ケ関');
    await userEvent.clear(fare);
    await userEvent.type(fare, '1,200');
    await userEvent.selectOptions(screen.getByLabelText('Fare type of 中野 > 新宿 > 霞ケ関'), 'ticket');
    await userEvent.click(screen.getByLabelText('中野 > 新宿 > 霞ケ関 both ways'));
    await userEvent.clear(screen.getByLabelText('Note of 中野 > 新宿 > 霞ケ関'));
    expect(screen.getByText('You have unsaved changes to the fare table.')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Add a route' }));
    expect(screen.getByText('Enter at least 2 stations separated by " > ".')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('Stations of route 2'), '新宿 > 東京');
    await userEvent.type(screen.getByLabelText('Fare of 新宿 > 東京'), '210');
    await userEvent.type(screen.getByLabelText('Valid to of 新宿 > 東京'), '2027-03-31');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved the fare table. Check the claims again to apply it.');
    const put = request.mock.calls.find(([path, init]) => path === '/expense/fares' && init?.method === 'PUT');
    expect(bodyOf(put?.[1])).toEqual({
      scope,
      routes: [
        { id: 'r1', stations: ['中野', '新宿', '霞ケ関'], fareType: 'ticket', fare: 1200, bidirectional: false, validFrom: '2026-04-01' },
        { id: 'route-2', stations: ['新宿', '東京'], fareType: 'ic', fare: 210, bidirectional: true, validTo: '2027-03-31' },
      ],
      stationAliases: [{ name: '霞ケ関', aliases: ['霞が関', '霞ヶ関'] }],
    });
    expect(onReloadPolicy).not.toHaveBeenCalled();
    expect(screen.queryByText('You have unsaved changes to the fare table.')).toBeNull();
  });

  it('境界: 経路も別名も無ければ空状態の案内で、赤くしない（alert にしない）', async () => {
    renderLedger(() => ({ table: emptyTable, saved: false }));
    expect(await screen.findByText('No routes yet. Register the routes you often use to check transport fares.')).toBeTruthy();
    expect(screen.getByText('No station aliases.')).toBeTruthy();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('正常: 別名を足して編集・削除し、カンマ区切りを配列にして送る。経路の削除も本文に反映する', async () => {
    const { request } = renderLedger((path, init) => (init?.method === 'PUT' ? { table: emptyTable } : { table, saved: true }));
    await screen.findByLabelText('Stations of route 1');
    await userEvent.click(screen.getByRole('button', { name: 'Remove 中野 > 新宿 > 霞ケ関' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add an alias' }));
    await userEvent.type(screen.getByLabelText('Representative name 2'), '新宿');
    await userEvent.type(screen.getByLabelText('Aliases 2'), 'しんじゅく、Shinjuku ,');
    await userEvent.click(screen.getByRole('button', { name: 'Add an alias' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove alias 1' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(request.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
    const put = request.mock.calls.find(([, init]) => init?.method === 'PUT');
    // 空の行（代表名も別名も空）は送らない。
    expect(bodyOf(put?.[1])).toEqual({ scope, routes: [], stationAliases: [{ name: '新宿', aliases: ['しんじゅく', 'Shinjuku'] }] });
    expect(await screen.findByText('No routes yet. Register the routes you often use to check transport fares.')).toBeTruthy();
  });

  it('異常: 保存が 400 EXPENSE_DOMAIN なら、サーバーの文言を alert で出して編集中の値を残す', async () => {
    renderLedger((path, init) => {
      if (init?.method === 'PUT') throw new ApiError(400, 'EXPENSE_DOMAIN', 'fare must be 1..100000');
      return { table, saved: true };
    });
    const fare = await screen.findByLabelText('Fare of 中野 > 新宿 > 霞ケ関');
    await userEvent.clear(fare);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Please check the expense input');
    expect((screen.getByLabelText('Fare of 中野 > 新宿 > 霞ケ関') as HTMLInputElement).value).toBe('');
  });

  it('正常: CSV 取込は文字コードを判定して本文に載せ、表を置き換える', async () => {
    const imported: ExpenseFareTableDto = { ...table, routes: [{ id: 'r9', stations: ['渋谷', '表参道'], fareType: 'ic', fare: 178, bidirectional: true }] };
    const { request } = renderLedger((path) => (path === '/expense/fares/import' ? { table: imported } : { table, saved: true }));
    await screen.findByLabelText('Stations of route 1');
    const content = 'id,stations,fare_type,fare,bidirectional\r\nr9,渋谷 > 表参道,ic,178,true';
    await userEvent.upload(screen.getByLabelText('Import fares CSV'), csvFile(content));
    await screen.findByText('Imported the routes from "fares.csv". Station aliases were kept.');
    expect(bodyOf(request.mock.calls.find(([path]) => path === '/expense/fares/import')?.[1])).toEqual({ scope, content });
    expect((screen.getByLabelText('Stations of route 1') as HTMLInputElement).value).toBe('渋谷 > 表参道');
  });

  it('異常: CSV 取込が 400 EXPENSE_CSV_IMPORT なら、行番号を見せて直す行を案内する', async () => {
    renderLedger((path) => {
      if (path === '/expense/fares/import') throw new ApiError(400, 'EXPENSE_CSV_IMPORT', 'bad fare', undefined, { row: 3 });
      return { table, saved: true };
    });
    await screen.findByLabelText('Stations of route 1');
    await userEvent.upload(screen.getByLabelText('Import fares CSV'), csvFile('x'));
    expect(await screen.findByText('Fix row 3 of the CSV and import it again.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Row 3');
  });

  it('異常: 行番号が details.row にしか無くても拾い、行番号の無い失敗では行の案内を出さない', async () => {
    let calls = 0;
    renderLedger((path) => {
      if (path !== '/expense/fares/import') return { table, saved: true };
      calls += 1;
      if (calls === 1) throw new ApiError(400, 'EXPENSE_CSV_IMPORT', 'bad', undefined, { details: { row: 7 } });
      throw new Error('network down');
    });
    await screen.findByLabelText('Stations of route 1');
    await userEvent.upload(screen.getByLabelText('Import fares CSV'), csvFile('x'));
    expect(await screen.findByText('Fix row 7 of the CSV and import it again.')).toBeTruthy();
    await userEvent.upload(screen.getByLabelText('Import fares CSV'), csvFile('y'));
    expect(await screen.findByText('network down')).toBeTruthy();
    expect(screen.queryByText(/Fix row/)).toBeNull();
  });

  it('正常: CSV 出力はダウンロードし、始められなければ中身をテキストで見せる。出力の失敗は alert', async () => {
    let fail = false;
    renderLedger((path) => {
      if (path.startsWith('/expense/fares/export?')) { if (fail) throw new Error('export failed'); return { content: 'id,stations\r\nr1,中野 > 新宿', fileName: 'fares.csv' }; }
      return { table, saved: true };
    });
    await screen.findByLabelText('Stations of route 1');
    await userEvent.click(screen.getByRole('button', { name: 'Export fares CSV' }));
    await waitFor(() => expect(download.calls).toEqual([['fares.csv', 'id,stations\r\nr1,中野 > 新宿']]));
    expect(screen.queryByLabelText('Fares CSV')).toBeNull();

    download.result = false;
    await userEvent.click(screen.getByRole('button', { name: 'Export fares CSV' }));
    // textarea の値は改行が LF に正規化される。
    expect(((await screen.findByLabelText('Fares CSV')) as HTMLTextAreaElement).value).toBe('id,stations\nr1,中野 > 新宿');

    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Export fares CSV' }));
    expect((await screen.findByRole('alert')).textContent).toContain('export failed');
  });

  it('異常: 読み込みに失敗したら原因と「再試行」を出し、再試行で読める', async () => {
    let calls = 0;
    renderLedger(() => { calls += 1; if (calls === 1) throw new Error('server down'); return { table, saved: true }; });
    expect(await screen.findByText('Could not load the fare table')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByLabelText('Stations of route 1')).toBeTruthy();
    expect(screen.queryByText('Could not load the fare table')).toBeNull();
  });

  it('正常: 導線 fares で開かれたら見出しへフォーカスする。別の section では動かない', async () => {
    renderLedger(() => ({ table, saved: true }), { tab: 'fares', section: 'fares', id: '', seq: 1 } as ExpenseFocusRequest);
    await screen.findByLabelText('Stations of route 1');
    await waitFor(() => expect(document.activeElement?.id).toBe('expense-ledger-faresledger-heading'));
    cleanup();
    renderLedger(() => ({ table, saved: true }), { tab: 'fares', section: 'employee', id: '', seq: 2 } as unknown as ExpenseFocusRequest);
    await screen.findByLabelText('Stations of route 1');
    expect(document.activeElement?.id).not.toBe('expense-ledger-faresledger-heading');
  });

  it('境界: 駅の並びと別名の分割は空の要素を捨てる', () => {
    expect(splitStations(' 中野 >> 新宿 > ')).toEqual(['中野', '新宿']);
    expect(splitAliases('霞が関, 霞ヶ関，、 ')).toEqual(['霞が関', '霞ヶ関']);
  });
});
