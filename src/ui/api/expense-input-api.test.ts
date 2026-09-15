import { describe, expect, it, vi } from 'vitest';
import type { ApiTransport } from './business-api';
import { expenseInputApi, fareTableConfigured } from './expense-input-api';

const scope = { tenantId: 't', workspaceId: 'w' };
const table = { routes: [{ id: 'r1', stations: ['A', 'B'], fareType: 'ic' as const, fare: 100, bidirectional: true }], stationAliases: [], updatedAt: 'x' };

function fakeTransport(responses: Record<string, unknown>) {
  const request = vi.fn(async (path: string, _init?: RequestInit) => {
    const key = Object.keys(responses).find((prefix) => path.startsWith(prefix));
    return key === undefined ? {} : responses[key];
  });
  return { transport: { request } as unknown as ApiTransport, request };
}

describe('expenseInputApi', () => {
  it('正常: 運賃マスタの取得・保存・CSV・照合・準備状況のパスと本文と包みの外し方', async () => {
    const { transport, request } = fakeTransport({
      '/expense/fares/export': { content: 'csv', fileName: 'f.csv' },
      '/expense/fares/import': { table },
      '/expense/fares/lookup': { result: { fareType: 'ic', candidates: [], routeCount: 0 } },
      '/expense/fares': { table, saved: true },
    });
    const api = expenseInputApi(transport);
    expect(await api.getFares(scope)).toEqual({ table, saved: true });
    expect(request).toHaveBeenLastCalledWith('/expense/fares?tenantId=t&workspaceId=w');
    expect(await api.saveFares(scope, { routes: table.routes, stationAliases: [] })).toEqual(table);
    expect(request.mock.lastCall?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ scope, routes: table.routes, stationAliases: [] }) });
    expect(await api.exportFaresCsv(scope)).toEqual({ content: 'csv', fileName: 'f.csv' });
    expect(await api.importFaresCsv(scope, 'x')).toEqual(table);
    const controller = new AbortController();
    expect(await api.lookupFare(scope, { stations: ['A', 'B'] }, controller.signal)).toEqual({ fareType: 'ic', candidates: [], routeCount: 0 });
    expect(request.mock.lastCall?.[1]).toMatchObject({ method: 'POST', signal: controller.signal });
    expect(await api.lookupFare(scope, { stations: ['A', 'B'] })).toMatchObject({ routeCount: 0 });
    expect(request.mock.lastCall?.[1]).not.toHaveProperty('signal');
    expect(await api.fareReadiness(scope)).toBe(true);
  });

  it('正常: 追加読取とヒアリングのパス（id の符号化・状態の絞り込み・取消）', async () => {
    const hearing = { id: 'h/1', status: 'open' };
    const { transport, request } = fakeTransport({
      '/expense/receipts/extract-detail': { result: { draft: {}, disagreements: [], warnings: [] } },
      '/expense/policy-hearings/h%2F1/diff': { changes: [], basePolicyUpdatedAt: 'b', stale: false },
      '/expense/policy-hearings/h%2F1/accept': { hearing, policy: {} },
      '/expense/policy-hearings/h%2F1': { hearing },
      '/expense/policy-hearings?': { hearings: [hearing] },
      '/expense/policy-hearings': { hearing },
    });
    const api = expenseInputApi(transport);
    expect(await api.extractDetail(scope, { images: ['i'], draft: { facts: {}, source: { type: 'image' }, extraction: { method: 'llm', warnings: [] } } })).toMatchObject({ warnings: [] });
    expect(await api.startHearing(scope, { mode: 'questions' })).toEqual(hearing);
    expect(await api.listHearings(scope)).toEqual([hearing]);
    expect(request).toHaveBeenLastCalledWith('/expense/policy-hearings?tenantId=t&workspaceId=w');
    await api.listHearings(scope, 'proposed');
    expect(request).toHaveBeenLastCalledWith('/expense/policy-hearings?tenantId=t&workspaceId=w&status=proposed');
    expect(await api.getHearing(scope, 'h/1')).toEqual(hearing);
    expect(await api.answerHearing(scope, 'h/1', [{ questionId: 'q', value: 1 }])).toEqual(hearing);
    expect(request.mock.lastCall?.[0]).toBe('/expense/policy-hearings/h%2F1/answers');
    expect(await api.diffHearing(scope, 'h/1')).toMatchObject({ basePolicyUpdatedAt: 'b' });
    expect(await api.acceptHearing(scope, 'h/1', ['c'], 'b')).toEqual({ hearing, policy: {} });
    expect(request.mock.lastCall?.[1]).toMatchObject({ body: JSON.stringify({ scope, changeIds: ['c'], basePolicyUpdatedAt: 'b' }) });
    expect(await api.cancelHearing(scope, 'h/1')).toEqual(hearing);
    expect(request.mock.lastCall?.[0]).toBe('/expense/policy-hearings/h%2F1/cancel');
  });

  it('境界: 運賃マスタは保存済みで経路が 1 件以上のときだけ準備済み', () => {
    expect(fareTableConfigured({ table, saved: false })).toBe(false);
    expect(fareTableConfigured({ table: { ...table, routes: [] }, saved: true })).toBe(false);
    expect(fareTableConfigured({ table, saved: true })).toBe(true);
  });
});
