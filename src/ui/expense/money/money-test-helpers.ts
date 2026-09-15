/**
 * 系統 B の部品テストの共有物: `transport.request` だけの偽物（メソッド + パスの型で振り分ける）と、スロットの props の既定値。
 * テストファイルからだけ import する。
 */
import { vi } from 'vitest';
import type { ApiTransport } from '../../api/business-api';
import type { ExpenseBlockingReasonDto } from '../../api/expense-types';
import { ApiError } from '../../api/tool-api';
import type { TenantScopeDto } from '../../api/types';
import type { ExpenseLedgerSlotProps } from '../expense-slots';

export const testScope: TenantScopeDto = { tenantId: 'tenant-a', workspaceId: 'ws-a' };

export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly params: readonly string[];
  readonly query: URLSearchParams;
  readonly body: Record<string, unknown>;
}

export type FakeHandler = (request: FakeRequest) => unknown;

export interface FakeTransport extends ApiTransport {
  readonly calls: FakeRequest[];
  callsTo(method: string, path: string): FakeRequest[];
}

/** 'GET /expense/advances/:id' の形の鍵で振り分ける。handler が投げた例外はそのまま失敗になる。 */
export function fakeTransport(routes: Readonly<Record<string, FakeHandler>>): FakeTransport {
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method = 'GET', pattern = ''] = key.split(' ');
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/:[A-Za-z]+/gu, '([^/]+)');
    return { method, regex: new RegExp(`^${source}$`, 'u'), handler };
  });
  const calls: FakeRequest[] = [];
  const request = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const [pathname = '', search = ''] = url.split('?');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    for (const route of compiled) {
      if (route.method !== method) continue;
      const match = route.regex.exec(pathname);
      if (match === null) continue;
      const entry: FakeRequest = { method, path: pathname, params: match.slice(1).map((value) => decodeURIComponent(value)), query: new URLSearchParams(search), body };
      calls.push(entry);
      return route.handler(entry);
    }
    throw new Error(`no fake route for ${method} ${pathname}`);
  });
  return {
    request: request as unknown as ApiTransport['request'],
    calls,
    callsTo: (method, path) => calls.filter((call) => call.method === method && call.path === path),
  };
}

export function transitionError(nextStep: string, blockingReasons: readonly ExpenseBlockingReasonDto[] = []): ApiError {
  return new ApiError(409, 'EXPENSE_TRANSITION', 'transition rejected', undefined, { details: { nextStep, blockingReasons } });
}

export function ledgerProps(transport: ApiTransport, overrides: Partial<ExpenseLedgerSlotProps> = {}): ExpenseLedgerSlotProps {
  return {
    transport, scope: testScope, onOpen: vi.fn(), policy: undefined, claims: [], chart: undefined, capabilities: undefined,
    onClaimsChanged: vi.fn().mockResolvedValue(undefined), onReloadPolicy: vi.fn().mockResolvedValue(undefined), onTab: vi.fn(), focus: undefined,
    ...overrides,
  };
}
